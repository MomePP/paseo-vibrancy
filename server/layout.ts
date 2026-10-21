/**
 * Where things live inside a Paseo install. macOS: an `.app` bundle, with
 * `Contents/Resources` and `Contents/MacOS/<CFBundleExecutable>`. Windows:
 * the folder holding `Paseo.exe`, with `resources/` beside it.
 */

import { homedir, release } from "node:os";
import { join } from "node:path";

import { HOST_PLATFORM } from "../shared/platform.ts";
import type { HostPlatform } from "../shared/platform.ts";
import { fs } from "./fs.ts";

const { closeSync, openSync, readFileSync, readSync } = fs;

/** Windows' `Paseo.exe`; electron-builder names it after the product. */
export const WINDOWS_EXE = "Paseo.exe";

/** `setBackgroundMaterial` needs Windows 11 22H2 (build 22621) or later. */
const MIN_WINDOWS_BUILD = 22621;

export function localAppData(): string {
  return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
}

export function resourcesDir(app: string, platform: HostPlatform = HOST_PLATFORM): string {
  return platform === "win32" ? join(app, "resources") : join(app, "Contents", "Resources");
}

/** Reads `CFBundleExecutable` out of the bundle's Info.plist, falling back to "Paseo" if missing or unreadable. */
function execName(app: string): string {
  try {
    const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
    const match = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]*)<\/string>/);
    return match ? match[1]! : "Paseo";
  } catch {
    return "Paseo";
  }
}

export function appExecutable(app: string, platform: HostPlatform = HOST_PLATFORM): string {
  return platform === "win32" ? join(app, WINDOWS_EXE) : join(app, "Contents", "MacOS", execName(app));
}

/**
 * The app's version: `CFBundleShortVersionString` from Info.plist on macOS;
 * on Windows (no plist, and the exe's version resource is awkward to reach)
 * the `version` of `package.json` inside `resources/app.asar`.
 */
export function appVersion(app: string, platform: HostPlatform = HOST_PLATFORM): string {
  if (platform === "win32") {
    const asarPath = join(resourcesDir(app, platform), "app.asar");
    const version = (JSON.parse(readAsarFile(asarPath, "package.json").toString("utf8")) as { version?: unknown }).version;
    if (typeof version !== "string") {
      throw new Error(`appVersion: no version in ${asarPath}/package.json`);
    }
    return version;
  }
  const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
  const match = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/);
  if (!match) {
    throw new Error(`appVersion: CFBundleShortVersionString not found in ${app}/Contents/Info.plist`);
  }
  return match[1]!;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, position);
  if (read !== length) {
    throw new Error(`asar: short read at ${position}`);
  }
  return buffer;
}

/**
 * Reads one top-level file out of an asar archive without loading the
 * archive: a 16-byte prefix (pickle sizes, then the header JSON's length at
 * byte 12), the header JSON, then the file's bytes at `offset` past the
 * header pickle (`8 + headerSize`).
 */
export function readAsarFile(asarPath: string, name: string): Buffer {
  const fd = openSync(asarPath, "r");
  try {
    const prefix = readAt(fd, 0, 16);
    const headerSize = prefix.readUInt32LE(4);
    const header = JSON.parse(readAt(fd, 16, prefix.readUInt32LE(12)).toString("utf8")) as {
      files?: Record<string, { size?: number; offset?: string }>;
    };
    const entry = header.files?.[name];
    if (typeof entry?.size !== "number" || typeof entry.offset !== "string") {
      throw new Error(`asar: ${name} not found in ${asarPath}`);
    }
    return readAt(fd, 8 + headerSize + Number(entry.offset), entry.size);
  } finally {
    closeSync(fd);
  }
}

/**
 * Throws unless `osRelease` (`10.0.<build>`, from `os.release()`) is
 * Windows 11 22H2 or later. The registry's product name is no help: it still
 * says "Windows 10" on Windows 11.
 */
export function assertWindowsBlurSupported(osRelease: string = release()): void {
  const build = Number(osRelease.split(".")[2]);
  if (!Number.isInteger(build) || build < MIN_WINDOWS_BUILD) {
    throw new Error(
      `Paseo-Vibrancy needs Windows 11 22H2 (build ${MIN_WINDOWS_BUILD}) or later for the blur; this is ${osRelease}`,
    );
  }
}
