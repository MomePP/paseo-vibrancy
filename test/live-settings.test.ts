import { test } from "node:test";
import assert from "node:assert/strict";

import { VIBRANCY_DEFAULTS } from "../shared/vibrancy.ts";
import { applyLiveSettings, vibrancyCssVars } from "../client/live-settings.ts";

const FLAG = "__paseoOpenFilesInNewTab";
const flags = globalThis as Record<string, unknown>;

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

test("applyLiveSettings publishes openFilesInNewTab to the global the renderer guard reads", () => {
  try {
    applyLiveSettings({ ...VIBRANCY_DEFAULTS, openFilesInNewTab: true });
    assert.equal(flags[FLAG], true);
    applyLiveSettings({ ...VIBRANCY_DEFAULTS, openFilesInNewTab: false });
    assert.equal(flags[FLAG], false);
  } finally {
    delete flags[FLAG];
  }
});

test("applyLiveSettings sets the CSS vars on documentElement when a document exists", () => {
  const props: Record<string, string> = {};
  flags.document = { documentElement: { style: { setProperty: (k: string, v: string) => (props[k] = v) } } };
  try {
    applyLiveSettings({ ...VIBRANCY_DEFAULTS });
    assert.deepEqual(props, { "--paseo-tint": "0.85", "--paseo-pane-bg": "transparent" });
  } finally {
    delete flags.document;
    delete flags[FLAG];
  }
});
