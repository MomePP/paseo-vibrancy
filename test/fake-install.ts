import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HOST_PLATFORM } from "../shared/platform.ts";
import type { HostPlatform } from "../shared/platform.ts";
import { resourcesDir } from "../server/layout.ts";

/**
 * Writes a minimal asar archive holding top-level `files`: a size pickle
 * (payload size 4, then the header pickle's size), the header pickle
 * (payload size, JSON length, JSON padded to 4 bytes), then the file bytes.
 */
export function writeAsar(path: string, files: Record<string, string>): void {
  const entries: Record<string, { size: number; offset: string }> = {};
  const bodies: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, "utf8");
    entries[name] = { size: body.length, offset: String(offset) };
    bodies.push(body);
    offset += body.length;
  }
  const json = Buffer.from(JSON.stringify({ files: entries }), "utf8");
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4)]);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + padded.length, 4);
  header.writeUInt32LE(4 + padded.length, 8);
  header.writeUInt32LE(json.length, 12);
  writeFileSync(path, Buffer.concat([header, padded, ...bodies]));
}

/**
 * A stand-in Paseo install for `version` under `dir`, laid out for
 * `platform`: an `.app` bundle with an Info.plist on macOS, a folder with
 * `Paseo.exe` and an `app.asar` whose package.json carries the version on
 * Windows. Returns the install and the path of its executable.
 */
export function fakeInstall(
  dir: string,
  version: string,
  platform: HostPlatform = HOST_PLATFORM,
): { app: string; execPath: string } {
  if (platform === "win32") {
    const app = join(dir, "Paseo");
    mkdirSync(resourcesDir(app, platform), { recursive: true });
    writeFileSync(join(app, "Paseo.exe"), "");
    writeAsar(join(resourcesDir(app, platform), "app.asar"), { "package.json": JSON.stringify({ name: "x", version }) });
    return { app, execPath: join(app, "Paseo.exe") };
  }
  const app = join(dir, "Paseo.app");
  mkdirSync(resourcesDir(app, platform), { recursive: true });
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  const plist = `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`;
  writeFileSync(join(app, "Contents", "Info.plist"), plist, "utf8");
  return { app, execPath: join(app, "Contents", "MacOS", "Paseo") };
}
