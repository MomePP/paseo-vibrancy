import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import vm from "node:vm";

import { PV_JS } from "../server/main-hook.ts";
import type { HostPlatform } from "../shared/platform.ts";

type Listener = (...args: unknown[]) => void;

interface FakeWindow {
  setVibrancy: (material: string | null) => void;
  setBackgroundMaterial: (material: string) => void;
  getNativeWindowHandle: () => Buffer;
  vibrancyCalls: Array<string | null>;
  materialCalls: string[];
  on: (event: string, listener: Listener) => void;
  fireShow: () => void;
}

interface BlurCall {
  handle: Buffer;
  radius: number;
}

interface Sandbox {
  windows: FakeWindow[];
  blurCalls: BlurCall[];
  dlopened: boolean;
  createdListeners: Listener[];
  module: { exports: unknown };
  fireBrowserWindowCreated: (win: FakeWindow) => void;
}

function makeWindow(): FakeWindow {
  const showListeners: Listener[] = [];
  const win: FakeWindow = {
    vibrancyCalls: [],
    materialCalls: [],
    setVibrancy: (material) => win.vibrancyCalls.push(material),
    setBackgroundMaterial: (material) => win.materialCalls.push(material),
    getNativeWindowHandle: () => Buffer.alloc(8),
    on: (event, listener) => {
      if (event === "show") {
        showListeners.push(listener);
      }
    },
    fireShow: () => {
      for (const listener of showListeners) {
        listener();
      }
    },
  };
  return win;
}

/** A settings dir that closes PV_JS's watchers before removing it: an open watcher on Windows keeps the test process alive. */
function settingsDir(t: { after: (fn: () => void) => void }): { dir: string; watchers: FSWatcher[] } {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-pv-"));
  const watchers: FSWatcher[] = [];
  t.after(() => {
    for (const watcher of watchers) {
      watcher.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, watchers };
}

// Evaluates PV_JS in a fresh vm context against a real settings directory
// (real fs + real fs.watch) with fake electron/process.dlopen, as `platform`.
function loadPvJs(userDataDir: string, watchers: FSWatcher[], platform: HostPlatform = "darwin"): Sandbox {
  const windows: FakeWindow[] = [];
  const blurCalls: BlurCall[] = [];
  const createdListeners: Listener[] = [];

  const fakeElectron = {
    app: {
      getPath: (_name: string) => userDataDir,
      on: (event: string, listener: Listener) => {
        if (event === "browser-window-created") {
          createdListeners.push(listener);
        }
      },
    },
    BrowserWindow: {
      getAllWindows: () => windows,
    },
  };

  const trackedWatch = ((...args: Parameters<typeof watch>) => {
    const watcher = watch(...args);
    watchers.push(watcher);
    return watcher;
  }) as typeof watch;

  const fakeRequire = (name: string) => {
    if (name === "electron") return fakeElectron;
    if (name === "fs") return { readFileSync, watch: trackedWatch };
    if (name === "path") return { join, dirname, basename };
    throw new Error(`unexpected require: ${name}`);
  };

  const sandbox: Sandbox = {
    windows,
    blurCalls,
    dlopened: false,
    createdListeners,
    module: { exports: {} },
    fireBrowserWindowCreated: (win) => {
      windows.push(win);
      for (const listener of createdListeners) {
        listener({}, win);
      }
    },
  };

  const fakeProcess = {
    platform,
    dlopen: (addonModule: { exports: Record<string, unknown> }, _filename: string) => {
      sandbox.dlopened = true;
      addonModule.exports.setBlur = (handle: Buffer, radius: number) => {
        blurCalls.push({ handle, radius });
      };
    },
  };

  const context = vm.createContext({
    module: sandbox.module,
    exports: sandbox.module.exports,
    require: fakeRequire,
    process: fakeProcess,
    __dirname: userDataDir,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(PV_JS, context);

  return sandbox;
}

/**
 * Rewrites `payload` to the settings file until `done()` holds or 2 s pass.
 * Real waits (not fake timers): PV_JS's own fs.watch + 50 ms debounce run on
 * the host event loop inside a vm context we don't control the clock of.
 * macOS's FSEvents-backed fs.watch can also miss a write that lands before
 * the watch stream has finished arming, so the write is reissued every
 * 200 ms rather than relying on the very first write landing.
 */
async function writeUntil(settingsFile: string, payload: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  let lastWriteAt = 0;
  while (!done() && Date.now() < deadline) {
    if (Date.now() - lastWriteAt >= 200) {
      writeFileSync(settingsFile, payload);
      lastWriteAt = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("applies blur 30 with no material by default (no settings file)", (t) => {
  const { dir, watchers } = settingsDir(t);

  const sandbox = loadPvJs(dir, watchers);
  const win = makeWindow();
  sandbox.fireBrowserWindowCreated(win);

  assert.deepEqual(win.vibrancyCalls, [null]);
  assert.equal(sandbox.blurCalls.at(-1)?.radius, 30);
});

test("re-applies vibrancy when a window emits show (not yet ordered on screen at creation)", (t) => {
  const { dir, watchers } = settingsDir(t);

  const sandbox = loadPvJs(dir, watchers);
  const win = makeWindow();
  sandbox.fireBrowserWindowCreated(win);
  sandbox.blurCalls.length = 0;
  win.vibrancyCalls.length = 0;

  win.fireShow();

  assert.deepEqual(win.vibrancyCalls, [null]);
  assert.equal(sandbox.blurCalls.at(-1)?.radius, 30);
});

test("material switches off blur", (t) => {
  const { dir, watchers } = settingsDir(t);
  writeFileSync(join(dir, "paseo-vibrancy.json"), JSON.stringify({ material: "hud" }));

  const sandbox = loadPvJs(dir, watchers);
  const win = makeWindow();
  sandbox.fireBrowserWindowCreated(win);

  assert.deepEqual(win.vibrancyCalls, ["hud"]);
  assert.equal(sandbox.blurCalls.at(-1)?.radius, 0);
});

test("terminal fields in the settings file are ignored by the main-process hook", (t) => {
  const { dir, watchers } = settingsDir(t);
  writeFileSync(
    join(dir, "paseo-vibrancy.json"),
    JSON.stringify({ material: "hud", terminal: { ansi: "paseo", fontSize: null, paddingLeft: 30 } }),
  );

  const sandbox = loadPvJs(dir, watchers);
  const win = makeWindow();
  sandbox.fireBrowserWindowCreated(win);

  assert.deepEqual(win.vibrancyCalls, ["hud"]);
  assert.equal(sandbox.blurCalls.at(-1)?.radius, 0);
});

test("corrupt settings file falls back to defaults", (t) => {
  const { dir, watchers } = settingsDir(t);
  writeFileSync(join(dir, "paseo-vibrancy.json"), "{nope");

  const sandbox = loadPvJs(dir, watchers);
  const win = makeWindow();
  sandbox.fireBrowserWindowCreated(win);

  assert.deepEqual(win.vibrancyCalls, [null]);
  assert.equal(sandbox.blurCalls.at(-1)?.radius, 30);
});

test("file change re-applies to open windows", async (t) => {
  const { dir, watchers } = settingsDir(t);

  const sandbox = loadPvJs(dir, watchers);
  const win = makeWindow();
  sandbox.fireBrowserWindowCreated(win);

  await writeUntil(join(dir, "paseo-vibrancy.json"), JSON.stringify({ material: "sidebar" }), () => win.vibrancyCalls.at(-1) === "sidebar");

  assert.equal(
    win.vibrancyCalls.at(-1),
    "sidebar",
    `timed out after 2s waiting for the debounced fs.watch re-apply; calls so far: ${JSON.stringify(win.vibrancyCalls)}`,
  );
});

test("module export is true", (t) => {
  const { dir, watchers } = settingsDir(t);

  const sandbox = loadPvJs(dir, watchers);
  assert.equal(sandbox.module.exports, true);
});

test("Windows: acrylic background material by default, on creation and again on show, with no blur addon", (t) => {
  const { dir, watchers } = settingsDir(t);

  const sandbox = loadPvJs(dir, watchers, "win32");
  const win = makeWindow();
  sandbox.fireBrowserWindowCreated(win);
  win.fireShow();

  assert.deepEqual(win.materialCalls, ["acrylic", "acrylic"]);
  assert.deepEqual(win.vibrancyCalls, []);
  assert.equal(sandbox.dlopened, false);
  assert.equal(sandbox.module.exports, true);
});

test("Windows: a saved Windows material applies; a macOS-only one falls back to acrylic", (t) => {
  const { dir, watchers } = settingsDir(t);
  writeFileSync(join(dir, "paseo-vibrancy.json"), JSON.stringify({ material: "mica" }));
  const micaWin = makeWindow();
  loadPvJs(dir, watchers, "win32").fireBrowserWindowCreated(micaWin);

  writeFileSync(join(dir, "paseo-vibrancy.json"), JSON.stringify({ material: "sidebar" }));
  const macWin = makeWindow();
  loadPvJs(dir, watchers, "win32").fireBrowserWindowCreated(macWin);

  assert.deepEqual(micaWin.materialCalls, ["mica"]);
  assert.deepEqual(macWin.materialCalls, ["acrylic"]);
});

test("Windows: none turns the background material off", (t) => {
  const { dir, watchers } = settingsDir(t);
  writeFileSync(join(dir, "paseo-vibrancy.json"), JSON.stringify({ material: "none" }));

  const sandbox = loadPvJs(dir, watchers, "win32");
  const win = makeWindow();
  sandbox.fireBrowserWindowCreated(win);

  assert.deepEqual(win.materialCalls, ["none"]);
});

test("Windows: file change re-applies to open windows", async (t) => {
  const { dir, watchers } = settingsDir(t);

  const sandbox = loadPvJs(dir, watchers, "win32");
  const win = makeWindow();
  sandbox.fireBrowserWindowCreated(win);

  await writeUntil(join(dir, "paseo-vibrancy.json"), JSON.stringify({ material: "tabbed" }), () => win.materialCalls.at(-1) === "tabbed");

  assert.equal(win.materialCalls.at(-1), "tabbed", `calls so far: ${JSON.stringify(win.materialCalls)}`);
});
