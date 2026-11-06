import { GLASS_MATERIALS, MAC_MATERIALS, OPEN_FILES_IN_NEW_TAB_GLOBAL, WINDOWS_MATERIALS } from "../shared/vibrancy.ts";

/**
 * `PV_JS` is the CommonJS source written to the patched copy's resources
 * directory as `pv.js`. It is loaded by the asar hook line
 * (`server/asar.ts`'s `ASAR_HOOK_LINE`) while the first `BrowserWindow`'s
 * options object is still being evaluated — i.e. before any window exists —
 * so it runs entirely in Electron's main process and must be self-contained
 * (no requires of this plugin's modules; the shared names it needs are
 * interpolated into the source below). A throw at load time would break
 * Paseo's launch, so all load-time work is wrapped in a single try/catch and
 * the `module.exports` line runs regardless of what happens inside it.
 */

export const PV_JS = `"use strict";

var IS_WINDOWS = process.platform === "win32";

var MATERIALS = IS_WINDOWS ? ${JSON.stringify(WINDOWS_MATERIALS)} : ${JSON.stringify(MAC_MATERIALS)};

var GLASS_MATERIALS = ${JSON.stringify(GLASS_MATERIALS)};

var DEFAULTS = {
  material: IS_WINDOWS ? "acrylic" : "none",
  blurRadius: 30,
  tint: 0.85,
  paneGlass: true,
  openFilesInNewTab: false,
  webHidChooser: true,
};

function clampNumber(value, fallback, min, max) {
  if (typeof value !== "number" || !isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function parseVibrancy(raw) {
  var input = raw && typeof raw === "object" ? raw : {};
  return {
    material: MATERIALS.indexOf(input.material) !== -1 ? input.material : DEFAULTS.material,
    blurRadius: clampNumber(input.blurRadius, DEFAULTS.blurRadius, 0, 60),
    tint: clampNumber(input.tint, DEFAULTS.tint, 0, 1),
    paneGlass: typeof input.paneGlass === "boolean" ? input.paneGlass : DEFAULTS.paneGlass,
    openFilesInNewTab: typeof input.openFilesInNewTab === "boolean" ? input.openFilesInNewTab : DEFAULTS.openFilesInNewTab,
    webHidChooser: typeof input.webHidChooser === "boolean" ? input.webHidChooser : DEFAULTS.webHidChooser,
  };
}

try {
  var electron = require("electron");
  var app = electron.app;
  var BrowserWindow = electron.BrowserWindow;
  var fs = require("fs");
  var path = require("path");

  var blur = null;
  if (!IS_WINDOWS) {
    try {
      var blurModule = { exports: {} };
      process.dlopen(blurModule, path.join(__dirname, "blur.node"));
      blur = blurModule.exports;
    } catch (dlopenErr) {
      console.error("[paseo-vibrancy] failed to load blur.node", dlopenErr);
      blur = null;
    }
  }

  function setBlur(handle, radius) {
    if (blur && typeof blur.setBlur === "function") {
      try {
        blur.setBlur(handle, radius);
      } catch (setBlurErr) {
        /* ignore — blur is best-effort */
      }
    }
  }

  function matchCorners(handle) {
    if (blur && typeof blur.matchCorners === "function") {
      try {
        blur.matchCorners(handle);
      } catch (matchCornersErr) {
        /* ignore — best-effort, like blur */
      }
    }
  }

  function setGlass(handle, variant) {
    if (blur && typeof blur.setGlass === "function") {
      try {
        return blur.setGlass(handle, variant);
      } catch (setGlassErr) {
      }
    }
    return false;
  }

  var settingsPath = path.join(app.getPath("userData"), "paseo-vibrancy.json");

  function readSettings() {
    try {
      var raw = fs.readFileSync(settingsPath, "utf8");
      return parseVibrancy(JSON.parse(raw));
    } catch (readErr) {
      return parseVibrancy({});
    }
  }

  var current = readSettings();

  function apply(win) {
    if (IS_WINDOWS) {
      if (win && typeof win.setBackgroundMaterial === "function") {
        win.setBackgroundMaterial(current.material);
      }
      return;
    }
    if (!win || typeof win.setVibrancy !== "function") {
      return;
    }
    var handle = win.getNativeWindowHandle();
    matchCorners(handle);
    var variant = GLASS_MATERIALS.indexOf(current.material);
    var glassShown = setGlass(handle, variant);
    if (variant !== -1) {
      win.setVibrancy(null);
      setBlur(handle, glassShown ? 0 : current.blurRadius);
    } else if (current.material !== "none") {
      win.setVibrancy(current.material);
      setBlur(handle, 0);
    } else {
      win.setVibrancy(null);
      setBlur(handle, current.blurRadius);
    }
  }

  var NEW_TAB_GLOBAL = ${JSON.stringify(OPEN_FILES_IN_NEW_TAB_GLOBAL)};

  function rendererScript(settings) {
    return (
      "(function () {" +
      "var style = document.documentElement.style;" +
      "style.setProperty('--paseo-tint', " + JSON.stringify(String(settings.tint)) + ");" +
      "style.setProperty('--paseo-pane-bg', " +
      JSON.stringify(settings.paneGlass ? "transparent" : "var(--colors-surface1)") +
      ");" +
      "globalThis[" + JSON.stringify(NEW_TAB_GLOBAL) + "] = " + JSON.stringify(settings.openFilesInNewTab) + ";" +
      "})();"
    );
  }

  function applyRenderer(win) {
    var contents = win && win.webContents;
    if (!contents || typeof contents.executeJavaScript !== "function") {
      return;
    }
    try {
      contents.executeJavaScript(rendererScript(current)).catch(function () {});
    } catch (executeErr) {}
  }

  app.on("browser-window-created", function (_event, win) {
    apply(win);
    // Paseo creates its main window with show: false and shows it on
    // ready-to-show; an NSWindow that has never been ordered on screen
    // has no window-server number yet, so the blur call issued above
    // targets nothing. Re-apply once the window actually appears.
    if (win && typeof win.on === "function") {
      win.on("show", function () {
        apply(win);
      });
    }
    if (win && win.webContents && typeof win.webContents.on === "function") {
      win.webContents.on("dom-ready", function () {
        applyRenderer(win);
      });
    }
  });

  // Electron leaves the WebHID chooser to the app: without a
  // select-hid-device handler, navigator.hid.requestDevice() resolves to []
  // and no picker appears. Paseo's browser tabs are <webview> guests, so
  // each guest session gets a native chooser listing the devices the page's
  // filters matched. Only the device the user picks is granted. With
  // webHidChooser off the event is left unhandled, which Electron cancels:
  // stock behaviour. The setting is read per request, so the toggle is live.
  var hidSessions = new WeakSet();

  function frameOrigin(frame) {
    try {
      return frame && frame.origin ? frame.origin : "This page";
    } catch (originErr) {
      return "This page";
    }
  }

  function chooseHidDevice(event, details, callback) {
    if (!current.webHidChooser) {
      return;
    }
    event.preventDefault();
    var devices = details.deviceList || [];
    var options = {
      type: "question",
      message: frameOrigin(details.frame) + " wants to connect to a HID device",
      detail: devices.length ? "Choose a device." : "No compatible device is connected.",
      buttons: devices
        .map(function (device) {
          var ids = device.vendorId.toString(16).padStart(4, "0") + ":" + device.productId.toString(16).padStart(4, "0");
          return (device.name || "Unknown device") + " (" + ids + ")";
        })
        .concat(["Cancel"]),
      defaultId: 0,
      cancelId: devices.length,
      noLink: true,
    };
    var parent = BrowserWindow.getFocusedWindow();
    var shown = parent ? electron.dialog.showMessageBox(parent, options) : electron.dialog.showMessageBox(options);
    shown.then(
      function (result) {
        var device = devices[result.response];
        if (device) {
          callback(device.deviceId);
        } else {
          callback();
        }
      },
      function () {
        callback();
      },
    );
  }

  app.on("web-contents-created", function (_event, contents) {
    if (contents.getType() !== "webview" || hidSessions.has(contents.session)) {
      return;
    }
    hidSessions.add(contents.session);
    contents.session.on("select-hid-device", chooseHidDevice);
  });

  var watchTimer = null;
  try {
    var watcher = fs.watch(path.dirname(settingsPath), function (_eventType, filename) {
      if (filename !== path.basename(settingsPath)) {
        return;
      }
      clearTimeout(watchTimer);
      watchTimer = setTimeout(function () {
        current = readSettings();
        BrowserWindow.getAllWindows().forEach(function (win) {
          apply(win);
          applyRenderer(win);
        });
      }, 50);
    });
    if (watcher && typeof watcher.unref === "function") {
      watcher.unref();
    }
  } catch (watchErr) {
    /* ignore — directory may not exist yet */
  }
} catch (loadErr) {
  console.error("[paseo-vibrancy] load-time failure, Paseo will still launch", loadErr);
}

// The export is the window's \`transparent\` option. Windows' backdrop materials
// need no transparency, and a transparent window loses WS_THICKFRAME: snap,
// edge resize, native maximize and rounded corners.
module.exports = !IS_WINDOWS;
`;
