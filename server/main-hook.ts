/**
 * `PV_JS` is the CommonJS source written to `Contents/Resources/pv.js` inside
 * the patched Paseo app bundle. It is loaded by the asar hook line
 * (`server/asar.ts`'s `ASAR_HOOK_LINE`) while the first `BrowserWindow`'s
 * options object is still being evaluated — i.e. before any window exists —
 * so it runs entirely in Electron's main process and must be self-contained
 * (no imports from this plugin; everything the script needs is inlined
 * below). A throw at load time would break Paseo's launch, so all load-time
 * work is wrapped in a single try/catch and `module.exports = true` is
 * guaranteed regardless of what happens inside it.
 */

export const PV_JS = `"use strict";

var MATERIALS = [
  "none",
  "sidebar",
  "hud",
  "under-window",
  "fullscreen-ui",
  "menu",
  "popover",
  "titlebar",
  "header",
  "sheet",
  "window",
  "content",
  "under-page",
  "selection",
  "tooltip",
];

var DEFAULTS = { material: "none", blurRadius: 30, tint: 0.85, paneGlass: true };

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
  };
}

try {
  var electron = require("electron");
  var app = electron.app;
  var BrowserWindow = electron.BrowserWindow;
  var fs = require("fs");
  var path = require("path");

  var blur = null;
  try {
    var blurModule = { exports: {} };
    process.dlopen(blurModule, path.join(__dirname, "blur.node"));
    blur = blurModule.exports;
  } catch (dlopenErr) {
    console.error("[paseo-vibrancy] failed to load blur.node", dlopenErr);
    blur = null;
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
    if (!win || typeof win.setVibrancy !== "function") {
      return;
    }
    matchCorners(win.getNativeWindowHandle());
    if (current.material !== "none") {
      win.setVibrancy(current.material);
      setBlur(win.getNativeWindowHandle(), 0);
    } else {
      win.setVibrancy(null);
      setBlur(win.getNativeWindowHandle(), current.blurRadius);
    }
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
        BrowserWindow.getAllWindows().forEach(apply);
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

module.exports = true;
`;
