import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { patchIndexHtml, patchRenderer, rendererPath } from "../server/patch-renderer.ts";
import { PatchCountError } from "../server/patch-engine.ts";
import { BUILD_TABLES, PANE, SCRIM_COLOURS } from "../server/renderer-patches.ts";
import type { TermMetrics } from "../server/ghostty.ts";
import { resourcesDir } from "../server/layout.ts";

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
    const webDist = join(resourcesDir(app), "app-dist");
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
    const webDist = join(resourcesDir(app), "app-dist");
    mkdirSync(webDist, { recursive: true });
    writeFileSync(join(webDist, "index.html"), '<script src="/_expo/static/js/web/index-abc123.js"></script>');
    assert.throws(() => rendererPath(app), /missing on disk/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test("patchIndexHtml rewrites the flash guard into the live color-mix wash and injects the floating-surfaces style", () => {
  const html = "<head><style>html,\n body { background-color: #181b1a; }</style></head>";
  const { html: patched, notes } = patchIndexHtml(html, "0 0 0 10px");
  assert.ok(
    patched.includes(
      "body { background-color: color-mix(in srgb, var(--colors-surface1, #181b1a) calc(var(--paseo-tint, 0.85) * 100%), transparent);",
    ),
  );
  assert.ok(patched.indexOf('<style id="paseo-vibrancy-floating-surfaces">') < patched.indexOf("</head>"));
  assert.ok(patched.includes("padding: 0 0 0 10px;"));
  assert.deepEqual(notes, ["ok      window wash (1x)", "ok      glass floating surfaces (1x)"]);
});

test("patchIndexHtml reports a MISSED note when the flash guard is absent, without skipping the style injection", () => {
  const { notes } = patchIndexHtml("<head></head>", "0 0 0 10px");
  assert.ok(notes[0]!.startsWith("MISSED  window wash"));
  assert.ok(notes[1]!.startsWith("ok      glass floating surfaces"));
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

function fileTabReuseFn(o: string): string {
  return (
    `function c(${o}){return"working_diff"===${o}.nextTarget.kind?"working_diff"===${o}.currentTarget.kind:` +
    `"file"===${o}.nextTarget.kind&&"file"===${o}.currentTarget.kind&&` +
    `!(0,n.getPanelInstanceAttributes)({serverId:${o}.serverId,workspaceId:${o}.workspaceId,tabId:${o}.tabId}).modified}`
  );
}

function canReplace(fnText: string, target: { nextTarget: string; currentTarget: string }): boolean {
  const build = new Function(
    "n",
    `${fnText};return c;`,
  ) as (n: { getPanelInstanceAttributes: () => { modified: boolean } }) => (o: unknown) => boolean;
  const fn = build({ getPanelInstanceAttributes: () => ({ modified: false }) });
  return fn({
    nextTarget: { kind: target.nextTarget },
    currentTarget: { kind: target.currentTarget },
    serverId: "s",
    workspaceId: "w",
    tabId: "t",
  });
}

test("patchRenderer's file tab reuse guard follows the global flag at call time", () => {
  const flags = globalThis as Record<string, unknown>;
  const { src, notes } = patchRenderer(fileTabReuseFn("q"), DEFAULT_TERM);
  assert.ok(notes.includes("ok      file tab reuse guard (1x)"));
  const fileToFile = { nextTarget: "file", currentTarget: "file" };
  const diffToDiff = { nextTarget: "working_diff", currentTarget: "working_diff" };
  try {
    delete flags.__paseoOpenFilesInNewTab;
    assert.equal(canReplace(src, fileToFile), true);
    assert.equal(canReplace(src, diffToDiff), true);
    flags.__paseoOpenFilesInNewTab = true;
    assert.equal(canReplace(src, fileToFile), false);
    assert.equal(canReplace(src, diffToDiff), true);
  } finally {
    delete flags.__paseoOpenFilesInNewTab;
  }
});

test("patchRenderer records a MISSED note for the file tab reuse guard when its anchor is absent", () => {
  const { notes } = patchRenderer("var x=1;", DEFAULT_TERM);
  assert.ok(notes.some((n) => n.startsWith("MISSED") && n.includes("file tab reuse guard")));
});

// Paseo 0.13's toolchain (Expo 57) emits object spread natively where 0.12's
// emitted `Object.assign({...}, theme.shadow.md)`.
const SPREAD_SURFACES =
  'toast:{alignSelf:"center",maxWidth:"100%",gap:e.spacing[2],backgroundColor:e.colors.surface0,borderRadius:e.borderRadius["2xl"],...e.shadow.md},' +
  'inputWrapper:{flexShrink:1,flexDirection:"column",gap:e.spacing[3],backgroundColor:e.colors.surface1,borderWidth:e.borderWidth[1],borderColor:e.colors.borderAccent},' +
  'scrollToBottomButton:{width:48,height:48,borderRadius:24,backgroundColor:e.colors.surface2,alignItems:"center",...e.shadow.sm},' +
  "detailCard:{backgroundColor:t.colors.surface1,borderWidth:t.borderWidth[1],borderColor:t.colors.borderAccent,...t.shadow.md}," +
  'container:{flexShrink:1,minHeight:0,backgroundColor:t.colors.surface1,borderWidth:t.borderWidth[1],borderColor:t.colors.borderAccent,borderRadius:t.borderRadius.lg,overflow:"hidden",...t.shadow.md}';

test("patchRenderer glasses the floating surfaces Paseo 0.13 writes with object spread", () => {
  const { notes } = patchRenderer(SPREAD_SURFACES, DEFAULT_TERM);
  for (const label of [
    "glass toast pill",
    "glass composer",
    "glass scroll-to-bottom button",
    "glass autocomplete detail card",
    "glass autocomplete list",
  ]) {
    assert.ok(notes.includes(`ok      ${label} (1x)`), label);
  }
});

const AUTOCOMPLETE_0_14 =
  'detailCard:{flexShrink:1,minHeight:0,overflow:"hidden",backgroundColor:t.colors.surface1,borderWidth:t.borderWidth[1],borderColor:t.colors.borderAccent,borderRadius:t.borderRadius.lg,...t.shadow.md},' +
  'container:{flexShrink:1,minHeight:46,backgroundColor:t.colors.surface1,borderWidth:t.borderWidth[1],borderColor:t.colors.borderAccent,borderRadius:t.borderRadius.lg,overflow:"hidden",...t.shadow.md}';

test("patchRenderer glasses the autocomplete list and detail card Paseo 0.14 reshaped", () => {
  const { src, notes } = patchRenderer(AUTOCOMPLETE_0_14, DEFAULT_TERM);
  for (const label of ["glass autocomplete detail card", "glass autocomplete list"]) {
    assert.ok(notes.includes(`ok      ${label} (1x)`), label);
  }
  assert.equal(src.includes("colors.surface1"), false, "both surfaces lose the opaque fill");
  assert.equal(src.match(/backdropFilter:/g)?.length, 2);
  assert.equal(src.match(/borderWidth:0,/g)?.length, 2);
});

test("patchRenderer notes the detail card Paseo 0.16 removed as absent, not MISSED", () => {
  const autocomplete016 = AUTOCOMPLETE_0_14.slice(AUTOCOMPLETE_0_14.indexOf("container:"));
  const { notes } = patchRenderer(autocomplete016, DEFAULT_TERM);
  assert.ok(notes.includes("absent  glass autocomplete detail card: not in this Paseo"));
  assert.ok(notes.includes("ok      glass autocomplete list (1x)"));
  assert.ok(!notes.some((n) => n.startsWith("MISSED  glass autocomplete")));
});

const RESOLVER_0_15 =
  'function({workspace:t,trailing:o,hasArchiveAction:n,isHovered:s,isTouchPlatform:c,showShortcut:l}){const u=(0,w.hasSidebarWorkspaceTrailing)({workspace:t,trailing:o}),p=Boolean(n&&(s||c))&&!l,h=u&&!(n&&c);let S="absent";h&&(S=l?"hidden":"visible");return{trailingPresentation:S,showKebab:p,showScrim:p&&s,renderSlot:n||u,reserveSlotWidth:h||n&&c}}';
const RESOLVER_0_16 = RESOLVER_0_15.replace("showKebab:p,", "showKebab:p,showArchiveButton:p&&s&&!c,");

type Resolver = (input: { isHovered: boolean; isTouchPlatform: boolean; showShortcut: boolean }) => {
  trailingPresentation: string;
  showArchiveButton: boolean;
};

function patchedResolver(src: string): Resolver {
  const fn = src.slice(src.indexOf("function({workspace"));
  const resolve = new Function("w", `return ${fn}`)({ hasSidebarWorkspaceTrailing: () => true });
  return (input) => resolve({ workspace: {}, trailing: {}, hasArchiveAction: true, ...input });
}

test("patchRenderer hides a sidebar row's diff stat while Paseo 0.16's archive button covers it", () => {
  const { src, notes } = patchRenderer(RESOLVER_0_16, DEFAULT_TERM);
  assert.ok(notes.includes("ok      archive button hides diff stat (1x)"));
  const resolve = patchedResolver(src);
  const hovered = resolve({ isHovered: true, isTouchPlatform: false, showShortcut: false });
  assert.equal(hovered.showArchiveButton, true);
  assert.equal(hovered.trailingPresentation, "hidden");
  assert.equal(resolve({ isHovered: false, isTouchPlatform: false, showShortcut: false }).trailingPresentation, "visible");
  assert.equal(resolve({ isHovered: false, isTouchPlatform: false, showShortcut: true }).trailingPresentation, "hidden");
});

test("patchRenderer notes the archive button as absent on a Paseo without one", () => {
  const { src, notes } = patchRenderer(RESOLVER_0_15, DEFAULT_TERM);
  assert.ok(notes.includes("absent  archive button hides diff stat: not in this Paseo"));
  assert.ok(src.endsWith(RESOLVER_0_15));
});

const DIFF_SCROLL_BLIT_0_16 =
  'function I(t){const n=t.nextTop-t.currentTop;if(!t.canReuse||0===n||Math.abs(n)>=t.canvasHeight)return{paintTop:0,paintHeight:t.canvasHeight};const o=Math.round(Math.abs(n)*t.ratio),l=t.pixelHeight-o;t.scratch.width!==t.pixelWidth&&(t.scratch.width=t.pixelWidth),t.scratch.height!==t.pixelHeight&&(t.scratch.height=t.pixelHeight);const s=t.scratch.getContext("2d");return s?(s.setTransform(1,0,0,1,0,0),s.globalCompositeOperation="copy",s.drawImage(t.canvas,0,0),t.context.setTransform(1,0,0,1,0,0),n>0?(t.context.drawImage(t.scratch,0,o,t.pixelWidth,l,0,0,t.pixelWidth,l),{paintTop:t.canvasHeight-Math.abs(n),paintHeight:Math.abs(n)}):(t.context.drawImage(t.scratch,0,0,t.pixelWidth,l,0,o,t.pixelWidth,l),{paintTop:0,paintHeight:Math.abs(n)})):{paintTop:0,paintHeight:t.canvasHeight}}';

function scrollDiffCanvas(src: string, nextTop: number): string[] {
  const blit = new Function(`return ${src.slice(src.indexOf("function I("))}`)();
  const calls: string[] = [];
  const context = {
    setTransform: () => {},
    clearRect: (...a: number[]) => calls.push(`clearRect ${a.join(",")}`),
    drawImage: () => calls.push("drawImage"),
  };
  const scratchContext = { setTransform: () => {}, drawImage: () => {} };
  const scratch = { width: 0, height: 0, getContext: () => scratchContext };
  blit({
    canvas: {},
    context,
    scratch,
    canReuse: true,
    currentTop: 500,
    nextTop,
    canvasHeight: 300,
    pixelWidth: 200,
    pixelHeight: 600,
    ratio: 2,
  });
  return calls;
}

test("patchRenderer clears the diff canvas before drawing its scrolled rows back, so transparent rows don't stack", () => {
  const { src, notes } = patchRenderer(DIFF_SCROLL_BLIT_0_16, DEFAULT_TERM);
  assert.ok(notes.includes("ok      clear diff canvas before scroll (1x)"));
  for (const nextTop of [540, 460]) {
    assert.deepEqual(scrollDiffCanvas(src, nextTop), ["clearRect 0,0,200,600", "drawImage"], `nextTop ${nextTop}`);
  }
});

test("patchRenderer notes the diff scroll as absent on a Paseo whose diff canvas never scrolls its pixels", () => {
  const { notes } = patchRenderer("headerActiveSurface:e.colors.surface1,", DEFAULT_TERM);
  assert.ok(notes.includes("absent  clear diff canvas before scroll: not in this Paseo"));
});

test("patchRenderer maps Paseo 0.13's tab chip backdrops to the glass fills", () => {
  const colors = {
    surface1: "s1",
    surface2: "s2",
    surfaceSidebar: "sb",
    surfaceSidebarHover: "sbh",
    surfaceSidebarSelected: "sbs",
  };
  const { src, notes } = patchRenderer(
    "var S={tabFill:t=>({backgroundColor:e.colors[t],uni__dependencies:[0]})};",
    DEFAULT_TERM,
  );
  assert.ok(notes.includes("ok      glass tab fills (1x)"));
  const styles = new Function("e", `${src};return S;`)({ colors }) as {
    tabFill: (backdrop: string) => { backgroundColor: string };
  };
  const fill = (backdrop: string) => styles.tabFill(backdrop).backgroundColor;
  assert.equal(fill("surface1"), "var(--paseo-overlay-fill)");
  assert.equal(fill("surfaceSidebarHover"), "var(--paseo-overlay-fill)");
  assert.equal(fill("surface2"), "sbs");
  assert.equal(fill("surfaceSidebarSelected"), "sbs");
  assert.equal(fill("surfaceSidebar"), "sb");
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
    if (!entry || typeof entry !== "object") {
      return;
    }
    if ("variants" in entry && Array.isArray(entry.variants)) {
      entry.variants.forEach(checkEntry);
    }
    if (!("replacement" in entry)) {
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
