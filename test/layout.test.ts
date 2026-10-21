import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appExecutable, appVersion, assertWindowsBlurSupported, readAsarFile } from "../server/layout.ts";
import { fakeInstall, writeAsar } from "./fake-install.ts";

const stockWindowsPaseo = join(process.env.ProgramFiles ?? "C:\\Program Files", "Paseo");

test("readAsarFile reads each top-level file at its own offset", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-asar-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const asar = join(dir, "app.asar");
  writeAsar(asar, { "a.txt": "first", "package.json": '{"version":"9.8.7"}', "c.txt": "third" });

  assert.equal(readAsarFile(asar, "a.txt").toString(), "first");
  assert.equal(readAsarFile(asar, "package.json").toString(), '{"version":"9.8.7"}');
  assert.equal(readAsarFile(asar, "c.txt").toString(), "third");
  assert.throws(() => readAsarFile(asar, "missing.txt"), /missing\.txt not found/);
});

test("appVersion reads the Windows version from app.asar's package.json, the macOS one from Info.plist", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-layout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const windows = fakeInstall(join(dir), "0.12.0", "win32");
  assert.equal(appVersion(windows.app, "win32"), "0.12.0");
  assert.equal(appExecutable(windows.app, "win32"), windows.execPath);

  const mac = fakeInstall(join(dir), "0.11.0-beta.3", "darwin");
  assert.equal(appVersion(mac.app, "darwin"), "0.11.0-beta.3");
});

test(
  "appVersion reads the installed Windows Paseo's real app.asar",
  { skip: existsSync(join(stockWindowsPaseo, "resources", "app.asar")) ? false : "no Paseo in Program Files" },
  () => {
    assert.match(appVersion(stockWindowsPaseo, "win32"), /^\d+\.\d+\.\d+/);
  },
);

test("assertWindowsBlurSupported accepts Windows 11 22H2 and later, refuses older builds and Windows 10", () => {
  assert.doesNotThrow(() => assertWindowsBlurSupported("10.0.22621"));
  assert.doesNotThrow(() => assertWindowsBlurSupported("10.0.26300"));
  assert.throws(() => assertWindowsBlurSupported("10.0.22000"), /Windows 11 22H2 \(build 22621\) or later.*10\.0\.22000/);
  assert.throws(() => assertWindowsBlurSupported("10.0.19045"), /22H2/);
  assert.throws(() => assertWindowsBlurSupported("not-a-release"), /22H2/);
});
