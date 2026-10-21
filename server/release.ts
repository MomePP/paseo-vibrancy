/**
 * Fetches Paseo release metadata from GitHub and downloads + verifies a
 * pristine copy of the app before it is ever patched.
 *
 * macOS: two independent trust checks gate every downloaded build before it
 * is cached: the sha512 electron-builder publishes in `beta-mac.yml`/
 * `latest-mac.yml` (integrity of the bytes) and Apple's own code signature
 * against Paseo's designated requirement (identity of the bytes — this is
 * still really Paseo, not a same-named impostor).
 *
 * Windows: Paseo's Windows builds are unsigned and no yml lists the zip
 * (`latest.yml` has only the Setup `.exe`), so the only check is the sha256
 * digest GitHub itself records for the release asset — integrity, with no
 * identity check behind it.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import type { BuildStepId } from "../shared/build-progress.ts";
import { HOST_PLATFORM } from "../shared/platform.ts";
import type { HostPlatform } from "../shared/platform.ts";
import type { Release } from "../shared/rpc.ts";
import { compareVersions } from "../shared/version.ts";
import { fs, fsp } from "./fs.ts";
import { WINDOWS_EXE, localAppData, resourcesDir } from "./layout.ts";

const { existsSync, createWriteStream } = fs;
const { mkdir, readdir, rename, rm } = fsp;

const execFileAsync = promisify(execFile);

export const DEFAULT_CACHE_DIR =
  HOST_PLATFORM === "win32"
    ? join(localAppData(), "paseo-vibrancy", "cache")
    : join(homedir(), "Library", "Caches", "paseo-vibrancy");

export const DEFAULT_API_URL = "https://api.github.com/repos/getpaseo/paseo/releases";

/** Verbatim from the plan's global constraints. */
export const PASEO_REQUIREMENT =
  'identifier "sh.paseo.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "99ZMJMKU9Y"';

/** Windows' own bsdtar, which reads zips; a Git or MSYS `tar` earlier on PATH would not. */
const WINDOWS_TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

const GITHUB_HEADERS = {
  "User-Agent": "paseo-vibrancy-plugin",
  Accept: "application/vnd.github+json",
};

/** `digest` is GitHub's own `sha256:<hex>` for the asset; older releases may lack it. */
export type GithubAsset = { name: string; browser_download_url: string; size?: number; digest?: string | null };

export type GithubRelease = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets?: GithubAsset[];
};

export type FeedOpts = { fetch?: typeof fetch; apiUrl?: string; platform?: HostPlatform; arch?: string };

function stripV(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/** Skips drafts; prereleases (betas) are eligible. */
export function pickLatest(releases: GithubRelease[]): GithubRelease | null {
  let best: GithubRelease | null = null;
  for (const release of releases) {
    if (release.draft) continue;
    if (best === null || compareVersions(stripV(release.tag_name), stripV(best.tag_name)) > 0) {
      best = release;
    }
  }
  return best;
}

/**
 * Hand-rolled parse of electron-builder's yml feed — just enough to pull the
 * arm64 zip's `sha512`/`size` out of the `files:` list, in document order
 * (`url`, then `sha512`, then `size`). No YAML dependency: the format here is
 * fixed and small enough that a real parser would buy nothing. The yml's
 * base64 sha512 is returned as hex, like every `Release.digest`.
 */
export function parseMacYml(text: string, version: string, zipUrl: string): Release {
  const target = `Paseo-${version}-arm64.zip`;
  const entryRe = /-\s*url:\s*(\S+)\s*\r?\n\s*sha512:\s*(\S+)\s*\r?\n\s*size:\s*(\d+)/g;

  for (const match of text.matchAll(entryRe)) {
    if (match[1] === target) {
      return {
        version,
        zipUrl,
        size: Number.parseInt(match[3]!, 10),
        algorithm: "sha512",
        digest: Buffer.from(match[2]!, "base64").toString("hex"),
      };
    }
  }
  throw new Error(`parseMacYml: no arm64 zip entry for ${target}`);
}

/** The Windows zip for this CPU: Paseo publishes x64 and arm64. */
export function windowsZipName(version: string, arch: string = process.arch): string {
  return `Paseo-Setup-${version}-${arch === "arm64" ? "arm64" : "x64"}.zip`;
}

/** A Windows release from its zip asset; GitHub's `sha256:` digest and size are required, never guessed. */
export function releaseFromWindowsAsset(version: string, asset: GithubAsset): Release {
  const digest = asset.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
  if (digest === undefined || typeof asset.size !== "number") {
    throw new Error(`${asset.name}: GitHub lists no sha256 digest and size for it`);
  }
  return { version, zipUrl: asset.browser_download_url, size: asset.size, algorithm: "sha256", digest };
}

async function releaseFromGithub(
  gh: GithubRelease,
  doFetch: typeof fetch,
  platform: HostPlatform,
  arch: string,
): Promise<Release> {
  const assets = gh.assets ?? [];
  const version = stripV(gh.tag_name);

  if (platform === "win32") {
    const zipName = windowsZipName(version, arch);
    const zipAsset = assets.find((a) => a.name === zipName);
    if (!zipAsset) {
      throw new Error(`release ${gh.tag_name}: no ${zipName} asset`);
    }
    return releaseFromWindowsAsset(version, zipAsset);
  }

  const ymlAsset = assets.find((a) => a.name === "beta-mac.yml") ?? assets.find((a) => a.name === "latest-mac.yml");
  if (!ymlAsset) {
    throw new Error(`release ${gh.tag_name}: no beta-mac.yml or latest-mac.yml asset`);
  }

  const zipName = `Paseo-${version}-arm64.zip`;
  const zipAsset = assets.find((a) => a.name === zipName);
  if (!zipAsset) {
    throw new Error(`release ${gh.tag_name}: no ${zipName} asset`);
  }

  const ymlResponse = await doFetch(ymlAsset.browser_download_url, { headers: GITHUB_HEADERS });
  if (!ymlResponse.ok) {
    throw new Error(`failed to fetch ${ymlAsset.name}: HTTP ${ymlResponse.status}`);
  }
  const text = await ymlResponse.text();
  return parseMacYml(text, version, zipAsset.browser_download_url);
}

/**
 * Lists releases and resolves the newest non-draft one. Unlike
 * `fetchRelease`, every failure (network, HTTP, parse) is swallowed into the
 * error field: this backs a background poll that must never throw into
 * whatever scheduled it, and the unauthenticated GitHub API's 60 req/h limit
 * makes transient failures routine.
 */
export async function checkLatest(opts: FeedOpts = {}): Promise<{ release: Release | null; error: string | null }> {
  const doFetch = opts.fetch ?? fetch;
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  try {
    const response = await doFetch(`${apiUrl}?per_page=20`, { headers: GITHUB_HEADERS });
    if (!response.ok) {
      return { release: null, error: `GitHub API error: HTTP ${response.status}` };
    }
    const releases = (await response.json()) as GithubRelease[];
    const latest = pickLatest(releases);
    if (!latest) {
      return { release: null, error: null };
    }
    const release = await releaseFromGithub(latest, doFetch, opts.platform ?? HOST_PLATFORM, opts.arch ?? process.arch);
    return { release, error: null };
  } catch (error) {
    return { release: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Fetches one named release directly; failures are the caller's to report. */
export async function fetchRelease(version: string, opts: FeedOpts = {}): Promise<Release> {
  const doFetch = opts.fetch ?? fetch;
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  const response = await doFetch(`${apiUrl}/tags/v${version}`, { headers: GITHUB_HEADERS });
  if (!response.ok) {
    throw new Error(`GitHub API error: HTTP ${response.status}`);
  }
  const gh = (await response.json()) as GithubRelease;
  return releaseFromGithub(gh, doFetch, opts.platform ?? HOST_PLATFORM, opts.arch ?? process.arch);
}

/** `codesign --verify` against Paseo's designated requirement; rejects for anything else, including Apple's own apps. */
export async function verifyPaseoSignature(appPath: string): Promise<void> {
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", `-R=${PASEO_REQUIREMENT}`, appPath]);
}

export type DownloadProgress = (
  step: Extract<BuildStepId, "download" | "extract" | "verify">,
  fraction: number,
  detail: string | null,
) => void;

function downloadDetail(bytes: number, size: number): string {
  return `${Math.round(bytes / 1e6)} / ${Math.round(size / 1e6)} MB`;
}

/** The cached pristine copy's name: the `.app` bundle on macOS, the install folder on Windows. */
function pristineName(version: string, platform: HostPlatform = HOST_PLATFORM): string {
  return platform === "win32" ? `Paseo-${version}` : `Paseo-${version}.app`;
}

/**
 * Extracts `zipPath` into `extractDir` and returns the app inside it. macOS:
 * `ditto`, then the one `.app` bundle. Windows: the zip's root is the install
 * itself (`Paseo.exe`, `resources/app.asar`, ...), so `extractDir` is the app.
 */
async function extractApp(zipPath: string, extractDir: string, platform: HostPlatform): Promise<string> {
  if (platform === "win32") {
    await execFileAsync(WINDOWS_TAR, ["-xf", zipPath, "-C", extractDir]);
    if (!existsSync(join(extractDir, WINDOWS_EXE)) || !existsSync(join(resourcesDir(extractDir, platform), "app.asar"))) {
      throw new Error(`extracted zip has no ${WINDOWS_EXE} and resources/app.asar`);
    }
    return extractDir;
  }
  await execFileAsync("ditto", ["-x", "-k", zipPath, extractDir]);
  const extractedName = (await readdir(extractDir)).find((name) => name.endsWith(".app"));
  if (!extractedName) {
    throw new Error("extracted zip did not contain a .app bundle");
  }
  return join(extractDir, extractedName);
}

/**
 * Downloads `release.zipUrl` straight to disk while hashing (zips run
 * ~190 MB; nothing is buffered in memory), checks size and digest, extracts,
 * verifies the extracted bundle's signature (macOS), then moves it into
 * `cacheDir` as `pristineName(version)` and drops the zip and any older
 * pristine copies. Any failure leaves `cacheDir` exactly as it found it.
 * `onProgress` hears each step as it starts, and the download's byte fraction.
 */
export async function downloadVerified(
  release: Release,
  cacheDir: string = DEFAULT_CACHE_DIR,
  onProgress?: DownloadProgress,
  platform: HostPlatform = HOST_PLATFORM,
): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const staging = join(tmpdir(), `paseo-vibrancy-dl-${process.pid}-${Date.now()}`);
  await mkdir(staging, { recursive: true });

  try {
    const zipPath = join(staging, "download.zip");
    onProgress?.("download", 0, downloadDetail(0, release.size));
    const response = await fetch(release.zipUrl);
    if (!response.ok || !response.body) {
      throw new Error(`download failed: HTTP ${response.status}`);
    }

    const hash = createHash(release.algorithm);
    let bytes = 0;
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      async function* hashPass(source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          bytes += chunk.length;
          yield chunk;
          onProgress?.("download", bytes / release.size, downloadDetail(bytes, release.size));
        }
      },
      createWriteStream(zipPath),
    );

    if (bytes !== release.size) {
      throw new Error(`downloaded size ${bytes} does not match expected ${release.size}`);
    }
    const digest = hash.digest("hex");
    if (digest !== release.digest) {
      throw new Error(`${release.algorithm} mismatch: expected ${release.digest}, got ${digest}`);
    }

    const extractDir = join(staging, "extracted");
    await mkdir(extractDir, { recursive: true });
    onProgress?.("extract", 0, null);
    const extractedApp = await extractApp(zipPath, extractDir, platform);

    if (platform === "darwin") {
      onProgress?.("verify", 0, null);
      await verifyPaseoSignature(extractedApp);
    }

    const finalPath = join(cacheDir, pristineName(release.version, platform));
    await rm(finalPath, { recursive: true, force: true });
    await rename(extractedApp, finalPath);

    await sweepOlderPristine(cacheDir, release.version, platform);

    return finalPath;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Removes every pristine copy in `cacheDir` (`pristineName` pattern) whose
 * version is strictly older than `keepVersion`. Entries that don't match the
 * pattern, or whose "version" doesn't parse into comparable numbers, are
 * left alone rather than guessed at.
 */
export async function sweepOlderPristine(
  cacheDir: string,
  keepVersion: string,
  platform: HostPlatform = HOST_PLATFORM,
): Promise<void> {
  const suffix = platform === "win32" ? "" : ".app";
  for (const entry of await readdir(cacheDir)) {
    if (entry === pristineName(keepVersion, platform) || !entry.startsWith("Paseo-") || !entry.endsWith(suffix)) {
      continue;
    }
    const entryVersion = entry.slice("Paseo-".length, entry.length - suffix.length);
    if (compareVersions(entryVersion, keepVersion) < 0) {
      await rm(join(cacheDir, entry), { recursive: true, force: true });
    }
  }
}

/** Path to an already-downloaded pristine copy for `version`, or null if it isn't cached. */
export function cachedPristine(
  version: string,
  cacheDir: string = DEFAULT_CACHE_DIR,
  platform: HostPlatform = HOST_PLATFORM,
): string | null {
  const path = join(cacheDir, pristineName(version, platform));
  return existsSync(path) ? path : null;
}
