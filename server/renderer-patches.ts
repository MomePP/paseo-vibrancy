/**
 * Every table/constant `patch_renderer`/`patch_index_html` need, ported from
 * the former paseo-repatch script (RENDERER_PATCHES etc.). The Python
 * script's comments on *why* each anchor looks the way it does are condensed
 * alongside the constant they document, since that script no longer exists.
 *
 * Fixed vs. the Python original, for every build this plugin produces: the
 * look is always glass / full scope / oxocarbon ANSI / no oxocarbon palette
 * swap (Paseo's own theme picker stays live), so
 * `STOCK_PALETTE`/`OXOCARBON_PALETTE` are not ported and the oxocarbon-ANSI
 * patch always runs unconditionally.
 */

import { OPEN_FILES_IN_NEW_TAB_GLOBAL } from "../shared/vibrancy.ts";

type TableReplacer = string | ((...match: string[]) => string);

export type RendererPatch = { label: string; old: string; replacement: string; expect: number };
export type ReTableEntry = { label: string; pattern: RegExp; replacement: TableReplacer };
export type ExpectedReTableEntry = ReTableEntry & { expect: number };

// --- the look (fixed) -------------------------------------------------------
//
// Every React surface token goes to alpha 0 — left non-zero, a nested
// surface would composite its own tint on top of its already-opaque parent
// and stay visible instead of letting the window's own glass show through.
// Baked in as literal "0.0" text below to match Python's `str(0.0)`
// byte-for-byte, since SURFACE_PATCHES' replacement strings are
// pre-rendered rather than built with `{a}` at patch time.

// --- renderer: free length ---------------------------------------------------

// xterm's own default. Paseo never passes the option in its Terminal
// constructor, so flipping the default is what reaches the terminal —
// without it an rgba background composites against black and the pane stays
// opaque no matter what the theme says.
export const RENDERER_PATCHES: RendererPatch[] = [
  {
    label: "xterm allowTransparency",
    old: "allowTransparency:!1",
    replacement: "allowTransparency:!0",
    expect: 1,
  },
];

// React Navigation's DefaultTheme, which Paseo never switches to a dark
// variant — it paints `surface0` opaquely over the navigator and never sees
// it. That footprint is exactly the content pane. Full glass (the only scope
// this plugin ships) clears it entirely; PANE is a CSS var so a later live
// control can repaint the pane without a rebuild.
export const NAVIGATOR_BACKDROP = "background:'rgb(242, 242, 242)'";
export const PANE = '"var(--paseo-pane-bg, transparent)"';

// `surface0` is Paseo's dark-on-light inverse: the colour it paints *on top
// of* an opaque fill. Zeroing the token took those foregrounds with it
// (button labels, status glyphs) — eight sites, fixed by forcing them to the
// opaque inverse surface. A `surface0:t=>({color:t.colors.surface0})` entry
// in a backdrop lookup (the trailing scrim, 0.12's EdgeFade) is a gradient
// fill, not ink: forced opaque it paints a solid band, so it is skipped.
export const SURFACE1_VAR = "var(--colors-surface1)";
export const INK_SURFACE0: ExpectedReTableEntry = {
  label: "readable surface0 foregrounds",
  pattern: /(?<!surface0:[A-Za-z_$][\w$]*=>\(\{)\bcolor:([A-Za-z_$][\w$]*)\.colors\.surface0\b/g,
  replacement: `color:"${SURFACE1_VAR}"`,
  expect: 8,
};

// Hover fills, unified onto one translucent overlay (`interactionHighlight`)
// instead of whichever opaque surface was nearest to hand — invisible
// against a theme whose surfaces sit close together, glaring against one
// whose don't. A sweep, not an anchor: inventory, only fails when the shape
// disappears entirely.
export const HOVER_HIGHLIGHT: ReTableEntry = {
  label: "subtle hover fills",
  pattern:
    /\b(?!backdrop)([a-zA-Z0-9]+Hover(?:ed)?):\{backgroundColor:([A-Za-z_$][\w$]*)\.colors\.(?:surface1|surface2|surfaceSidebarHover)\b/g,
  replacement: "$1:{backgroundColor:$2.colors.interactionHighlight",
};

// Opaque masks behind a sidebar row's trailing stats, left over from an
// opaque app; on glass they hang as a near-black slab. Made transparent —
// the title already truncates with an ellipsis before it collides.
export const BACKDROP_MASKS: ReTableEntry = {
  label: "clear row backdrop masks",
  pattern:
    /(backdrop(?:Surface[0-9]|SurfaceSidebar(?:Hover|Selected)?)):\{backgroundColor:[A-Za-z_$][\w$]*\.colors\.[a-zA-Z0-9]+/g,
  replacement: '$1:{backgroundColor:"transparent"',
};

// The scrim lookup, with `surface0` set to what shows behind a clear tab —
// PANE, since full scope has nothing underneath.
function scrimTable(pane: string): string {
  return (
    `{surface0:$1=>({color:${pane}}),` +
    "surface1:$1=>({color:$1.colors.surface1})," +
    "surface2:$1=>({color:$1.colors.surface2})," +
    'surfaceSidebar:$1=>({color:"transparent"}),' +
    'surfaceSidebarHover:$1=>({color:"transparent"}),' +
    'surfaceSidebarSelected:$1=>({color:"transparent"})}'
  );
}

// The trailing-control scrim lookup table, one anchor for six lexically
// identical lookups. `surface0`'s entry is a gradient fill (not ink, so
// INK_SURFACE0 doesn't touch it). PANE is fixed (full scope, always), so the
// replacement is baked in here rather than built at patch time — this is the
// literal text the build fingerprint hashes, so a change to PANE or to
// the scrim shape has to show up here to invalidate a stale build. Sidebar-
// row tiers go fully transparent; the kebab gets its own background instead
// (see KEBAB_CHIP/KEBAB_GUTTER).
export const SCRIM_COLOURS: ExpectedReTableEntry = {
  label: "trailing scrim per caller",
  pattern:
    /\{surface0:([A-Za-z_$][\w$]*)=>\(\{color:[^{}]*\}\),surface1:\1=>\(\{color:[^{}]*\}\),surface2:\1=>\(\{color:[^{}]*\}\),surfaceSidebar:\1=>\(\{color:[^{}]*\}\),surfaceSidebarHover:\1=>\(\{color:[^{}]*\}\),surfaceSidebarSelected:\1=>\(\{color:[^{}]*\}\)\}/g,
  replacement: scrimTable(PANE),
  expect: 1,
};

// Two kebabs (sidebar row, card), unpainted in stock because the wedge
// behind them did the work; given a background now that the wedge is
// transparent. The hover glass, like the row under it, not an opaque chip.
// The theme binding is borrowed from the hovered variant that follows each
// one.
export const KEBAB_CHIP_TOKEN = "interactionHighlight";
export const KEBAB_CHIP: ReTableEntry = {
  label: "kebab chip",
  pattern: /kebabButton:\{padding:2,borderRadius:4(,marginLeft:2)?\},kebabButtonHovered:\{backgroundColor:([A-Za-z_$][\w$]*)\.colors\./g,
  replacement:
    `kebabButton:{padding:2,borderRadius:4$1,backgroundColor:$2.colors.${KEBAB_CHIP_TOKEN},uni__dependencies:[0]},` +
    "kebabButtonHovered:{backgroundColor:$2.colors.",
};

// A gutter so the kebab sits beside the diff stats rather than on them; 22px
// is Paseo's own `kebabSlot` width. Constant rather than hover-only, so
// nothing shifts when the pointer arrives.
export const KEBAB_GUTTER_PX = 22;
export const KEBAB_GUTTER: ExpectedReTableEntry = {
  label: "kebab gutter",
  pattern:
    /(trailingActionSlot(?:Reserved)?):\{position:"relative",(minWidth:18,)?minHeight:20,flexShrink:0,alignItems:"flex-end",justifyContent:"flex-start"\}/g,
  replacement: `$1:{position:"relative",$2minHeight:20,flexShrink:0,alignItems:"flex-end",justifyContent:"flex-start",paddingRight:${KEBAB_GUTTER_PX}}`,
  expect: 2,
};

// Workspace tabs, made to match the sidebar rows: hover is the shared
// translucent `interactionHighlight`, the focused tab is the glass selection
// (`surfaceSidebarSelected`, see SURFACE_PATCHES), and the active tab of an
// unfocused pane takes the hover glass. A tab used to fade its label under
// the close button with an opaque scrim, which shows as a solid block on a
// glass fill, so the scrim is cleared and a tab that has a close button
// keeps its label in a constant gutter clear of it (18px, the button's own
// width), the way KEBAB_GUTTER does for sidebar rows; constant so the label
// does not reflow on hover. Tabs without one (the explorer's Files and
// Changes) get no gutter. Paseo sizes each tab from an off-screen measurement
// of its label plus a per-tab extra (12px for the modified dot) and reserves
// nothing for the overlaid close button, so closable tabs get the 18px added
// the same way: without it they came out 18px too narrow and truncated their
// own label. The fill patch runs after HOVER_HIGHLIGHT, which has already
// turned `tabHovered` into `interactionHighlight`.
export const TAB_GLASS: ExpectedReTableEntry[] = [
  {
    label: "glass tab fills",
    pattern:
      /tabHovered:\{backgroundColor:([A-Za-z_$][\w$]*)\.colors\.interactionHighlight(,uni__dependencies:\[0\]\},tabActive:\{backgroundColor:\1\.colors\.)surface2(,uni__dependencies:\[0\]\},tabActiveUnfocused:\{backgroundColor:\1\.colors\.)surface1\b/g,
    replacement: "tabHovered:{backgroundColor:$1.colors.interactionHighlight$2surfaceSidebarSelected$3interactionHighlight",
    expect: 1,
  },
  {
    label: "clear tab scrim",
    pattern: /TrailingActionScrim,\{backdrop:[A-Za-z_$][\w$]*\}\)/g,
    replacement: 'TrailingActionScrim,{backdrop:"surfaceSidebar"})',
    expect: 1,
  },
  {
    label: "tab label gutter",
    pattern: /(\{presentation:([\w$]+),isHighlighted:[\s\S]{0,2500}?\{style:)([\w$]+\.tabHandle)(,dataSet:)/g,
    replacement: "$1[$3,$2.showCloseButton&&{paddingRight:18}]$4",
    expect: 1,
  },
  {
    label: "tab width carries closable flag",
    pattern: /(return\{key:([\w$]+)\.tab\.key,label:[\w$]+,modified:\2\.presentation\.modified)\}/g,
    replacement: "$1,closable:$2.presentation.showCloseButton}",
    expect: 1,
  },
  {
    label: "tab width with gutter",
    pattern: /for\(const\{key:([\w$]+),label:([\w$]+),modified:([\w$]+)\}of ([\w$]+)\)(\{[^{}]*?)const ([\w$]+)=\3\?12:0;/g,
    replacement: "for(const{key:$1,label:$2,modified:$3,closable:__pvClosable}of $4)$5const $6=($3?12:0)+(__pvClosable?18:0);",
    expect: 1,
  },
  {
    // The 160px cap grows by the same 18px, so a long title keeps the text
    // width stock gave it.
    label: "tab max width with gutter",
    pattern: /(minTabWidth:[\w$]+,maxTabWidth:)([\w$]+)(,tabIconWidth:)/g,
    replacement: "$1$2+18$3",
    expect: 1,
  },
];

// Sidebar row meta line: branch, PR, checks, services and workspace labels
// all share one row, so a long branch and a label chip squeeze each other
// into `feature/ardu…` and `devel…`. The labels get a line of their own
// under the rest; the row itself only has a minHeight, so it grows to fit.
// `WorkspaceMetaRow`'s single `row` View becomes a column holding the
// original row (every item except labels, still `·`-separated) and one row
// per labels item, which is `leading` there so its chip inset lines up with
// the branch icon. Captures every minified name so the rewrite only touches
// the item map and the container style.
export const LABELS_LINE: ExpectedReTableEntry = {
  label: "workspace labels on their own line",
  pattern: new RegExp(
    String.raw`(\w)=(\w)\.View,(\w)=([\w$]+)\.row,(\w)\[12\]!==(\w)\?\((\w)=\((\w),(\w)\)=>\(0,(\w)\.jsxs\)\((\w)\.Fragment,\{children:\[\9>0\?\(0,\10\.jsx\)\((\w)\.Text,\{style:\4\.separator,children:"\\xb7"\}\):null,\(0,\10\.jsx\)\((\w),\{item:\8,hostBadge:\6,leading:0===\9\}\)\]\},\8\.kind\),\5\[12\]=\6,\5\[13\]=\7\):\7=\5\[13\],(\w)=(\w)\.map\(\7\)`,
    "g",
  ),
  replacement:
    '$1=$2.View,$3={flexDirection:"column",gap:2,minWidth:0},' +
    '$5[12]!==$6?($7=($8,$9)=>(0,$10.jsxs)($11.Fragment,{children:[$9>0?(0,$10.jsx)($12.Text,{style:$4.separator,children:"\\xb7"}):null,' +
    "(0,$10.jsx)($13,{item:$8,hostBadge:$6,leading:0===$9})]},$8.kind),$5[12]=$6,$5[13]=$7):$7=$5[13]," +
    '$14=[(0,$10.jsx)($2.View,{style:$4.row,children:$15.filter(__pv=>"labels"!==__pv.kind).map($7)},"meta"),' +
    '...$15.filter(__pv=>"labels"===__pv.kind).map(__pv=>(0,$10.jsx)($2.View,{style:$4.row,children:(0,$10.jsx)($13,{item:__pv,hostBadge:$6,leading:!0})},__pv.kind))]',
  expect: 1,
};

// The pane resize handle's hover/drag highlight: oxocarbon's accent is a
// bright purple that lights up a full-height bar on every pointer crossing.
// `surface4` (ring) is one clear step above resting `border` with no hue, so
// the divider still answers the pointer without announcing it so loudly.
//
// The pattern has no wildcard spans — every character of the match is either
// literal or one of the three captured idents — so the replacement can
// reconstruct the whole match from `$1`/`$2`/`$3` as a plain string (with
// `accent` swapped for the token in both places it appears) rather than a
// function over `match[0]`, keeping this patch's full output in BUILD_TABLES
// for the build fingerprint.
export const HANDLE_HIGHLIGHT_TOKEN = "surface4";
export const HANDLE_HIGHLIGHT: ExpectedReTableEntry = {
  label: "subtle resize handle",
  pattern:
    /\[([A-Za-z_$][\w$]*)\.highlight,"horizontal"===([A-Za-z_$][\w$]*)\?\1\.highlightHorizontal:\1\.highlightVertical,\{backgroundColor:([A-Za-z_$][\w$]*)\.colors\.accent\}\],\[\2,\3\.colors\.accent\]/g,
  replacement: `[$1.highlight,"horizontal"===$2?$1.highlightHorizontal:$1.highlightVertical,{backgroundColor:$3.colors.${HANDLE_HIGHLIGHT_TOKEN}}],[$2,$3.colors.${HANDLE_HIGHLIGHT_TOKEN}]`,
  expect: 1,
};

// Upstream's `canReplacePreview` (workspace-tabs/open-beside.ts) lets a file
// open replace the focused unmodified file tab. The guard reads a global at
// call time instead of baking the setting in, so the toggle is live: the client
// plugin sets the flag, and with the plugin off it is undefined, which leaves
// stock behaviour. The pattern captures the options ident so the replacement
// can rebuild the whole match as a plain string for the build fingerprint.
export const FILE_TAB_REUSE: ExpectedReTableEntry = {
  label: "file tab reuse guard",
  pattern: /"file"===([A-Za-z_$][\w$]*)\.nextTarget\.kind&&"file"===\1\.currentTarget\.kind&&/g,
  replacement: `"file"===$1.nextTarget.kind&&!globalThis.${OPEN_FILES_IN_NEW_TAB_GLOBAL}&&"file"===$1.currentTarget.kind&&`,
  expect: 1,
};

// Two places re-assert an opaque background after the window is constructed;
// either alone hides `transparent: true` completely. This is the runtime IPC
// push of the renderer's palette back to the main process — only
// `backgroundColor` is dropped, `trafficLightOffsetY` stays.
export const WINDOW_CHROME_PAYLOAD: ExpectedReTableEntry = {
  label: "window chrome repaint",
  pattern: /\{backgroundColor:[A-Za-z_$][\w$]*,trafficLightOffsetY:/g,
  replacement: "{trafficLightOffsetY:",
  expect: 1,
};

// Prepended to the bundle: `__paseoAlpha` composites a hex surface down to a
// given alpha; `__paseoOpaque` is its inverse for surfaces that must stay
// solid (diff canvas — see DIFF_PALETTE). Landed as a `var` in front of the
// bundle's own first-line `var`, which both of Paseo's theme-factory
// closures can see.
export const ALPHA_HELPER =
  'var __paseoAlpha=function(h,a){var v=String(h||"").replace("#","");' +
  "return v.length<6?h:" +
  '"rgba("+parseInt(v.slice(0,2),16)+", "+parseInt(v.slice(2,4),16)+", "' +
  '+parseInt(v.slice(4,6),16)+", "+a+")"};' +
  'var __paseoOpaque=function(c){return String(c||"")' +
  '.replace(/^rgba\\((.+),\\s*[\\d.]+\\)$/,"rgba($1, 1)")};\n';

// The four large-area surface tokens (surface0, background, sidebar,
// workspace), alpha 0 always, plus the selection: the selected sidebar row
// (and, through TAB_GLASS, the focused tab) is the theme's selection colour
// at 0.6, glass blended with what is behind it rather than an opaque slab.
// Patches the theme factories' *outputs*, not the palettes feeding them:
// `surface0` is also `primaryForeground` and `surface2` is `popover`/`input`/
// `muted`, so an alpha at the palette would make button text and popovers
// disappear too. Each anchor carries the key that follows it to survive a
// 20 MB bundle without colliding.
export const SURFACE_PATCHES: ExpectedReTableEntry[] = [
  {
    label: "app surface fill",
    pattern: /\{surface0:([A-Za-z_$][\w$]*)\.surface0,surface1:/g,
    replacement: "{surface0:__paseoAlpha($1.surface0,0.0),surface1:",
    expect: 2,
  },
  {
    label: "app background + window dim",
    pattern: /background:([A-Za-z_$][\w$]*)\.surface0,popover:/g,
    replacement: "background:__paseoAlpha($1.surface0,0.0),popover:",
    expect: 2,
  },
  {
    label: "terminal background",
    pattern: /\{background:([A-Za-z_$][\w$]*)\.surface0,foreground:/g,
    replacement: "{background:__paseoAlpha($1.surface0,0.0),foreground:",
    expect: 2,
  },
  {
    label: "sidebar background",
    pattern: /surfaceSidebar:([A-Za-z_$][\w$]*)\.surfaceSidebar,surfaceSidebarHover:/g,
    replacement: "surfaceSidebar:__paseoAlpha($1.surfaceSidebar,0.0),surfaceSidebarHover:",
    expect: 2,
  },
  {
    label: "workspace pane background",
    pattern: /surfaceWorkspace:([A-Za-z_$][\w$]*)\.surface1,interactionHighlight:/g,
    replacement: "surfaceWorkspace:__paseoAlpha($1.surface1,0.0),interactionHighlight:",
    expect: 1,
  },
  {
    label: "glass selection",
    pattern: /surfaceSidebarSelected:([A-Za-z_$][\w$]*)\.(surface\d),surfaceWorkspace:/g,
    replacement: "surfaceSidebarSelected:__paseoAlpha($1.$2,0.6),surfaceWorkspace:",
    expect: 2,
  },
];

// The 16 ANSI colours, remapped rather than transliterated: lazygit/eza/etc.
// name ANSI slots rather than hex, so this alone decides how every TUI reads
// regardless of app-chrome theme. Always applied — every Vibrancy build ships
// the oxocarbon ANSI set.
export const OXOCARBON_ANSI =
  '{red:"#08bdba",green:"#33b1ff",yellow:"#ee5396",blue:"#42be65",magenta:"#be95ff",' +
  'cyan:"#ee5396",white:"#f2f4f8",brightRed:"#3ddbd9",brightGreen:"#82cfff",' +
  'brightYellow:"#ff7eb6",brightBlue:"#42be65",brightMagenta:"#be95ff",' +
  'brightCyan:"#ff7eb6",brightWhite:"#ffffff"}';

export const STOCK_ANSI: ExpectedReTableEntry = {
  label: "oxocarbon ANSI",
  pattern: /\{red:"#e07070",green:"#5dba80".*?brightWhite:"#[0-9a-fA-F]{6}"\}/g,
  replacement: OXOCARBON_ANSI,
  expect: 1,
};

// Paseo draws diffs onto a <canvas>, only ever `fillRect`, never `clearRect`
// — a surface with any alpha below 1 fails to erase the previous frame and
// scrolling ghosts. The diff pane is the one surface in the app that cannot
// be glass; forced back to opaque with `__paseoOpaque`.
export const DIFF_PALETTE: ReTableEntry[] = [
  {
    label: "diff canvas surface",
    pattern: /surface:([A-Za-z_$][\w$]*)\.colors\.surface0,headerSurface:\1\.colors\.surface0,/g,
    replacement: "surface:__paseoOpaque($1.colors.surface0),headerSurface:__paseoOpaque($1.colors.surface0),",
  },
  {
    label: "diff canvas empty rows",
    pattern: /emptyBackground:([A-Za-z_$][\w$]*)\.colors\.surface0,/g,
    replacement: "emptyBackground:__paseoOpaque($1.colors.surface0),",
  },
];

// Floating surfaces are glass like the workspace and fill like a hovered
// sidebar row: the theme's `interactionHighlight` (white 8% on dark themes)
// over the same body wash, so a hover card reads as the row it came from. A
// strong blur keeps text under a menu or dialog from showing through
// legibly.
//
// The user's message bubble, the composer and the pills above it (the diff
// stat chip) are frosted instead: the theme's `surface2` (oxocarbon base01)
// at 35%, darker than the hover white, over a light blur, so chat text
// scrolling under the composer shows as soft shapes rather than a flat grey
// slab (a 24px blur under a white tint read as opaque; 55% still too solid).
//
// Both are defined once on `:root` by FLOATING_SURFACES_CSS. Unistyles names a
// theme var by hyphenating the key (`--colors-interaction-highlight`); the
// fallbacks are the dark values. react-native-web passes a colour through
// untouched only when it starts with `var(`, so inline styles use the var.
const GLASS_FILL = "var(--paseo-glass-fill)";
const GLASS_BLUR = "blur(24px) saturate(1.4)";
const FROST_FILL = "var(--paseo-frost-fill)";
const FROST_BLUR = "blur(5px) saturate(1.2)";
// The composer's autocomplete floats over chat text, where the light frost
// left the text behind legible enough to fight the suggestions. Same base01,
// denser, under the floating-surface blur.
const OVERLAY_FILL = "var(--paseo-overlay-fill)";

// Surfaces with no ARIA role or test id, reachable only at the style object:
// the browser pane's "Annotate element" card, the toast pill, the user's
// message bubble (stock `surface3`, a solid slab), the composer box (stock
// `surface1`) and its counterpart in the New workspace dialog (`surface2`),
// the composer pills (`composerPillStyles`, stock `surface1` with an opaque
// `surface2` hover, now the shared hover fill), the chat's scroll-to-bottom
// button (stock `surface2`), an expanded tool call in the chat (`surface1`),
// the composer's autocomplete list and detail card (`surface1` with an
// outline, now frosted and borderless like the composer) and the active row
// of menus, the autocomplete and comboboxes (opaque, now the hover glass).
export const GLASS_SURFACES: ExpectedReTableEntry[] = [
  {
    label: "glass annotate card",
    pattern: /(annotationCard:\{[^{}]*?backgroundColor:)[A-Za-z_$][\w$]*\.colors\.surface0/g,
    replacement: `$1"${GLASS_FILL}",backdropFilter:"${GLASS_BLUR}"`,
    expect: 1,
  },
  {
    label: "glass toast pill",
    pattern: /(toast:Object\.assign\(\{[^{}]*?backgroundColor:)[A-Za-z_$][\w$]*\.colors\.surface0/g,
    replacement: `$1"${GLASS_FILL}",backdropFilter:"${GLASS_BLUR}"`,
    expect: 1,
  },
  {
    label: "glass message bubble",
    pattern: /(bubble:\{backgroundColor:)[A-Za-z_$][\w$]*\.colors\.surface3(,borderRadius:[A-Za-z_$][\w$]*\.borderRadius\["2xl"\],borderTopRightRadius:)/g,
    replacement: `$1"${FROST_FILL}",backdropFilter:"${FROST_BLUR}"$2`,
    expect: 1,
  },
  {
    // No outline either, so the composer reads as the same frosted surface
    // as the message bubble (an outline made the same fill look darker).
    label: "glass composer",
    pattern:
      /(inputWrapper:Object\.assign\(\{flexShrink:1,flexDirection:"column",gap:[A-Za-z_$][\w$]*\.spacing\[3\],backgroundColor:)[A-Za-z_$][\w$]*\.colors\.surface1,borderWidth:[A-Za-z_$][\w$]*\.borderWidth\[1\]/g,
    replacement: `$1"${FROST_FILL}",backdropFilter:"${FROST_BLUR}",borderWidth:0`,
    expect: 1,
  },
  {
    label: "glass setup dialog composer",
    pattern: /(composerInputWrapper:\{backgroundColor:)[A-Za-z_$][\w$]*\.colors\.surface2/g,
    replacement: `$1"${FROST_FILL}",backdropFilter:"${FROST_BLUR}"`,
    expect: 1,
  },
  {
    label: "glass composer pill",
    pattern:
      /(body:\{flexDirection:"row",alignItems:"center",gap:([A-Za-z_$][\w$]*)\.spacing\[2\],minHeight:[\w$]+,paddingHorizontal:\2\.spacing\[3\],paddingVertical:\2\.spacing\[1\],borderRadius:\2\.borderRadius\["2xl"\],borderWidth:\2\.borderWidth\[1\],borderColor:\2\.colors\.borderAccent,backgroundColor:)\2\.colors\.surface1(,uni__dependencies:\[0\]\},bodyActive:\{backgroundColor:)\2\.colors\.surface2/g,
    replacement: `$1"${FROST_FILL}",backdropFilter:"${FROST_BLUR}"$3"${GLASS_FILL}"`,
    expect: 1,
  },
  {
    label: "glass scroll-to-bottom button",
    pattern: /(scrollToBottomButton:Object\.assign\(\{width:48,height:48,borderRadius:24,backgroundColor:)[A-Za-z_$][\w$]*\.colors\.surface2/g,
    replacement: `$1"${FROST_FILL}",backdropFilter:"${FROST_BLUR}"`,
    expect: 1,
  },
  {
    label: "glass expanded tool call",
    pattern: /(pressableExpanded:\{backgroundColor:)[A-Za-z_$][\w$]*\.colors\.surface1/g,
    replacement: `$1"${FROST_FILL}",backdropFilter:"${FROST_BLUR}"`,
    expect: 1,
  },
  {
    label: "glass autocomplete detail card",
    pattern: /(detailCard:Object\.assign\(\{backgroundColor:)[A-Za-z_$][\w$]*\.colors\.surface1,borderWidth:[A-Za-z_$][\w$]*\.borderWidth\[1\]/g,
    replacement: `$1"${OVERLAY_FILL}",backdropFilter:"${GLASS_BLUR}",borderWidth:0`,
    expect: 1,
  },
  {
    label: "glass autocomplete list",
    pattern:
      /(container:Object\.assign\(\{flexShrink:1,minHeight:0,backgroundColor:)([A-Za-z_$][\w$]*)\.colors\.surface1,borderWidth:\2\.borderWidth\[1\](,borderColor:\2\.colors\.borderAccent,borderRadius:\2\.borderRadius\.lg,overflow:"hidden")/g,
    replacement: `$1"${OVERLAY_FILL}",backdropFilter:"${GLASS_BLUR}",borderWidth:0$3`,
    expect: 1,
  },
  {
    label: "glass menu active row",
    pattern: /([{,]itemActive:\{backgroundColor:)([A-Za-z_$][\w$]*)\.colors\.surface2\b/g,
    replacement: "$1$2.colors.interactionHighlight",
    expect: 2,
  },
  {
    label: "glass combobox active row",
    pattern: /(comboboxItemActive:\{backgroundColor:)([A-Za-z_$][\w$]*)\.colors\.surface1\b/g,
    replacement: "$1$2.colors.interactionHighlight",
    expect: 1,
  },
];

// A transparent window cannot be occlusion-culled, so every frame Paseo
// presents costs WindowServer real CPU — measured ~48% WindowServer / ~85%
// GPU idle with an agent running, dropping to 2%/… once the renderer's
// frames stopped. Three animations keep the pipeline busy on unrelated
// periods that rarely coalesce; each is stepped/slowed independently so a
// spinner still looks like a spinner, just at a lower frame rate. Values are
// the first (gentler) of two measured rounds. Upstream: getpaseo/paseo #4634
// (loader), #3692 (rings).
export const RING_STEPS = 12;
export const RING_SLOWDOWN = 1; // 900ms per turn, 12 positions: 13.3 frames/s
export const LOADER_SLOWDOWN = 1; // 950ms per cycle, six dots: 6.3 writes/s
export const LOADER_POLL_MS = 80; // ~half of the 158ms step
export const SHIMMER_STEPS = 16;
export const SHIMMER_SLOWDOWN = 1; // 1.024s per sweep, 16 steps: 15.6 frames/s

export const FRAME_RATE: ReTableEntry[] = [
  {
    label: "idle frame rate: status ring",
    pattern:
      /duration:([A-Za-z_$][\w$]*)\.STATUS_RING_PERIOD_MS,easing:"linear",iterations:Number\.POSITIVE_INFINITY/g,
    replacement: `duration:${RING_SLOWDOWN}*$1.STATUS_RING_PERIOD_MS,easing:"steps(${RING_STEPS})",iterations:Number.POSITIVE_INFINITY`,
  },
  {
    label: "idle frame rate: synced loader cycle",
    pattern: /SYNCED_LOADER_DURATION_MS:950,/g,
    replacement: `SYNCED_LOADER_DURATION_MS:${950 * LOADER_SLOWDOWN},`,
  },
  // The lookbehind keeps the unanchored identifier from being retried at every
  // character inside long word runs: without it these two scans alone took
  // ~5 s each on the 22 MB bundle, blocking the plugin server.
  {
    label: "idle frame rate: synced loader tick",
    pattern:
      /(?<![\w$])([A-Za-z_$][\w$]*)\.value!==([A-Za-z_$][\w$]*)&&\(\1\.value=\2\),requestAnimationFrame\(([A-Za-z_$][\w$]*)\)/g,
    replacement: `$1.value!==$2&&($1.value=$2),setTimeout($3,${LOADER_POLL_MS})`,
  },
  {
    label: "idle frame rate: synced loader kick",
    pattern: /(?<![\w$])([A-Za-z_$][\w$]*)\.value=([A-Za-z_$][\w$]*)\.value,requestAnimationFrame\(([A-Za-z_$][\w$]*)\)/g,
    replacement: `$1.value=$2.value,setTimeout($3,${LOADER_POLL_MS})`,
  },
  {
    label: "idle frame rate: tool-call shimmer",
    pattern: /\$\{([A-Za-z_$][\w$]*)\.shimmerDuration\}s linear infinite/g,
    // Built with concatenation, not a template literal: the replacement text
    // must contain a literal `${` for String.replace to leave untouched —
    // `${` inside a backtick template would instead open JS interpolation.
    replacement: "$${$1.shimmerDuration*" + SHIMMER_SLOWDOWN + "}s steps(" + SHIMMER_STEPS + ") infinite",
  },
];

// --- terminal metrics --------------------------------------------------------

// The constructor keys from cursorStyle to lineHeight as one anchor, unique
// in the bundle. `$1`/`$2` assert the size pair uses the same resolver
// bindings as the family pair; whatever keys sit between fontSize and
// lineHeight are captured as `$3` and carried through as-is.
export const TERMINAL_METRICS =
  /cursorStyle:"bar",fontFamily:\(0,([A-Za-z_$][\w$]*)\.resolveTerminalFontFamily\)\(([A-Za-z_$][\w$]*)\.fontFamily\),fontSize:\(0,\1\.resolveTerminalFontSize\)\(\2\.fontSize\),((?:[A-Za-z_$][\w$]*:(?:\{[^{}]*\}|[^,{}()]+),)*?)lineHeight:1,/;

// A settings-sync effect reassigns `options.fontFamily`/`options.fontSize`
// from the same resolvers whenever the font settings change, silently
// undoing the constructor patch. Both sites have to agree.
export const TERMINAL_METRICS_SYNC =
  /\.options\.fontFamily=\(0,([A-Za-z_$][\w$]*)\.resolveTerminalFontFamily\)\(([A-Za-z_$][\w$]*)\.fontFamily\),([A-Za-z_$][\w$]*)\.options\.fontSize=\(0,\1\.resolveTerminalFontSize\)\(\2\.fontSize\)/;

// --- index.html ---------------------------------------------------------------

// The CSS flash guard: `html, body` painted the dark surface colour under a
// prefers-color-scheme media query so the window isn't white for the few
// frames before React mounts. It sits beneath the whole React tree and above
// the transparent window, so no amount of alpha in the theme reaches past it
// while it stays opaque — which is why the live tint wash lives here rather
// than in the React tree. `html` is dropped from the selector (not just
// recoloured): the stock rule targets both elements, and an alpha on each
// composites with itself.
export const HTML_FLASH_GUARD = /(html,\s*body\s*\{\s*background-color:\s*)#([0-9a-fA-F]{6});/;

// The wash itself: a CSS `color-mix` against `--paseo-tint` (default 0.85,
// matching VIBRANCY_DEFAULTS.tint) rather than a baked-in rgba, so a later live
// control can retint without a rebuild. `$2` is HTML_FLASH_GUARD's captured
// hex, reused as the `--colors-surface1` fallback so the wash matches
// whichever dark surface Paseo shipped.
export const HTML_WASH_REPLACEMENT =
  "body { background-color: color-mix(in srgb, var(--colors-surface1, #$2) calc(var(--paseo-tint, 0.85) * 100%), transparent);";

// Floating surfaces (menus, dialogs, listboxes, tooltips) inherit `surface0`
// rather than `popover`, so zeroing that token took them with it. Fixed with
// a stylesheet rather than a bundle patch: Paseo emits its theme as CSS
// custom properties, so GLASS_FILL follows the theme picker for every built-in
// theme for free. Selectors are ARIA roles/Paseo's own test ids, both far
// more stable across releases than a minified style object.
export const FLOATING_SURFACES_CSS = `
    <style id="paseo-vibrancy-floating-surfaces">
      /* added by paseo-vibrancy: floating surfaces are glass, blurred so
         what is behind them stays unreadable */
      :root {
        --paseo-glass-fill: var(--colors-interaction-highlight, rgba(255, 255, 255, 0.08));
        --paseo-frost-fill: color-mix(in srgb, var(--colors-surface2, #262626) 35%, transparent);
        --paseo-overlay-fill: color-mix(in srgb, var(--colors-surface2, #262626) 60%, transparent);
      }
      [aria-modal="true"],
      [role="menu"],
      [role="listbox"],
      [role="tooltip"] {
        background-color: ${GLASS_FILL} !important;
        backdrop-filter: ${GLASS_BLUR} !important;
      }
      /* xterm sits flush against the pane edge; FitAddon subtracts this */
      .xterm {
        padding: __PADDING__;
      }
      /* the workspace title is Light (300) from 720px up, which reads
         hairline-thin against native text; Medium sits just above the
         Regular (400) text around it */
      [data-testid="workspace-header-title"] {
        font-weight: 500 !important;
      }
    </style>
`;

// Every table/constant above, aggregated for the build fingerprint: a
// patch rewrite (anchor, replacement, or constant) should change the
// fingerprint the same way a Ghostty-derived term value does.
export const BUILD_TABLES = {
  RENDERER_PATCHES,
  NAVIGATOR_BACKDROP,
  PANE,
  SURFACE1_VAR,
  INK_SURFACE0,
  HOVER_HIGHLIGHT,
  BACKDROP_MASKS,
  SCRIM_COLOURS,
  KEBAB_CHIP_TOKEN,
  KEBAB_CHIP,
  KEBAB_GUTTER_PX,
  KEBAB_GUTTER,
  LABELS_LINE,
  TAB_GLASS,
  HANDLE_HIGHLIGHT_TOKEN,
  HANDLE_HIGHLIGHT,
  FILE_TAB_REUSE,
  WINDOW_CHROME_PAYLOAD,
  ALPHA_HELPER,
  SURFACE_PATCHES,
  OXOCARBON_ANSI,
  STOCK_ANSI,
  DIFF_PALETTE,
  GLASS_SURFACES,
  RING_STEPS,
  RING_SLOWDOWN,
  LOADER_SLOWDOWN,
  LOADER_POLL_MS,
  SHIMMER_STEPS,
  SHIMMER_SLOWDOWN,
  FRAME_RATE,
  TERMINAL_METRICS,
  TERMINAL_METRICS_SYNC,
  HTML_FLASH_GUARD,
  HTML_WASH_REPLACEMENT,
  FLOATING_SURFACES_CSS,
} as const;
