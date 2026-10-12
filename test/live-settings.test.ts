import { test } from "node:test";
import assert from "node:assert/strict";

import { VIBRANCY_DEFAULTS } from "../shared/vibrancy.ts";
import { vibrancyCssVars } from "../client/live-settings.ts";

test("vibrancyCssVars maps defaults to a plain tint string and a transparent pane", () => {
  assert.deepEqual(vibrancyCssVars({ ...VIBRANCY_DEFAULTS }), {
    "--paseo-tint": "0.85",
    "--paseo-pane-bg": "transparent",
  });
});

test("vibrancyCssVars falls back to the surface1 token when paneGlass is off", () => {
  assert.deepEqual(vibrancyCssVars({ ...VIBRANCY_DEFAULTS, paneGlass: false }), {
    "--paseo-tint": "0.85",
    "--paseo-pane-bg": "var(--colors-surface1)",
  });
});
