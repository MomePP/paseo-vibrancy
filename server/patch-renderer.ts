/**
 * Ports `renderer_path`, `patch_renderer` and `patch_index_html` from the
 * former paseo-repatch script. Table/constant inputs live in
 * `./renderer-patches.ts`; term resolution lives in `./ghostty.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { TermMetrics } from "./ghostty.ts";
import { Patcher } from "./patch-engine.ts";
import {
  ALPHA_HELPER,
  BACKDROP_MASKS,
  DIFF_PALETTE,
  FRAME_RATE,
  FILE_TAB_REUSE,
  FLOATING_SURFACES_CSS,
  GLASS_SURFACES,
  HANDLE_HIGHLIGHT,
  HOVER_HIGHLIGHT,
  HTML_FLASH_GUARD,
  HTML_WASH_REPLACEMENT,
  INK_SURFACE0,
  KEBAB_CHIP,
  KEBAB_GUTTER,
  LABELS_LINE,
  NAVIGATOR_BACKDROP,
  PANE,
  RENDERER_PATCHES,
  SCRIM_COLOURS,
  STOCK_ANSI,
  SURFACE_PATCHES,
  TAB_GLASS,
  TERMINAL_METRICS,
  TERMINAL_METRICS_SYNC,
  WINDOW_CHROME_PAYLOAD,
} from "./renderer-patches.ts";

/**
 * The Expo bundle the app actually loads, resolved through index.html rather
 * than by globbing the directory: the filename carries a content hash that
 * changes every release, and a stale sibling left behind by an update would
 * otherwise be a silent no-op patch.
 */
export function rendererPath(app: string): string {
  const web = join(app, "Contents", "Resources", "app-dist");
  const html = readFileSync(join(web, "index.html"), "utf8");
  const names = [...new Set(Array.from(html.matchAll(/index-[0-9a-f]+\.js/g), (m) => m[0]))].sort();
  if (names.length !== 1) {
    throw new Error(`renderer: index.html references ${names.length} bundles, expected 1`);
  }
  const bundlePath = join(web, "_expo", "static", "js", "web", names[0]!);
  if (!existsSync(bundlePath)) {
    throw new Error(`renderer: ${names[0]} referenced by index.html but missing on disk`);
  }
  return bundlePath;
}

export function patchRenderer(src: string, term: TermMetrics): { src: string; notes: string[] } {
  const patcher = new Patcher(src);

  for (const { label, old, replacement, expect } of RENDERER_PATCHES) {
    patcher.replace(label, old, replacement, expect);
  }

  // Full scope only — the content pane is cleared, not painted opaque, so
  // PANE (a CSS var) is what both the navigator backdrop and the scrim
  // table's surface0 entry show through to.
  patcher.replace("react-navigation backdrop (full glass)", NAVIGATOR_BACKDROP, `background:${PANE}`, 1);

  if (term.ansi === "oxocarbon") {
    patcher.replaceRe(STOCK_ANSI.label, STOCK_ANSI.pattern, STOCK_ANSI.replacement, STOCK_ANSI.expect);
  }

  patcher.src = ALPHA_HELPER + patcher.src;
  patcher.notes.push("ok      alpha helper (1x)");

  for (const { label, pattern, replacement, expect } of SURFACE_PATCHES) {
    patcher.replaceRe(label, pattern, replacement, expect);
  }

  patcher.replaceRe(
    WINDOW_CHROME_PAYLOAD.label,
    WINDOW_CHROME_PAYLOAD.pattern,
    WINDOW_CHROME_PAYLOAD.replacement,
    WINDOW_CHROME_PAYLOAD.expect,
  );

  // JSON-quoted so a family list with spaces lands as one string literal.
  // `$1`/`$2` in the fallback text are backreferences into TERMINAL_METRICS'
  // own match, carrying the resolver call through unchanged.
  const family =
    term.fontFamily === null
      ? "(0,$1.resolveTerminalFontFamily)($2.fontFamily)"
      : JSON.stringify(term.fontFamily);
  const size =
    term.fontSize === null ? "(0,$1.resolveTerminalFontSize)($2.fontSize)" : String(term.fontSize);
  // Two keys rather than one: xterm reads fontWeight for normal text and
  // fontWeightBold for SGR 1, and how heavy a TUI looks is mostly the
  // second. Absent constants emit neither key, which is not the same as
  // writing xterm's own defaults back in.
  const weights = (
    [
      ["fontWeight", term.fontWeight],
      ["fontWeightBold", term.fontWeightBold],
    ] as const
  )
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}:${typeof value === "string" ? JSON.stringify(value) : value},`)
    .join("");
  patcher.replaceRe(
    "terminal metrics",
    TERMINAL_METRICS,
    `cursorStyle:"${term.cursorStyle}",fontFamily:${family},fontSize:${size},${weights}$3lineHeight:${term.lineHeight},`,
    1,
  );
  // Unlike the family and the size, the weights need this one site only: the
  // settings-sync effect reassigns fontFamily and fontSize and nothing else.
  if (term.fontFamily !== null || term.fontSize !== null) {
    patcher.replaceRe(
      "terminal metrics (settings sync)",
      TERMINAL_METRICS_SYNC,
      `.options.fontFamily=${family},$3.options.fontSize=${size}`,
      1,
    );
  }

  for (const { label, pattern, replacement, expect } of DIFF_PALETTE) {
    patcher.replaceRe(label, pattern, replacement, expect);
  }
  for (const { label, pattern, replacement, expect } of GLASS_SURFACES) {
    patcher.replaceRe(label, pattern, replacement, expect);
  }
  for (const { label, pattern, replacement } of FRAME_RATE) {
    patcher.replaceRe(label, pattern, replacement, 1);
  }

  patcher.replaceRe(INK_SURFACE0.label, INK_SURFACE0.pattern, INK_SURFACE0.replacement, INK_SURFACE0.expect);
  patcher.sweepRe(HOVER_HIGHLIGHT.label, HOVER_HIGHLIGHT.pattern, HOVER_HIGHLIGHT.replacement);
  patcher.sweepRe(BACKDROP_MASKS.label, BACKDROP_MASKS.pattern, BACKDROP_MASKS.replacement);
  patcher.replaceRe(SCRIM_COLOURS.label, SCRIM_COLOURS.pattern, SCRIM_COLOURS.replacement, SCRIM_COLOURS.expect);
  patcher.sweepRe(KEBAB_CHIP.label, KEBAB_CHIP.pattern, KEBAB_CHIP.replacement);
  patcher.replaceRe(KEBAB_GUTTER.label, KEBAB_GUTTER.pattern, KEBAB_GUTTER.replacement, KEBAB_GUTTER.expect);
  patcher.replaceRe(LABELS_LINE.label, LABELS_LINE.pattern, LABELS_LINE.replacement, LABELS_LINE.expect);
  for (const { label, pattern, replacement, expect } of TAB_GLASS) {
    patcher.replaceRe(label, pattern, replacement, expect);
  }
  patcher.replaceRe(
    HANDLE_HIGHLIGHT.label,
    HANDLE_HIGHLIGHT.pattern,
    HANDLE_HIGHLIGHT.replacement,
    HANDLE_HIGHLIGHT.expect,
  );
  patcher.replaceRe(FILE_TAB_REUSE.label, FILE_TAB_REUSE.pattern, FILE_TAB_REUSE.replacement, FILE_TAB_REUSE.expect);

  return { src: patcher.src, notes: patcher.notes };
}

/** Turns the pre-mount flash guard into the one layer carrying the live tint. */
export function patchIndexHtml(html: string, padding: string): { html: string; notes: string[] } {
  const notes: string[] = [];
  let src = html;

  // `html` is dropped from the selector, not just recoloured: the stock rule
  // targets both elements, and an alpha on each composites with itself. See
  // HTML_WASH_REPLACEMENT for the live-tint `color-mix` formula itself.
  const flashGuard = new RegExp(HTML_FLASH_GUARD.source, "g");
  const hits = [...src.matchAll(flashGuard)].length;
  src = src.replace(flashGuard, HTML_WASH_REPLACEMENT);
  if (hits !== 1) {
    notes.push(`MISSED  window wash: expected 1 flash-guard rule, found ${hits}`);
  } else {
    notes.push("ok      window wash (1x)");
  }

  // The dim and the floating-surfaces stylesheet are independent patches, so a
  // miss on one must not skip the other.
  if (!src.includes("</head>")) {
    notes.push("MISSED  glass floating surfaces: no </head> to inject before");
  } else {
    const css = FLOATING_SURFACES_CSS.replace("__PADDING__", padding);
    src = src.replace("</head>", `${css}  </head>`);
    notes.push("ok      glass floating surfaces (1x)");
  }

  return { html: src, notes };
}
