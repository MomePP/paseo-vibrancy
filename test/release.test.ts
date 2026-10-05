import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
  sweepOlderPristine,
  verifyPaseoSignature,
  type GithubRelease,
} from "../server/release.ts";
import type { Release } from "../shared/rpc.ts";
import { compareVersions } from "../shared/version.ts";

const execFileAsync = promisify(execFile);
const fixtureYml = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url).href), "fixtures", "beta3-mac.yml"),
  "utf8",
);

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

test("parseMacYml finds the arm64 zip entry's size and sha512", () => {
  const release = parseMacYml(
    fixtureYml,
    "0.11.0-beta.3",
    "https://github.com/getpaseo/paseo/releases/download/v0.11.0-beta.3/Paseo-0.11.0-beta.3-arm64.zip",
  );
  assert.ok(release.zipUrl.endsWith("Paseo-0.11.0-beta.3-arm64.zip"));
  assert.equal(release.size, 179110962);
  assert.equal(release.sha512, "jYwoLTUDSifUiNcMtuyH5ya+25Carjzhyu3xkdct11tFZNd7+Biabi7D5beKXExlBNGJezxC7Fa4DZWYixQfIQ==");
});

test("checkLatest returns an error result on network failure, never throws", async () => {
  const result = await checkLatest({
    fetch: (() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as typeof fetch,
  });
  assert.equal(result.release, null);
  assert.match(result.error ?? "", /ENOTFOUND/);
});

test("checkLatest resolves a release through the beta-mac.yml asset", async (t) => {
  const server = createServer((req, res) => {
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
  const apiUrl = `http://127.0.0.1:${address.port}/releases`;

  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://ignored/beta-mac.yml") {
      return new Response(fixtureYml, { status: 200 });
    }
    return fetch(url, init);
  }) as typeof fetch;

  const result = await checkLatest({ fetch: fakeFetch, apiUrl });
  assert.equal(result.error, null);
  assert.equal(result.release?.version, "0.11.0-beta.3");
  assert.equal(result.release?.zipUrl, "http://ignored/zip");
  assert.equal(result.release?.size, 179110962);
});

test("fetchRelease fetches a single tagged release by version", async (t) => {
  const server = createServer((req, res) => {
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
  const apiUrl = `http://127.0.0.1:${address.port}/releases`;

  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://ignored/latest-mac.yml") {
      return new Response(fixtureYml, { status: 200 });
    }
    return fetch(url, init);
  }) as typeof fetch;

  const release = await fetchRelease("0.11.0-beta.3", { fetch: fakeFetch, apiUrl });
  assert.equal(release.version, "0.11.0-beta.3");
  assert.equal(release.zipUrl, "http://ignored/zip");
});

test("verifyPaseoSignature rejects a non-Paseo (Apple-signed) app", async () => {
  await assert.rejects(() => verifyPaseoSignature("/System/Applications/Calculator.app"));
});

test("downloadVerified rejects a sha512 mismatch and leaves the cache dir empty", async (t) => {
  const srcDir = mkdtempSync(join(tmpdir(), "vibrancy-release-src-"));
  t.after(() => rmSync(srcDir, { recursive: true, force: true }));
  writeFileSync(join(srcDir, "marker.txt"), "not a real app, just zip payload\n");

  const zipDir = mkdtempSync(join(tmpdir(), "vibrancy-release-zip-"));
  t.after(() => rmSync(zipDir, { recursive: true, force: true }));
  const zipPath = join(zipDir, "Paseo-0.11.0-beta.3-arm64.zip");
  await execFileAsync("ditto", ["-c", "-k", "--sequesterRsrc", srcDir, zipPath]);
  const zipBytes = readFileSync(zipPath);

  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/zip");
    res.end(zipBytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

  const cacheDir = mkdtempSync(join(tmpdir(), "vibrancy-release-cache-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

  const release: Release = {
    version: "0.11.0-beta.3",
    zipUrl: `http://127.0.0.1:${address.port}/Paseo-0.11.0-beta.3-arm64.zip`,
    sha512: "not-the-real-hash==",
    size: zipBytes.length,
  };

  await assert.rejects(() => downloadVerified(release, cacheDir), /sha512 mismatch/);
  assert.deepEqual(readdirSync(cacheDir), []);
});

test("downloadVerified reports the byte fraction while downloading, then extract and verify", async (t) => {
  const srcDir = mkdtempSync(join(tmpdir(), "vibrancy-release-src-"));
  t.after(() => rmSync(srcDir, { recursive: true, force: true }));
  mkdirSync(join(srcDir, "Fake.app"));
  writeFileSync(join(srcDir, "Fake.app", "payload.bin"), randomBytes(3_000_000));

  const zipDir = mkdtempSync(join(tmpdir(), "vibrancy-release-zip-"));
  t.after(() => rmSync(zipDir, { recursive: true, force: true }));
  const zipPath = join(zipDir, "Paseo-0.11.0-beta.3-arm64.zip");
  await execFileAsync("ditto", ["-c", "-k", "--sequesterRsrc", srcDir, zipPath]);
  const zipBytes = readFileSync(zipPath);

  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/zip");
    res.end(zipBytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

  const cacheDir = mkdtempSync(join(tmpdir(), "vibrancy-release-cache-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

  const release: Release = {
    version: "0.11.0-beta.3",
    zipUrl: `http://127.0.0.1:${address.port}/Paseo-0.11.0-beta.3-arm64.zip`,
    sha512: createHash("sha512").update(zipBytes).digest("base64"),
    size: zipBytes.length,
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

test("sweepOlderPristine removes only strictly-older Paseo-*.app entries", async (t) => {
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

  await sweepOlderPristine(cacheDir, "0.11.0-beta.3");

  assert.deepEqual(readdirSync(cacheDir).sort(), [
    "Paseo-0.11.0-beta.3.app",
    "Paseo-0.11.0-beta.5.app",
    "Paseo-not-a-version.app",
    "not-a-paseo-app.txt",
  ]);
});

test("cachedPristine returns null when no pristine copy exists and the path once one does", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "vibrancy-release-cached-"));
  try {
    assert.equal(cachedPristine("0.11.0-beta.3", cacheDir), null);
    writeFileSync(join(cacheDir, "not-an-app"), "x");
    const appDir = join(cacheDir, "Paseo-0.11.0-beta.3.app");
    writeFileSync(join(cacheDir, "Paseo-0.11.0-beta.3.app-marker"), "x");
    // cachedPristine only checks existence of the exact app path.
    assert.equal(cachedPristine("0.11.0-beta.3", cacheDir), null);
    writeFileSync(appDir, "pretend-app");
    assert.equal(cachedPristine("0.11.0-beta.3", cacheDir), appDir);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
