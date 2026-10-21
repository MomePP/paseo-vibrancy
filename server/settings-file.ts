/**
 * Reads and writes the live vibrancy settings file — `paseo-vibrancy.json`
 * in Paseo's Electron `userData` by default — which `pv.js` (baked into the
 * patched asar at build time) watches for live updates. Writes are atomic
 * (write `.tmp`, then rename) so `pv.js` never observes a half-written file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { HOST_PLATFORM } from "../shared/platform.ts";
import { parseVibrancy } from "../shared/vibrancy.ts";
import type { VibrancySettings } from "../shared/vibrancy.ts";

/**
 * Paseo's `userData`: `PASEO_ELECTRON_USER_DATA_DIR` when set (an isolated
 * instance; the daemon inherits it from the app), else Electron's default —
 * `%APPDATA%\Paseo` on Windows, `~/Library/Application Support/Paseo` on macOS.
 */
const USER_DATA =
  process.env.PASEO_ELECTRON_USER_DATA_DIR ||
  (HOST_PLATFORM === "win32"
    ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Paseo")
    : join(homedir(), "Library", "Application Support", "Paseo"));

export const DEFAULT_SETTINGS_FILE = join(USER_DATA, "paseo-vibrancy.json");

/** Missing or unparsable files fall back to `VIBRANCY_DEFAULTS` via `parseVibrancy`. */
export function readSettings(file: string = DEFAULT_SETTINGS_FILE): VibrancySettings {
  if (!existsSync(file)) {
    return parseVibrancy(undefined);
  }
  try {
    return parseVibrancy(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return parseVibrancy(undefined);
  }
}

/** Atomic write: `.tmp` in the same directory, then `renameSync` over the target. */
export function writeSettings(settings: VibrancySettings, file: string = DEFAULT_SETTINGS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
  renameSync(tmp, file);
}
