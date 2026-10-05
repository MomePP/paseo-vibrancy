/**
 * Fetches Paseo release metadata from GitHub, parses electron-builder's
 * `beta-mac.yml`/`latest-mac.yml` feed format, and downloads + verifies a
 * pristine copy of the app before it is ever patched.
 *
 * Two independent trust checks gate every downloaded build before it is
 * cached: the base64 sha512 electron-builder publishes in the yml (integrity
 * of the bytes) and Apple's own code signature against Paseo's designated
 * requirement (identity of the bytes — this is still really Paseo, not a
 * same-named impostor).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import type { BuildStepId } from "../shared/build-progress.ts";
import type { Release } from "../shared/rpc.ts";
import { compareVersions } from "../shared/version.ts";
import { fs, fsp } from "./fs.ts";

const { existsSync, createWriteStream } = fs;
const { mkdir, readdir, rename, rm } = fsp;

const execFileAsync = promisify(execFile);

export const DEFAULT_CACHE_DIR = join(homedir(), "Library", "Caches", "paseo-vibrancy");

export const DEFAULT_API_URL = "https://api.github.com/repos/getpaseo/paseo/releases";

/** Verbatim from the plan's global constraints. */
export const PASEO_REQUIREMENT =
  'identifier "sh.paseo.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "99ZMJMKU9Y"';

const GITHUB_HEADERS = {
  "User-Agent": "paseo-vibrancy-plugin",
  Accept: "application/vnd.github+json",
};

export type GithubAsset = { name: string; browser_download_url: string };

export type GithubRelease = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets?: GithubAsset[];
};

export type FeedOpts = { fetch?: typeof fetch; apiUrl?: string };

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
 * fixed and small enough that a real parser would buy nothing.
 */
export function parseMacYml(text: string, version: string, zipUrl: string): Release {
  const target = `Paseo-${version}-arm64.zip`;
  const entryRe = /-\s*url:\s*(\S+)\s*\r?\n\s*sha512:\s*(\S+)\s*\r?\n\s*size:\s*(\d+)/g;

  for (const match of text.matchAll(entryRe)) {
    if (match[1] === target) {
      return { version, zipUrl, sha512: match[2], size: Number.parseInt(match[3], 10) };
    }
  }
  throw new Error(`parseMacYml: no arm64 zip entry for ${target}`);
}

async function releaseFromGithub(gh: GithubRelease, doFetch: typeof fetch): Promise<Release> {
  const assets = gh.assets ?? [];
  const ymlAsset = assets.find((a) => a.name === "beta-mac.yml") ?? assets.find((a) => a.name === "latest-mac.yml");
  if (!ymlAsset) {
    throw new Error(`release ${gh.tag_name}: no beta-mac.yml or latest-mac.yml asset`);
  }

  const version = stripV(gh.tag_name);
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
    return { release: await releaseFromGithub(latest, doFetch), error: null };
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
  return releaseFromGithub(gh, doFetch);
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

/**
 * Downloads `release.zipUrl` straight to disk while hashing (zips run
 * ~186 MB; nothing is buffered in memory), checks size and base64 sha512,
 * extracts with `ditto`, verifies the extracted bundle's signature, then
 * moves it into `cacheDir` as `Paseo-<version>.app` and drops the zip and any
 * older pristine copies. Any failure leaves `cacheDir` exactly as it found it.
 * `onProgress` hears each step as it starts, and the download's byte fraction.
 */
export async function downloadVerified(
  release: Release,
  cacheDir: string = DEFAULT_CACHE_DIR,
  onProgress?: DownloadProgress,
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

    const hash = createHash("sha512");
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
    const digest = hash.digest("base64");
    if (digest !== release.sha512) {
      throw new Error(`sha512 mismatch: expected ${release.sha512}, got ${digest}`);
    }

    const extractDir = join(staging, "extracted");
    await mkdir(extractDir, { recursive: true });
    onProgress?.("extract", 0, null);
    await execFileAsync("ditto", ["-x", "-k", zipPath, extractDir]);

    const extractedName = (await readdir(extractDir)).find((name) => name.endsWith(".app"));
    if (!extractedName) {
      throw new Error("extracted zip did not contain a .app bundle");
    }
    const extractedApp = join(extractDir, extractedName);

    onProgress?.("verify", 0, null);
    await verifyPaseoSignature(extractedApp);

    const finalPath = join(cacheDir, `Paseo-${release.version}.app`);
    await rm(finalPath, { recursive: true, force: true });
    await rename(extractedApp, finalPath);

    await sweepOlderPristine(cacheDir, release.version);

    return finalPath;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Removes every `Paseo-<version>.app` in `cacheDir` whose version is
 * strictly older than `keepVersion`. Entries that don't match the
 * `Paseo-*.app` naming pattern, or whose "version" doesn't parse into
 * comparable numbers, are left alone rather than guessed at.
 */
export async function sweepOlderPristine(cacheDir: string, keepVersion: string): Promise<void> {
  for (const entry of await readdir(cacheDir)) {
    if (entry === `Paseo-${keepVersion}.app` || !entry.startsWith("Paseo-") || !entry.endsWith(".app")) {
      continue;
    }
    const entryVersion = entry.slice("Paseo-".length, -".app".length);
    if (compareVersions(entryVersion, keepVersion) < 0) {
      await rm(join(cacheDir, entry), { recursive: true, force: true });
    }
  }
}

/** Path to an already-downloaded pristine copy for `version`, or null if it isn't cached. */
export function cachedPristine(version: string, cacheDir: string = DEFAULT_CACHE_DIR): string | null {
  const path = join(cacheDir, `Paseo-${version}.app`);
  return existsSync(path) ? path : null;
}
