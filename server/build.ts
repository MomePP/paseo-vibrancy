/**
 * Ports the build half of the former paseo-repatch script's `main`:
 * `ditto` a pristine source into the staging bundle, apply every patch from
 * `asar.ts`/`patch-renderer.ts`/`main-hook.ts`/`blur.ts`, neuter the updater,
 * set the asar-integrity hash, stamp, and ad-hoc sign. Release fetch/verify
 * (`server/release.ts`) and the staging-to-live swap (`server/swap.ts`) are
 * separate modules; this one only ever writes into `staging`, never the live
 * copy.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { BuildStepId } from "../shared/build-progress.ts";
import { ASAR_HOOK_ANCHOR, ASAR_HOOK_LINE, patchAsar } from "./asar.ts";
import { BLUR_CLANG_ARGS, BLUR_M, compileBlur } from "./blur.ts";
import { fs, fsp } from "./fs.ts";
import { resolveTerm } from "./ghostty.ts";
import { readSettings } from "./settings-file.ts";
import type { TermMetrics } from "./ghostty.ts";
import { PV_JS } from "./main-hook.ts";
import { patchIndexHtml, patchRenderer, rendererPath } from "./patch-renderer.ts";
import { BUILD_TABLES } from "./renderer-patches.ts";

const { existsSync, readFileSync } = fs;
const { readFile, rm, writeFile } = fsp;

const execFileAsync = promisify(execFile);

export const DEFAULT_STAGING = join(homedir(), "Applications", ".Paseo-Vibrancy.staging.app");

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

/** Reads `CFBundleShortVersionString` out of the bundle's Info.plist. */
export function appVersion(app: string): string {
  const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
  const match = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/);
  if (!match) {
    throw new Error(`appVersion: CFBundleShortVersionString not found in ${app}/Contents/Info.plist`);
  }
  return match[1]!;
}

/** Reads `CFBundleExecutable` out of the bundle's Info.plist, falling back to "Paseo" if missing or unreadable. */
export function execName(app: string): string {
  try {
    const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
    const match = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]*)<\/string>/);
    return match ? match[1]! : "Paseo";
  } catch {
    return "Paseo";
  }
}

/**
 * Builds a signed, patched copy of `opts.source` at `opts.staging`
 * (`~/Applications/.Paseo-Vibrancy.staging.app` by default). Any thrown error
 * — a missing `app.asar`, an occurrence-count mismatch, a failed codesign —
 * deletes the partial staging bundle before rethrowing, so a failed build
 * never leaves a half-patched copy behind; the notes collected before the
 * failure ride along as the error's `report` property, so a caller that
 * only sees the rejection (`vibrancy.build`'s background job) can still
 * surface what succeeded before the failing step. `onStep` hears each
 * step as it starts.
 */
export async function buildStaging(opts: {
  source: string;
  staging?: string;
  ghosttyPath?: string;
  settingsFile?: string;
  onStep?: (step: Extract<BuildStepId, "copy" | "patch" | "compile" | "sign">) => void;
}): Promise<{ report: string[]; missed: boolean }> {
  const staging = opts.staging ?? DEFAULT_STAGING;
  const report: string[] = [];

  try {
    opts.onStep?.("copy");
    await rm(staging, { recursive: true, force: true });
    await execFileAsync("ditto", [opts.source, staging]);

    opts.onStep?.("patch");
    // 2. asar: same-length patches, hashed afterward for the Info.plist
    // integrity key Electron checks before it will load the archive.
    const asarPath = join(staging, "Contents", "Resources", "app.asar");
    const asarData = await readFile(asarPath);
    const { data: patchedAsar, notes: asarNotes } = patchAsar(asarData);
    await writeFile(asarPath, patchedAsar);
    report.push(...asarNotes);
    const asarDigest = createHash("sha256").update(patchedAsar).digest("hex");

    // 3. Renderer bundle + index.html. Term is resolved here (read, not
    // reported yet) so the renderer patch has the metrics it needs; its
    // notes land after the html notes to match the report's fixed order.
    const { term, notes: ghosttyNotes } = resolveTerm(readSettings(opts.settingsFile).terminal, opts.ghosttyPath);

    const bundlePath = rendererPath(staging);
    const rendererSrc = await readFile(bundlePath, "utf8");
    const { src: patchedSrc, notes: rendererNotes } = patchRenderer(rendererSrc, term);
    await writeFile(bundlePath, patchedSrc, "utf8");
    report.push(...rendererNotes);

    const htmlPath = join(staging, "Contents", "Resources", "app-dist", "index.html");
    const htmlSrc = await readFile(htmlPath, "utf8");
    const { html: patchedHtml, notes: htmlNotes } = patchIndexHtml(htmlSrc, term.padding);
    await writeFile(htmlPath, patchedHtml, "utf8");
    report.push(...htmlNotes);

    report.push(...ghosttyNotes);

    // 4. pv.js (no note of its own — the hook it enables is the asar note
    // above) and blur.node.
    await writeFile(join(staging, "Contents", "Resources", "pv.js"), PV_JS, "utf8");
    opts.onStep?.("compile");
    const blurNote = await compileBlur(join(staging, "Contents", "Resources", "blur.node"));
    report.push(blurNote);

    // 5. app-update.yml -> dead provider. Asserted like every other patch
    // rather than written blind: if Paseo ever moves this file into the
    // asar or renames it, a blind write would leave a stray file at the
    // dead path, report success, and let the real updater go on
    // overwriting the copy.
    const updaterPath = join(staging, "Contents", "Resources", "app-update.yml");
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
    await execFileAsync("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${asarDigest}`,
      join(staging, "Contents", "Info.plist"),
    ]);

    // Stamp written before the signature, not after: the stamp lands in
    // Contents/Resources, and anything added there once the bundle is
    // sealed makes `codesign --verify` report a missing sealed resource.
    const version = appVersion(staging);
    const fingerprint = buildFingerprint(term);
    const want = stampFor(version, fingerprint);
    await writeFile(
      join(staging, "Contents", "Resources", STAMP_NAME),
      want + (missed ? "\nmissed" : "") + "\n",
      "utf8",
    );

    // Editing anything under Contents/ invalidates the Developer ID
    // signature, and the hardened runtime means the app will not launch
    // unsigned.
    opts.onStep?.("sign");
    await execFileAsync("codesign", ["--force", "--deep", "--sign", "-", staging]);

    return { report, missed };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof Error) {
      (error as Error & { report?: string[] }).report = report;
    }
    throw error;
  }
}
