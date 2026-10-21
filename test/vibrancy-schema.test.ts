import { test } from "node:test";
import assert from "node:assert/strict";

import { TERMINAL_DEFAULTS, VIBRANCY_DEFAULTS, parseVibrancy } from "../shared/vibrancy.ts";

test("parseVibrancy({}) deep-equals VIBRANCY_DEFAULTS", () => {
  assert.deepEqual(parseVibrancy({}), VIBRANCY_DEFAULTS);
});

test("parseVibrancy clamps out-of-range numeric fields", () => {
  const result = parseVibrancy({ blurRadius: 200, tint: -1 });
  assert.equal(result.blurRadius, 60);
  assert.equal(result.tint, 0);
});

test("parseVibrancy falls back to the platform's default material for unknown values", () => {
  assert.equal(parseVibrancy({ material: "bogus" }, "darwin").material, "none");
  assert.equal(parseVibrancy({ material: "bogus" }, "win32").material, "acrylic");
});

test("parseVibrancy keeps only the platform's own materials; the other OS's fall back to its default", () => {
  assert.equal(parseVibrancy({ material: "hud" }, "darwin").material, "hud");
  assert.equal(parseVibrancy({ material: "mica" }, "darwin").material, "none");
  assert.equal(parseVibrancy({ material: "mica" }, "win32").material, "mica");
  assert.equal(parseVibrancy({ material: "none" }, "win32").material, "none");
  assert.equal(parseVibrancy({ material: "hud" }, "win32").material, "acrylic");
  assert.equal(parseVibrancy("not json", "win32").material, "acrylic");
});

test("parseVibrancy never throws, returns defaults for non-object input", () => {
  assert.deepEqual(parseVibrancy("not json"), VIBRANCY_DEFAULTS);
});

test("parseVibrancy fills terminal defaults when terminal is missing or malformed", () => {
  assert.deepEqual(parseVibrancy({ material: "hud" }).terminal, TERMINAL_DEFAULTS);
  assert.deepEqual(parseVibrancy({ terminal: "nope" }).terminal, TERMINAL_DEFAULTS);
  assert.deepEqual(parseVibrancy({ terminal: null }).terminal, TERMINAL_DEFAULTS);
  assert.deepEqual(TERMINAL_DEFAULTS, {
    followGhostty: true,
    fontSize: 13.5,
    lineHeight: 1.1,
    fontWeight: 400,
    fontWeightBold: 600,
    cursorStyle: "bar",
    paddingLeft: 10,
    ansi: "oxocarbon",
  });
});

test("parseVibrancy clamps and rounds each terminal numeric", () => {
  const t = (terminal: Record<string, unknown>) => parseVibrancy({ terminal }).terminal;
  assert.equal(t({ fontSize: 2 }).fontSize, 8);
  assert.equal(t({ fontSize: 99 }).fontSize, 32);
  assert.equal(t({ fontSize: 13.3 }).fontSize, 13.5);
  assert.equal(t({ fontSize: null }).fontSize, null);
  assert.equal(t({ fontSize: "big" }).fontSize, 13.5);
  assert.equal(t({ lineHeight: 0.5 }).lineHeight, 1);
  assert.equal(t({ lineHeight: 5 }).lineHeight, 2);
  assert.equal(t({ lineHeight: 1.12 }).lineHeight, 1.1);
  assert.equal(t({ lineHeight: 1.13 }).lineHeight, 1.15);
  assert.equal(t({ fontWeight: 20 }).fontWeight, 100);
  assert.equal(t({ fontWeight: 1500 }).fontWeight, 900);
  assert.equal(t({ fontWeight: 449 }).fontWeight, 400);
  assert.equal(t({ fontWeightBold: 640 }).fontWeightBold, 600);
  assert.equal(t({ fontWeightBold: 9000 }).fontWeightBold, 900);
  assert.equal(t({ paddingLeft: -5 }).paddingLeft, 0);
  assert.equal(t({ paddingLeft: 100 }).paddingLeft, 40);
  assert.equal(t({ paddingLeft: 12.6 }).paddingLeft, 13);
});

test("parseVibrancy falls back per field for bad terminal enums and booleans", () => {
  const t = parseVibrancy({ terminal: { cursorStyle: "beam", ansi: "dracula", followGhostty: "yes", paddingLeft: 4 } }).terminal;
  assert.equal(t.cursorStyle, "bar");
  assert.equal(t.ansi, "oxocarbon");
  assert.equal(t.followGhostty, true);
  assert.equal(t.paddingLeft, 4);
});

test("parseVibrancy reads openFilesInNewTab, defaulting to false for missing or non-boolean values", () => {
  assert.equal(parseVibrancy({}).openFilesInNewTab, false);
  assert.equal(parseVibrancy({ openFilesInNewTab: true }).openFilesInNewTab, true);
  assert.equal(parseVibrancy({ openFilesInNewTab: "yes" }).openFilesInNewTab, false);
  assert.equal(parseVibrancy({ openFilesInNewTab: 1 }).openFilesInNewTab, false);
});
