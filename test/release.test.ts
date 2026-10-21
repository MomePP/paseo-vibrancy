import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  cachedPristine,
  checkLatest,
  downloadVerified,
  fetchRelease,
  parseMacYml,
  pickLatest,
  releaseFromWindowsAsset,
  sweepOlderPristine,
  verifyPaseoSignature,
  windowsZipName,
  type GithubRelease,
} from "../server/release.ts";
import type { Release } from "../shared/rpc.ts";
import { compareVersions } from "../shared/version.ts";

const execFileAsync = promisify(execFile);
const fixtureYml = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url).href), "fixtures", "beta3-mac.yml"),
  "utf8",
);

const onMac = { skip: process.platform !== "darwin" ? "macOS only (ditto, codesign)" : false };
const onWindows = { skip: process.platform !== "win32" ? "Windows only (tar.exe)" : false };

const WINDOWS_DIGEST = "ebf5a5392022dd1183824db764499edb263bb6064209145b642c71b82bd25c25";

/** Zips `srcDir`'s contents the way the host's own release zips are read back: `ditto` on macOS, bsdtar on Windows. */
async function zipDir(srcDir: string, zipPath: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-cf", zipPath, "-C", srcDir, "."]);
  } else {
    await execFileAsync("ditto", ["-c", "-k", "--sequesterRsrc", srcDir, zipPath]);
  }
}

/** Serves `handler` on 127.0.0.1 for the test's lifetime and returns its base URL. */
async function serve(t: { after: (fn: () => void) => void }, handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
  return `http://127.0.0.1:${address.port}`;
}

test("compareVersions orders numeric prerelease parts and release over prerelease", () => {
  assert.ok(compareVersions("0.11.0-beta.3", "0.11.0-beta.10") < 0);
  assert.ok(compareVersions("0.11.0-beta.10", "0.11.0") < 0);
  assert.ok(compareVersions("0.11.0-beta.3", "0.11.0") < 0);
  assert.equal(compareVersions("0.11.0", "0.11.0"), 0);
});

test("pickLatest skips drafts and picks the highest version including prereleases", () => {
  const releases: GithubRelease[] = [
    { tag_name: "v0.11.0-beta.4", draft: true, prerelease: true },
    { tag_name: "v0.11.0-beta.3", draft: false, prerelease: true },
    { tag_name: "v0.10.2", draft: false, prerelease: false },
  ];
  assert.equal(pickLatest(releases)?.tag_name, "v0.11.0-beta.3");
});

test("pickLatest with only a draft returns null", () => {
  assert.equal(pickLatest([{ tag_name: "v0.11.0-beta.4", draft: true, prerelease: true }]), null);
});

test("parseMacYml finds the arm64 zip entry's size and sha512, as hex", () => {
  const release = parseMacYml(
    fixtureYml,
    "0.11.0-beta.3",
    "https://github.com/getpaseo/paseo/releases/download/v0.11.0-beta.3/Paseo-0.11.0-beta.3-arm64.zip",
  );
  assert.ok(release.zipUrl.endsWith("Paseo-0.11.0-beta.3-arm64.zip"));
  assert.equal(release.size, 179110962);
  assert.equal(release.algorithm, "sha512");
  assert.equal(
    release.digest,
    "8d8c282d35034a27d488d70cb6ec87e726bedb909aae3ce1caedf191d72dd75b4564d77bf8189a6e2ec3e5b78a5c4c6504d1897b3c42ec56b80d95988b141f21",
  );
});

test("windowsZipName picks the arm64 zip on arm64 and the x64 zip on anything else", () => {
  assert.equal(windowsZipName("0.12.0", "arm64"), "Paseo-Setup-0.12.0-arm64.zip");
  assert.equal(windowsZipName("0.12.0", "x64"), "Paseo-Setup-0.12.0-x64.zip");
  assert.equal(windowsZipName("0.12.0", "ia32"), "Paseo-Setup-0.12.0-x64.zip");
});

test("releaseFromWindowsAsset takes GitHub's sha256 digest and refuses an asset without one", () => {
  const asset = {
    name: "Paseo-Setup-0.12.0-x64.zip",
    browser_download_url: "http://ignored/zip",
    size: 194055050,
    digest: `sha256:${WINDOWS_DIGEST}`,
  };
  assert.deepEqual(releaseFromWindowsAsset("0.12.0", asset), {
    version: "0.12.0",
    zipUrl: "http://ignored/zip",
    size: 194055050,
    algorithm: "sha256",
    digest: WINDOWS_DIGEST,
  });
  assert.throws(() => releaseFromWindowsAsset("0.12.0", { ...asset, digest: null }), /no sha256 digest/);
  assert.throws(() => releaseFromWindowsAsset("0.12.0", { ...asset, digest: `sha512:${WINDOWS_DIGEST}` }), /no sha256 digest/);
});

test("checkLatest returns an error result on network failure, never throws", async () => {
  const result = await checkLatest({
    fetch: (() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as typeof fetch,
  });
  assert.equal(result.release, null);
  assert.match(result.error ?? "", /ENOTFOUND/);
});

test("checkLatest resolves a macOS release through the beta-mac.yml asset", async (t) => {
  const base = await serve(t, (req, res) => {
    if (req.url === "/releases?per_page=20") {
      const body: GithubRelease[] = [
        {
          tag_name: "v0.11.0-beta.3",
          draft: false,
          prerelease: true,
          assets: [
            { name: "beta-mac.yml", browser_download_url: "http://ignored/beta-mac.yml" },
            { name: "Paseo-0.11.0-beta.3-arm64.zip", browser_download_url: "http://ignored/zip" },
          ],
        },
      ];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://ignored/beta-mac.yml") {
      return new Response(fixtureYml, { status: 200 });
    }
    return fetch(url, init);
  }) as typeof fetch;

  const result = await checkLatest({ fetch: fakeFetch, apiUrl: `${base}/releases`, platform: "darwin" });
  assert.equal(result.error, null);
  assert.equal(result.release?.version, "0.11.0-beta.3");
  assert.equal(result.release?.zipUrl, "http://ignored/zip");
  assert.equal(result.release?.size, 179110962);
});

test("checkLatest resolves a Windows release to this CPU's zip and its GitHub digest, no yml", async (t) => {
  const base = await serve(t, (req, res) => {
    if (req.url === "/releases?per_page=20") {
      const body: GithubRelease[] = [
        {
          tag_name: "v0.12.0",
          draft: false,
          prerelease: false,
          assets: [
            { name: "latest.yml", browser_download_url: "http://ignored/latest.yml" },
            {
              name: "Paseo-Setup-0.12.0-arm64.zip",
              browser_download_url: "http://ignored/arm64.zip",
              size: 1,
              digest: `sha256:${"0".repeat(64)}`,
            },
            {
              name: "Paseo-Setup-0.12.0-x64.zip",
              browser_download_url: "http://ignored/x64.zip",
              size: 194055050,
              digest: `sha256:${WINDOWS_DIGEST}`,
            },
          ],
        },
      ];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const result = await checkLatest({ apiUrl: `${base}/releases`, platform: "win32", arch: "x64" });
  assert.equal(result.error, null);
  assert.deepEqual(result.release, {
    version: "0.12.0",
    zipUrl: "http://ignored/x64.zip",
    size: 194055050,
    algorithm: "sha256",
    digest: WINDOWS_DIGEST,
  });
});

test("fetchRelease fetches a single tagged release by version", async (t) => {
  const base = await serve(t, (req, res) => {
    if (req.url === "/releases/tags/v0.11.0-beta.3") {
      const body: GithubRelease = {
        tag_name: "v0.11.0-beta.3",
        draft: false,
        prerelease: true,
        assets: [
          { name: "latest-mac.yml", browser_download_url: "http://ignored/latest-mac.yml" },
          { name: "Paseo-0.11.0-beta.3-arm64.zip", browser_download_url: "http://ignored/zip" },
        ],
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://ignored/latest-mac.yml") {
      return new Response(fixtureYml, { status: 200 });
    }
    return fetch(url, init);
  }) as typeof fetch;

  const release = await fetchRelease("0.11.0-beta.3", { fetch: fakeFetch, apiUrl: `${base}/releases`, platform: "darwin" });
  assert.equal(release.version, "0.11.0-beta.3");
  assert.equal(release.zipUrl, "http://ignored/zip");
});

test("verifyPaseoSignature rejects a non-Paseo (Apple-signed) app", onMac, async () => {
  await assert.rejects(() => verifyPaseoSignature("/System/Applications/Calculator.app"));
});

test("downloadVerified rejects a digest mismatch and leaves the cache dir empty", async (t) => {
  const srcDir = mkdtempSync(join(tmpdir(), "vibrancy-release-src-"));
  t.after(() => rmSync(srcDir, { recursive: true, force: true }));
  writeFileSync(join(srcDir, "marker.txt"), "not a real app, just zip payload\n");

  const zipDirPath = mkdtempSync(join(tmpdir(), "vibrancy-release-zip-"));
  t.after(() => rmSync(zipDirPath, { recursive: true, force: true }));
  const zipPath = join(zipDirPath, "Paseo.zip");
  await zipDir(srcDir, zipPath);
  const zipBytes = readFileSync(zipPath);

  const base = await serve(t, (_req, res) => {
    res.setHeader("content-type", "application/zip");
    res.end(zipBytes);
  });

  const cacheDir = mkdtempSync(join(tmpdir(), "vibrancy-release-cache-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

  const release: Release = {
    version: "0.11.0-beta.3",
    zipUrl: `${base}/Paseo.zip`,
    size: zipBytes.length,
    algorithm: "sha512",
    digest: "0".repeat(128),
  };

  await assert.rejects(() => downloadVerified(release, cacheDir), /sha512 mismatch/);
  assert.deepEqual(readdirSync(cacheDir), []);
});

test("downloadVerified reports the byte fraction while downloading, then extract and verify", onMac, async (t) => {
  const srcDir = mkdtempSync(join(tmpdir(), "vibrancy-release-src-"));
  t.after(() => rmSync(srcDir, { recursive: true, force: true }));
  mkdirSync(join(srcDir, "Fake.app"));
  writeFileSync(join(srcDir, "Fake.app", "payload.bin"), randomBytes(3_000_000));

  const zipDirPath = mkdtempSync(join(tmpdir(), "vibrancy-release-zip-"));
  t.after(() => rmSync(zipDirPath, { recursive: true, force: true }));
  const zipPath = join(zipDirPath, "Paseo-0.11.0-beta.3-arm64.zip");
  await zipDir(srcDir, zipPath);
  const zipBytes = readFileSync(zipPath);

  const base = await serve(t, (_req, res) => {
    res.setHeader("content-type", "application/zip");
    res.end(zipBytes);
  });

  const cacheDir = mkdtempSync(join(tmpdir(), "vibrancy-release-cache-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

  const release: Release = {
    version: "0.11.0-beta.3",
    zipUrl: `${base}/Paseo-0.11.0-beta.3-arm64.zip`,
    size: zipBytes.length,
    algorithm: "sha512",
    digest: createHash("sha512").update(zipBytes).digest("hex"),
  };

  const events: Array<{ step: string; fraction: number; detail: string | null }> = [];
  // The fake app is unsigned, so the run ends at the signature check.
  await assert.rejects(() =>
    downloadVerified(release, cacheDir, (step, fraction, detail) => events.push({ step, fraction, detail })),
  );

  const steps = events.map((e) => e.step).filter((step, i, all) => step !== all[i - 1]);
  assert.deepEqual(steps, ["download", "extract", "verify"]);
  const downloads = events.filter((e) => e.step === "download");
  assert.ok(downloads.length > 2);
  assert.deepEqual(downloads[0], { step: "download", fraction: 0, detail: "0 / 3 MB" });
  assert.deepEqual(downloads.at(-1), { step: "download", fraction: 1, detail: "3 / 3 MB" });
  for (let i = 1; i < downloads.length; i++) {
    assert.ok(downloads[i].fraction >= downloads[i - 1].fraction);
  }
});

test("downloadVerified on Windows checks the sha256, extracts the install itself into the cache, no verify step", onWindows, async (t) => {
  const srcDir = mkdtempSync(join(tmpdir(), "vibrancy-release-src-"));
  t.after(() => rmSync(srcDir, { recursive: true, force: true }));
  writeFileSync(join(srcDir, "Paseo.exe"), randomBytes(3_000_000));
  mkdirSync(join(srcDir, "resources"));
  writeFileSync(join(srcDir, "resources", "app.asar"), "asar");

  const zipDirPath = mkdtempSync(join(tmpdir(), "vibrancy-release-zip-"));
  t.after(() => rmSync(zipDirPath, { recursive: true, force: true }));
  const zipPath = join(zipDirPath, "Paseo-Setup-0.12.0-x64.zip");
  await zipDir(srcDir, zipPath);
  const zipBytes = readFileSync(zipPath);

  const base = await serve(t, (_req, res) => {
    res.setHeader("content-type", "application/zip");
    res.end(zipBytes);
  });

  const cacheDir = mkdtempSync(join(tmpdir(), "vibrancy-release-cache-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  mkdirSync(join(cacheDir, "Paseo-0.11.0"));

  const release: Release = {
    version: "0.12.0",
    zipUrl: `${base}/Paseo-Setup-0.12.0-x64.zip`,
    size: zipBytes.length,
    algorithm: "sha256",
    digest: createHash("sha256").update(zipBytes).digest("hex"),
  };

  const steps: string[] = [];
  const path = await downloadVerified(release, cacheDir, (step) => {
    if (steps.at(-1) !== step) steps.push(step);
  });

  assert.equal(path, join(cacheDir, "Paseo-0.12.0"));
  assert.deepEqual(steps, ["download", "extract"]);
  assert.equal(readFileSync(join(path, "resources", "app.asar"), "utf8"), "asar");
  assert.deepEqual(readdirSync(cacheDir), ["Paseo-0.12.0"]);
});

test("downloadVerified on Windows rejects a zip that is not a Paseo install", onWindows, async (t) => {
  const srcDir = mkdtempSync(join(tmpdir(), "vibrancy-release-src-"));
  t.after(() => rmSync(srcDir, { recursive: true, force: true }));
  writeFileSync(join(srcDir, "Paseo.exe"), "exe without resources");

  const zipDirPath = mkdtempSync(join(tmpdir(), "vibrancy-release-zip-"));
  t.after(() => rmSync(zipDirPath, { recursive: true, force: true }));
  const zipPath = join(zipDirPath, "x.zip");
  await zipDir(srcDir, zipPath);
  const zipBytes = readFileSync(zipPath);

  const base = await serve(t, (_req, res) => res.end(zipBytes));
  const cacheDir = mkdtempSync(join(tmpdir(), "vibrancy-release-cache-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

  const release: Release = {
    version: "0.12.0",
    zipUrl: `${base}/x.zip`,
    size: zipBytes.length,
    algorithm: "sha256",
    digest: createHash("sha256").update(zipBytes).digest("hex"),
  };

  await assert.rejects(() => downloadVerified(release, cacheDir), /no Paseo\.exe and resources\/app\.asar/);
  assert.deepEqual(readdirSync(cacheDir), []);
});

test("sweepOlderPristine removes only strictly-older Paseo-*.app entries (macOS)", async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "vibrancy-release-sweep-cache-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

  for (const name of ["Paseo-0.11.0-beta.5.app", "Paseo-0.11.0-beta.1.app", "Paseo-0.11.0-beta.3.app"]) {
    const dir = join(cacheDir, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "marker"), name);
  }
  // Unparseable "version" and a non-matching filename must both survive untouched.
  mkdirSync(join(cacheDir, "Paseo-not-a-version.app"));
  writeFileSync(join(cacheDir, "not-a-paseo-app.txt"), "leave me alone");

  await sweepOlderPristine(cacheDir, "0.11.0-beta.3", "darwin");

  assert.deepEqual(readdirSync(cacheDir).sort(), [
    "Paseo-0.11.0-beta.3.app",
    "Paseo-0.11.0-beta.5.app",
    "Paseo-not-a-version.app",
    "not-a-paseo-app.txt",
  ]);
});

test("sweepOlderPristine removes only strictly-older Paseo-<version> folders (Windows)", async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "vibrancy-release-sweep-cache-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

  for (const name of ["Paseo-0.12.1", "Paseo-0.11.0", "Paseo-0.12.0", "Paseo-not-a-version"]) {
    mkdirSync(join(cacheDir, name));
  }
  writeFileSync(join(cacheDir, "not-a-paseo-app.txt"), "leave me alone");

  await sweepOlderPristine(cacheDir, "0.12.0", "win32");

  assert.deepEqual(readdirSync(cacheDir).sort(), ["Paseo-0.12.0", "Paseo-0.12.1", "Paseo-not-a-version", "not-a-paseo-app.txt"]);
});

test("cachedPristine returns null when no pristine copy exists and the path once one does", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "vibrancy-release-cached-"));
  try {
    assert.equal(cachedPristine("0.11.0-beta.3", cacheDir, "darwin"), null);
    writeFileSync(join(cacheDir, "not-an-app"), "x");
    const appDir = join(cacheDir, "Paseo-0.11.0-beta.3.app");
    writeFileSync(join(cacheDir, "Paseo-0.11.0-beta.3.app-marker"), "x");
    // cachedPristine only checks existence of the exact app path.
    assert.equal(cachedPristine("0.11.0-beta.3", cacheDir, "darwin"), null);
    writeFileSync(appDir, "pretend-app");
    assert.equal(cachedPristine("0.11.0-beta.3", cacheDir, "darwin"), appDir);

    const installDir = join(cacheDir, "Paseo-0.11.0-beta.3");
    assert.equal(cachedPristine("0.11.0-beta.3", cacheDir, "win32"), null);
    mkdirSync(installDir);
    assert.equal(cachedPristine("0.11.0-beta.3", cacheDir, "win32"), installDir);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
