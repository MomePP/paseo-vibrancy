/**
 * Locates the running Paseo install from an executable path and reads its
 * build stamp, so `vibrancy.status` can report what the live copy is built
 * from without re-deriving the fingerprint logic owned by `server/build.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, win32 } from "node:path";

import { HOST_PLATFORM } from "../shared/platform.ts";
import type { HostPlatform } from "../shared/platform.ts";
import { STAMP_NAME } from "./build.ts";
import { WINDOWS_EXE, resourcesDir } from "./layout.ts";

/**
 * macOS: walks `execPath` from the root and returns the outermost `*.app`
 * bundle — e.g. `.../Paseo-Vibrancy.app/Contents/Frameworks/Paseo Helper.app/...`
 * resolves to `.../Paseo-Vibrancy.app`, not the nested helper. Windows: every
 * Paseo process (app, daemon, this plugin) runs `Paseo.exe`, so the install
 * is the folder holding it. `null` when `execPath` is neither (plain Node).
 */
export function runningBundle(execPath: string = process.execPath, platform: HostPlatform = HOST_PLATFORM): string | null {
  if (platform === "win32") {
    return win32.basename(execPath).toLowerCase() === WINDOWS_EXE.toLowerCase() ? win32.dirname(execPath) : null;
  }
  const parts = execPath.split("/");
  const appIndex = parts.findIndex((part) => part.endsWith(".app"));
  return appIndex === -1 ? null : parts.slice(0, appIndex + 1).join("/");
}

export function isVibrancyBuild(bundle: string, platform: HostPlatform = HOST_PLATFORM): boolean {
  return existsSync(join(resourcesDir(bundle, platform), STAMP_NAME));
}

export type Stamp = { version: string; fingerprint: string };

/** Parses `<version>|vibrancy=<fingerprint>` (optionally followed by `\nmissed`) out of `bundle`'s stamp file. */
export function readStamp(bundle: string, platform: HostPlatform = HOST_PLATFORM): Stamp | null {
  const stampPath = join(resourcesDir(bundle, platform), STAMP_NAME);
  if (!existsSync(stampPath)) {
    return null;
  }
  const firstLine = readFileSync(stampPath, "utf8").split("\n")[0] ?? "";
  const match = firstLine.match(/^(.*)\|vibrancy=(.*)$/);
  return match ? { version: match[1]!, fingerprint: match[2]! } : null;
}
