/**
 * Ports the build half of the former paseo-repatch script's `main`: copy a
 * pristine source into staging, apply every patch from
 * `asar.ts`/`patch-renderer.ts`/`main-hook.ts`/`blur.ts`, neuter the updater,
 * and stamp. On macOS also set the asar-integrity hash and ad-hoc sign; on
 * Windows there is no signature to redo, and the asar-integrity fuse is
 * checked to be off instead. Release fetch/verify (`server/release.ts`) and
 * the staging-to-live swap (`server/swap.ts`) are separate modules; this one
 * only ever writes into `staging`, never the live copy.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { BuildStepId } from "../shared/build-progress.ts";
import { HOST_PLATFORM } from "../shared/platform.ts";
import type { HostPlatform } from "../shared/platform.ts";
import { ASAR_HOOK_ANCHOR, ASAR_HOOK_LINE, patchAsar } from "./asar.ts";
import { BLUR_CLANG_ARGS, BLUR_M, compileBlur } from "./blur.ts";
import { fs, fsp } from "./fs.ts";
import { resolveTerm } from "./ghostty.ts";
import { readSettings } from "./settings-file.ts";
import type { TermMetrics } from "./ghostty.ts";
import { WINDOWS_EXE, appVersion, localAppData, resourcesDir } from "./layout.ts";
import { PV_JS } from "./main-hook.ts";
import { patchIndexHtml, patchRenderer, rendererPath } from "./patch-renderer.ts";
import { BUILD_TABLES } from "./renderer-patches.ts";

const { closeSync, existsSync, openSync, readSync } = fs;
const { copyFile, mkdir, readFile, readdir, rm, writeFile } = fsp;

const execFileAsync = promisify(execFile);

export const DEFAULT_STAGING =
  HOST_PLATFORM === "win32"
    ? join(localAppData(), "Programs", ".Paseo-Vibrancy.staging")
    : join(homedir(), "Applications", ".Paseo-Vibrancy.staging.app");

export const STAMP_NAME = ".vibrancy-build";

// electron-updater reads this from the bundle. Pointing it at an address that
// cannot resolve turns the update check into a logged failure instead of a
// download that would overwrite the patches — and, on macOS, would be
// rejected against the ad-hoc signature anyway. Rebuilding happens from the
// paseo-vibrancy plugin's settings screen, not a standalone script.
export const DEAD_UPDATE_YML = `# neutered by the paseo-vibrancy plugin: this copy must never self-update.
# Updates come from Settings -> Plugins -> paseo-vibrancy -> Vibrancy -> Update & restart.
provider: generic
url: https://127.0.0.1:1/paseo-vibrancy-disabled/
updaterCacheDirName: '@getpaseodesktop-updater'
`;

/**
 * Serialises every byte-affecting build input for `buildFingerprint`:
 * `BUILD_TABLES` (every renderer/index.html patch table and constant),
 * `ASAR_HOOK_LINE`/`ASAR_HOOK_ANCHOR` (the anchor's length decides the
 * asar's space-padding), `PV_JS`, `BLUR_M`/`BLUR_CLANG_ARGS`,
 * `DEAD_UPDATE_YML`, and the resolved terminal metrics — an edit to a patch,
 * the main-process hook, the blur addon or its compiler flags, the updater
 * neutering text, or the Ghostty derivation all land here. RegExp values
 * serialise as `{source, flags}` — plain `JSON.stringify` otherwise drops
 * them as `{}`. `overrides` exists only so tests can prove each field is
 * actually hashed, without reaching for module-mocking to swap a `const`;
 * `buildFingerprint` itself never passes any.
 */
export function serialiseFingerprintInputs(
  term: TermMetrics,
  overrides: {
    asarHookAnchor?: string;
    deadUpdateYml?: string;
    blurClangArgs?: readonly string[];
  } = {},
): string {
  return JSON.stringify(
    {
      BUILD_TABLES,
      ASAR_HOOK_LINE,
      ASAR_HOOK_ANCHOR: overrides.asarHookAnchor ?? ASAR_HOOK_ANCHOR,
      PV_JS,
      BLUR_M,
      BLUR_CLANG_ARGS: overrides.blurClangArgs ?? BLUR_CLANG_ARGS,
      DEAD_UPDATE_YML: overrides.deadUpdateYml ?? DEAD_UPDATE_YML,
      term,
    },
    (_key, value) => (value instanceof RegExp ? { source: value.source, flags: value.flags } : value),
  );
}

export function buildFingerprint(term: TermMetrics): string {
  return createHash("sha256").update(serialiseFingerprintInputs(term)).digest("hex").slice(0, 12);
}

export function stampFor(version: string, fingerprint: string): string {
  return `${version}|vibrancy=${fingerprint}`;
}

/** Electron's fuse wire: this sentinel, a version byte, a count byte, then one ASCII byte per fuse. */
const FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
/** `EnableEmbeddedAsarIntegrityValidation`'s index in fuse wire version 1. */
const ASAR_INTEGRITY_FUSE = 4;

/**
 * The asar-integrity fuse baked into `exe`: "0" off, "1" on, "r" removed, or
 * null when no version-1 wire is found. Reads the ~240 MB exe in chunks
 * rather than loading it whole.
 */
export function asarIntegrityFuse(exe: string): string | null {
  const fd = openSync(exe, "r");
  try {
    // The tail of each read moves to the front of the buffer before the
    // next one, so a wire straddling two reads is still found whole.
    const buffer = Buffer.alloc(4 << 20);
    let carried = 0;
    for (let position = 0; ; ) {
      const read = readSync(fd, buffer, carried, buffer.length - carried, position);
      if (read === 0) {
        return null;
      }
      position += read;
      const filled = carried + read;
      const at = buffer.subarray(0, filled).indexOf(FUSE_SENTINEL);
      const fuseAt = at + FUSE_SENTINEL.length + 2 + ASAR_INTEGRITY_FUSE;
      if (at !== -1 && fuseAt < filled) {
        const version = buffer[at + FUSE_SENTINEL.length];
        const count = buffer[at + FUSE_SENTINEL.length + 1]!;
        return version === 1 && count > ASAR_INTEGRITY_FUSE ? String.fromCharCode(buffer[fuseAt]!) : null;
      }
      carried = Math.min(64, filled);
      buffer.copy(buffer, 0, filled - carried, filled);
    }
  } finally {
    closeSync(fd);
  }
}

/** Recursive copy through `original-fs`, so `app.asar` is copied as the file it is, not walked as a directory. */
async function copyTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to);
    } else {
      await copyFile(from, to);
    }
  }
}

/**
 * Builds a patched copy of `opts.source` at `opts.staging` (signed, on
 * macOS). Any thrown error — a missing `app.asar`, an occurrence-count
 * mismatch, a failed codesign, an asar-integrity fuse that is on — deletes
 * the partial staging copy before rethrowing, so a failed build never leaves
 * a half-patched copy behind; the notes collected before the failure ride
 * along as the error's `report` property, so a caller that only sees the
 * rejection (`vibrancy.build`'s background job) can still surface what
 * succeeded before the failing step. `onStep` hears each step as it starts;
 * Windows has no `compile` or `sign` step.
 */
export async function buildStaging(opts: {
  source: string;
  staging?: string;
  ghosttyPath?: string;
  settingsFile?: string;
  platform?: HostPlatform;
  onStep?: (step: Extract<BuildStepId, "copy" | "patch" | "compile" | "sign">) => void;
}): Promise<{ report: string[]; missed: boolean }> {
  const staging = opts.staging ?? DEFAULT_STAGING;
  const platform = opts.platform ?? HOST_PLATFORM;
  const resources = resourcesDir(staging, platform);
  const report: string[] = [];

  try {
    opts.onStep?.("copy");
    await rm(staging, { recursive: true, force: true });
    if (platform === "win32") {
      // Windows Electron has no Info.plist hash to update: an edited asar
      // only loads while this fuse is off. Checked on the pristine exe
      // before copying anything, since the copy carries the same bytes.
      const fuse = asarIntegrityFuse(join(opts.source, WINDOWS_EXE));
      if (fuse !== "0") {
        throw new Error(
          `${WINDOWS_EXE} validates app.asar's integrity (fuse ${fuse ?? "not found"}): a patched app.asar would not load`,
        );
      }
      await copyTree(opts.source, staging);
    } else {
      await execFileAsync("ditto", [opts.source, staging]);
    }

    opts.onStep?.("patch");
    // 2. asar: same-length patches, hashed afterward for the Info.plist
    // integrity key Electron checks (on macOS) before it will load the archive.
    const asarPath = join(resources, "app.asar");
    const asarData = await readFile(asarPath);
    const { data: patchedAsar, notes: asarNotes } = patchAsar(asarData);
    await writeFile(asarPath, patchedAsar);
    report.push(...asarNotes);
    const asarDigest = createHash("sha256").update(patchedAsar).digest("hex");

    // 3. Renderer bundle + index.html. Term is resolved here (read, not
    // reported yet) so the renderer patch has the metrics it needs; its
    // notes land after the html notes to match the report's fixed order.
    const { term, notes: ghosttyNotes } = resolveTerm(readSettings(opts.settingsFile).terminal, opts.ghosttyPath);

    const bundlePath = rendererPath(staging, platform);
    const rendererSrc = await readFile(bundlePath, "utf8");
    const { src: patchedSrc, notes: rendererNotes } = patchRenderer(rendererSrc, term);
    await writeFile(bundlePath, patchedSrc, "utf8");
    report.push(...rendererNotes);

    const htmlPath = join(resources, "app-dist", "index.html");
    const htmlSrc = await readFile(htmlPath, "utf8");
    const { html: patchedHtml, notes: htmlNotes } = patchIndexHtml(htmlSrc, term.padding);
    await writeFile(htmlPath, patchedHtml, "utf8");
    report.push(...htmlNotes);

    report.push(...ghosttyNotes);

    // 4. pv.js (no note of its own — the hook it enables is the asar note
    // above) and, on macOS, blur.node.
    await writeFile(join(resources, "pv.js"), PV_JS, "utf8");
    if (platform === "darwin") {
      opts.onStep?.("compile");
      report.push(await compileBlur(join(resources, "blur.node")));
    }

    // 5. app-update.yml -> dead provider. Asserted like every other patch
    // rather than written blind: if Paseo ever moves this file into the
    // asar or renames it, a blind write would leave a stray file at the
    // dead path, report success, and let the real updater go on
    // overwriting the copy.
    const updaterPath = join(resources, "app-update.yml");
    if (existsSync(updaterPath)) {
      await writeFile(updaterPath, DEAD_UPDATE_YML, "utf8");
      report.push("ok      updater neutered");
    } else {
      report.push("MISSED  updater neutered: app-update.yml not found");
    }

    const missed = report.some((note) => note.startsWith("MISSED"));

    // 6. Electron refuses to load an asar whose hash does not match this
    // key, and the key name contains a dot, so PlistBuddy (`:` separated)
    // is required — `plutil -replace` would read "Resources/app.asar" as
    // two nested keys.
    if (platform === "darwin") {
      await execFileAsync("/usr/libexec/PlistBuddy", [
        "-c",
        `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${asarDigest}`,
        join(staging, "Contents", "Info.plist"),
      ]);
    }

    // Stamp written before the signature, not after: the stamp lands in
    // Contents/Resources, and anything added there once the bundle is
    // sealed makes `codesign --verify` report a missing sealed resource.
    const version = appVersion(staging, platform);
    const fingerprint = buildFingerprint(term);
    const want = stampFor(version, fingerprint);
    await writeFile(join(resources, STAMP_NAME), want + (missed ? "\nmissed" : "") + "\n", "utf8");

    // Editing anything under Contents/ invalidates the Developer ID
    // signature, and the hardened runtime means the app will not launch
    // unsigned.
    if (platform === "darwin") {
      opts.onStep?.("sign");
      await execFileAsync("codesign", ["--force", "--deep", "--sign", "-", staging]);
    }

    return { report, missed };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof Error) {
      (error as Error & { report?: string[] }).report = report;
    }
    throw error;
  }
}
