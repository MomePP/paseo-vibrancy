import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  /** Options of every `dialog.showMessageBox` call, in order. */
  dialogs: Array<{ message: string; buttons: string[]; cancelId: number }>;
  /** The button index the next message box resolves with. */
  dialogResponse: number;
  fireWebContentsCreated: (contents: { getType: () => string; session: EventEmitter }) => void;
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

type Rect = { x: number; y: number; width: number; height: number };

/** One display; `workArea` equal to `bounds` is what an auto-hide taskbar gives. */
type Display = { bounds: Rect; workArea: Rect };

const FULL_HD: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

// Evaluates PV_JS in a fresh vm context against a real settings directory
// (real fs + real fs.watch) with fake electron/process.dlopen, as `platform`.
function loadPvJs(
  userDataDir: string,
  watchers: FSWatcher[],
  platform: HostPlatform = "darwin",
  display: Display = { bounds: FULL_HD, workArea: { ...FULL_HD, height: 1032 } },
): Sandbox {
  const windows: FakeWindow[] = [];
  const blurCalls: BlurCall[] = [];
  const createdListeners: Listener[] = [];
  const webContentsListeners: Listener[] = [];

  const fakeElectron = {
    app: {
      getPath: (_name: string) => userDataDir,
      on: (event: string, listener: Listener) => {
        if (event === "browser-window-created") {
          createdListeners.push(listener);
        } else if (event === "web-contents-created") {
          webContentsListeners.push(listener);
        }
      },
    },
    BrowserWindow: {
      getAllWindows: () => windows,
      getFocusedWindow: () => windows[0] ?? null,
    },
    dialog: {
      showMessageBox: (...args: unknown[]) => {
        sandbox.dialogs.push(args.at(-1) as Sandbox["dialogs"][number]);
        return Promise.resolve({ response: sandbox.dialogResponse });
      },
    },
    screen: {
      getDisplayMatching: (_rect: Rect) => display,
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
    dialogs: [],
    dialogResponse: 0,
    fireWebContentsCreated: (contents) => {
      for (const listener of webContentsListeners) {
        listener({}, contents);
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

/** A Windows window with real bounds and events, as Electron gives `pv.js`: `setBounds` moves it, events reach listeners. */
function makeSizedWindow(bounds: Rect): FakeWindow & EventEmitter & {
  bounds: Rect;
  getBounds: () => Rect;
  setBounds: (next: Rect) => void;
  isMaximized?: () => boolean;
  getNormalBounds?: () => Rect;
  maximize?: () => void;
  unmaximize?: () => void;
  events: string[];
} {
  // makeWindow's own `on` only tracks "show"; the EventEmitter's takes its place.
  const { on: _showOnly, ...base } = makeWindow();
  const win = Object.assign(new EventEmitter(), base, {
    bounds: { ...bounds },
    events: [] as string[],
    getBounds: () => ({ ...win.bounds }),
    setBounds: (next: Rect) => {
      win.bounds = { ...next };
    },
  });
  for (const name of ["maximize", "unmaximize"]) {
    win.on(name, () => win.events.push(name));
  }
  return win;
}

const NORMAL: Rect = { x: 200, y: 100, width: 1200, height: 800 };

test("Windows, auto-hide taskbar: maximize leaves the bottom 2 px free so the taskbar can still slide up", (t) => {
  const { dir, watchers } = settingsDir(t);
  const sandbox = loadPvJs(dir, watchers, "win32", { bounds: FULL_HD, workArea: FULL_HD });
  const win = makeSizedWindow(NORMAL);
  sandbox.fireBrowserWindowCreated(win);

  win.maximize!();

  assert.deepEqual(win.bounds, { x: 0, y: 0, width: 1920, height: 1078 });
  assert.equal(win.isMaximized!(), true);
  assert.deepEqual(win.getNormalBounds!(), NORMAL, "Paseo saves these as the size to restore to");
  assert.deepEqual(win.events, ["maximize"]);

  win.maximize!();
  win.unmaximize!();

  assert.deepEqual(win.bounds, NORMAL);
  assert.equal(win.isMaximized!(), false);
  assert.deepEqual(win.events, ["maximize", "unmaximize"]);
});

test("Windows, visible taskbar: maximize fills the work area exactly", (t) => {
  const { dir, watchers } = settingsDir(t);
  const workArea = { ...FULL_HD, height: 1032 };
  const sandbox = loadPvJs(dir, watchers, "win32", { bounds: FULL_HD, workArea });
  const win = makeSizedWindow(NORMAL);
  sandbox.fireBrowserWindowCreated(win);

  win.maximize!();

  assert.deepEqual(win.bounds, workArea);
});

test("Windows: dragging a maximized window by hand leaves it unmaximized", (t) => {
  const { dir, watchers } = settingsDir(t);
  const sandbox = loadPvJs(dir, watchers, "win32", { bounds: FULL_HD, workArea: FULL_HD });
  const win = makeSizedWindow(NORMAL);
  sandbox.fireBrowserWindowCreated(win);
  win.maximize!();

  win.emit("resized");
  assert.equal(win.isMaximized!(), true, "an end-of-drag event with the maximized bounds changes nothing");

  win.bounds = { x: 50, y: 40, width: 1000, height: 700 };
  win.emit("moved");

  assert.equal(win.isMaximized!(), false);
  assert.deepEqual(win.getNormalBounds!(), { x: 50, y: 40, width: 1000, height: 700 });
  assert.deepEqual(win.events, ["maximize", "unmaximize"]);
});

test("macOS: maximize is left to Electron", (t) => {
  const { dir, watchers } = settingsDir(t);
  const sandbox = loadPvJs(dir, watchers, "darwin");
  const win = makeSizedWindow(NORMAL);
  sandbox.fireBrowserWindowCreated(win);

  assert.equal(win.maximize, undefined);
  assert.equal(win.isMaximized, undefined);
});

const GOGO_BOARD = { deviceId: "gogo", name: "GoGo Board 7", vendorId: 0x0461, productId: 0x0020 };
const KEYPAD = { deviceId: "keypad", name: "", vendorId: 0x046d, productId: 0xc31c };

/** Emits `select-hid-device` as Electron does for a page's `requestDevice`; resolves with what `callback` got. */
function requestHidDevice(session: EventEmitter, deviceList: unknown[]): Promise<{ defaultPrevented: boolean; args: unknown[] }> {
  const { promise, resolve } = Promise.withResolvers<{ defaultPrevented: boolean; args: unknown[] }>();
  const event = { defaultPrevented: false, preventDefault: () => (event.defaultPrevented = true) };
  const details = { deviceList, frame: { origin: "https://code.gogoboard.org" } };
  session.emit("select-hid-device", event, details, (...args: unknown[]) => resolve({ defaultPrevented: event.defaultPrevented, args }));
  return promise;
}

test("WebHID in a browser tab: the device the user picks is granted", async (t) => {
  const { dir, watchers } = settingsDir(t);
  const sandbox = loadPvJs(dir, watchers);
  const session = new EventEmitter();
  sandbox.fireWebContentsCreated({ getType: () => "webview", session });
  sandbox.dialogResponse = 1;

  const result = await requestHidDevice(session, [KEYPAD, GOGO_BOARD]);

  assert.equal(result.defaultPrevented, true);
  assert.deepEqual(result.args, ["gogo"]);
  assert.deepEqual(sandbox.dialogs[0].buttons, ["Unknown device (046d:c31c)", "GoGo Board 7 (0461:0020)", "Cancel"]);
  assert.match(sandbox.dialogs[0].message, /^https:\/\/code\.gogoboard\.org /);
});

test("WebHID in a browser tab: Cancel grants nothing", async (t) => {
  const { dir, watchers } = settingsDir(t);
  const sandbox = loadPvJs(dir, watchers);
  const session = new EventEmitter();
  sandbox.fireWebContentsCreated({ getType: () => "webview", session });
  sandbox.dialogResponse = 1;

  const result = await requestHidDevice(session, [GOGO_BOARD]);

  assert.equal(sandbox.dialogs[0].cancelId, 1);
  assert.deepEqual(result.args, []);
});

test("WebHID: tabs sharing a session ask once per request; Paseo's own window gets no chooser", async (t) => {
  const { dir, watchers } = settingsDir(t);
  const sandbox = loadPvJs(dir, watchers);
  const tabs = new EventEmitter();
  const paseoWindow = new EventEmitter();
  sandbox.fireWebContentsCreated({ getType: () => "webview", session: tabs });
  sandbox.fireWebContentsCreated({ getType: () => "webview", session: tabs });
  sandbox.fireWebContentsCreated({ getType: () => "window", session: paseoWindow });

  await requestHidDevice(tabs, [GOGO_BOARD]);

  assert.equal(sandbox.dialogs.length, 1);
  assert.equal(paseoWindow.listenerCount("select-hid-device"), 0);
});
