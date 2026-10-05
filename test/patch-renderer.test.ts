import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { patchIndexHtml, patchRenderer, rendererPath } from "../server/patch-renderer.ts";
import { PatchCountError } from "../server/patch-engine.ts";
import { BUILD_TABLES, PANE, SCRIM_COLOURS } from "../server/renderer-patches.ts";
import type { TermMetrics } from "../server/ghostty.ts";

const DEFAULT_TERM: TermMetrics = {
  fontSize: 13.5,
  lineHeight: 1.1,
  padding: "0 0 0 10px",
  cursorStyle: "bar",
  fontFamily: null,
  fontWeight: 400,
  fontWeightBold: 600,
  ansi: "oxocarbon",
};

const STOCK_ANSI_TEXT = '{red:"#e07070",green:"#5dba80",yellow:"#e0c070",brightWhite:"#ffffff"}';

test("patchRenderer replaces the stock ANSI palette when ansi is oxocarbon", () => {
  const { src, notes } = patchRenderer(STOCK_ANSI_TEXT, DEFAULT_TERM);
  assert.ok(!src.includes('red:"#e07070"'));
  assert.ok(notes.some((n) => n.startsWith("ok      oxocarbon ANSI")));
});

test("patchRenderer leaves the stock ANSI palette alone, with no MISSED note for it, when ansi is paseo", () => {
  const { src, notes } = patchRenderer(STOCK_ANSI_TEXT, { ...DEFAULT_TERM, ansi: "paseo" });
  assert.ok(src.includes(STOCK_ANSI_TEXT));
  assert.ok(!notes.some((n) => n.includes("oxocarbon ANSI")));
});

test("patchRenderer clears the react-navigation backdrop to the live pane var", () => {
  const { src, notes } = patchRenderer("x background:'rgb(242, 242, 242)' y", DEFAULT_TERM);
  assert.ok(src.includes('background:"var(--paseo-pane-bg, transparent)"'));
  assert.ok(notes.some((n) => n.startsWith("ok      react-navigation backdrop")));
});

test("patchRenderer throws PatchCountError when a target appears the wrong number of times", () => {
  const src = "allowTransparency:!1 allowTransparency:!1";
  assert.throws(() => patchRenderer(src, DEFAULT_TERM), PatchCountError);
});

test("patchRenderer applies xterm allowTransparency and records a MISSED note for absent anchors", () => {
  const { src, notes } = patchRenderer("allowTransparency:!1", DEFAULT_TERM);
  assert.ok(src.includes("allowTransparency:!0"));
  assert.ok(notes.some((n) => n.startsWith("MISSED")));
});

test("patchRenderer substitutes an explicit font family and size into terminal metrics (both sites)", () => {
  const src =
    'cursorStyle:"bar",fontFamily:(0,a.resolveTerminalFontFamily)(b.fontFamily),fontSize:(0,a.resolveTerminalFontSize)(b.fontSize),lineHeight:1,' +
    "c.options.fontFamily=(0,a.resolveTerminalFontFamily)(b.fontFamily),c.options.fontSize=(0,a.resolveTerminalFontSize)(b.fontSize)";
  const term: TermMetrics = { ...DEFAULT_TERM, fontFamily: "Maple Mono NF", fontSize: 14 };
  const { src: patched, notes } = patchRenderer(src, term);
  assert.ok(patched.includes('fontFamily:"Maple Mono NF"'));
  assert.ok(patched.includes("fontSize:14"));
  assert.ok(patched.includes("fontWeight:400,fontWeightBold:600,"));
  assert.ok(patched.includes('c.options.fontFamily="Maple Mono NF"'));
  assert.ok(patched.includes("c.options.fontSize=14"));
  assert.ok(notes.some((n) => n.startsWith("ok      terminal metrics (")));
  assert.ok(notes.some((n) => n.startsWith("ok      terminal metrics (settings sync)")));
});

test("patchRenderer skips the settings-sync site when fontFamily and fontSize are both null", () => {
  const src =
    'cursorStyle:"bar",fontFamily:(0,a.resolveTerminalFontFamily)(b.fontFamily),fontSize:(0,a.resolveTerminalFontSize)(b.fontSize),lineHeight:1,';
  const term: TermMetrics = { ...DEFAULT_TERM, fontFamily: null, fontSize: null };
  const { notes } = patchRenderer(src, term);
  assert.ok(!notes.some((n) => n.includes("settings sync")));
});

test("rendererPath resolves the single hashed bundle index.html references", () => {
  const app = mkdtempSync(join(tmpdir(), "vibrancy-renderer-path-"));
  try {
    const webDist = join(app, "Contents", "Resources", "app-dist");
    const jsDir = join(webDist, "_expo", "static", "js", "web");
    mkdirSync(jsDir, { recursive: true });
    writeFileSync(join(webDist, "index.html"), '<script src="/_expo/static/js/web/index-abc123.js"></script>');
    writeFileSync(join(jsDir, "index-abc123.js"), "// bundle");
    assert.equal(rendererPath(app), join(jsDir, "index-abc123.js"));
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test("rendererPath throws when index.html references a bundle missing on disk", () => {
  const app = mkdtempSync(join(tmpdir(), "vibrancy-renderer-path-"));
  try {
    const webDist = join(app, "Contents", "Resources", "app-dist");
    mkdirSync(webDist, { recursive: true });
    writeFileSync(join(webDist, "index.html"), '<script src="/_expo/static/js/web/index-abc123.js"></script>');
    assert.throws(() => rendererPath(app), /missing on disk/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test("patchIndexHtml rewrites the flash guard into the live color-mix wash and injects the opaque-surfaces style", () => {
  const html = "<head><style>html,\n body { background-color: #181b1a; }</style></head>";
  const { html: patched, notes } = patchIndexHtml(html, "0 0 0 10px");
  assert.ok(
    patched.includes(
      "body { background-color: color-mix(in srgb, var(--colors-surface1, #181b1a) calc(var(--paseo-tint, 0.85) * 100%), transparent);",
    ),
  );
  assert.ok(patched.indexOf('<style id="paseo-vibrancy-opaque-surfaces">') < patched.indexOf("</head>"));
  assert.ok(patched.includes("padding: 0 0 0 10px;"));
  assert.deepEqual(notes, ["ok      window wash (1x)", "ok      opaque floating surfaces (1x)"]);
});

test("patchIndexHtml reports a MISSED note when the flash guard is absent, without skipping the style injection", () => {
  const { notes } = patchIndexHtml("<head></head>", "0 0 0 10px");
  assert.ok(notes[0]!.startsWith("MISSED  window wash"));
  assert.ok(notes[1]!.startsWith("ok      opaque floating surfaces"));
});

test("patchRenderer swaps the resize handle's accent to the subtle token in both occurrences", () => {
  const src =
    '[h.highlight,"horizontal"===v?h.highlightHorizontal:h.highlightVertical,' +
    "{backgroundColor:t.colors.accent}],[v,t.colors.accent]";
  const { src: patched, notes } = patchRenderer(src, DEFAULT_TERM);
  assert.ok(patched.includes("{backgroundColor:t.colors.surface4}],[v,t.colors.surface4]"));
  assert.ok(!patched.includes("t.colors.accent"));
  assert.ok(notes.some((n) => n.startsWith("ok      subtle resize handle")));
});

test("patchRenderer patches the synced loader tick and kick behind a long word run in well under a second", () => {
  // 80k chars took the unanchored patterns ~6 s each; anchored they take < 1 ms.
  const src =
    "x".repeat(80_000) +
    ";a.value!==b&&(a.value=b),requestAnimationFrame(c);d.value=e.value,requestAnimationFrame(f)";
  const started = performance.now();
  const { src: patched, notes } = patchRenderer(src, DEFAULT_TERM);
  const elapsed = performance.now() - started;
  assert.ok(patched.endsWith(";a.value!==b&&(a.value=b),setTimeout(c,80);d.value=e.value,setTimeout(f,80)"));
  assert.ok(notes.includes("ok      idle frame rate: synced loader tick (1x)"));
  assert.ok(notes.includes("ok      idle frame rate: synced loader kick (1x)"));
  assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
});

test("SCRIM_COLOURS.replacement is baked from PANE, not a dead placeholder", () => {
  assert.notEqual(SCRIM_COLOURS.replacement, "");
  assert.ok(String(SCRIM_COLOURS.replacement).includes(PANE));
});

test("every BUILD_TABLES patch entry's replacement is a plain string, never a function", () => {
  // BUILD_TABLES is the only input the build fingerprint hashes; a
  // function-valued replacement's actual output would be invisible to it, so
  // a rewrite of the function body would leave the fingerprint unchanged.
  function checkEntry(entry: unknown): void {
    if (!entry || typeof entry !== "object" || !("replacement" in entry)) {
      return;
    }
    const label = "label" in entry ? entry.label : undefined;
    assert.equal(
      typeof entry.replacement,
      "string",
      `${JSON.stringify(label ?? entry)} has a non-string replacement`,
    );
  }

  for (const value of Object.values(BUILD_TABLES)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        checkEntry(entry);
      }
    } else {
      checkEntry(value);
    }
  }
});
