import { z } from "zod";

export const MATERIALS = [
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
] as const;

export const CURSOR_STYLES = ["bar", "block", "underline"] as const;
export const ANSI_PALETTES = ["oxocarbon", "paseo"] as const;

/** Global the client plugin sets and the patched renderer reads at call time. */
export const OPEN_FILES_IN_NEW_TAB_GLOBAL = "__paseoOpenFilesInNewTab";

export const TERMINAL_DEFAULTS = {
  followGhostty: true,
  fontSize: 13.5,
  lineHeight: 1.1,
  fontWeight: 400,
  fontWeightBold: 600,
  cursorStyle: "bar",
  paddingLeft: 10,
  ansi: "oxocarbon",
} as const;

export const VIBRANCY_DEFAULTS = {
  material: "none",
  blurRadius: 30,
  tint: 0.85,
  paneGlass: true,
  openFilesInNewTab: false,
  terminal: TERMINAL_DEFAULTS,
} as const;

/** Clamps to `[min, max]`, then rounds to the nearest multiple of `step`. */
function snap(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  const snapped = Math.round(clamped / step) * step;
  // Re-clamp (a step that doesn't divide the range could round past it) and
  // trim the float noise multiplication leaves behind (1.1500000000000001).
  return Math.round(Math.min(max, Math.max(min, snapped)) * 1000) / 1000;
}

export const TerminalSettingsSchema = z.object({
  followGhostty: z.boolean().catch(TERMINAL_DEFAULTS.followGhostty),
  fontSize: z
    .number()
    .nullable()
    .catch(TERMINAL_DEFAULTS.fontSize)
    .transform((value) => (value === null ? null : snap(value, 8, 32, 0.5))),
  lineHeight: z
    .number()
    .catch(TERMINAL_DEFAULTS.lineHeight)
    .transform((value) => snap(value, 1, 2, 0.05)),
  fontWeight: z
    .number()
    .catch(TERMINAL_DEFAULTS.fontWeight)
    .transform((value) => snap(value, 100, 900, 100)),
  fontWeightBold: z
    .number()
    .catch(TERMINAL_DEFAULTS.fontWeightBold)
    .transform((value) => snap(value, 100, 900, 100)),
  cursorStyle: z.enum(CURSOR_STYLES).catch(TERMINAL_DEFAULTS.cursorStyle),
  paddingLeft: z
    .number()
    .catch(TERMINAL_DEFAULTS.paddingLeft)
    .transform((value) => snap(value, 0, 40, 1)),
  ansi: z.enum(ANSI_PALETTES).catch(TERMINAL_DEFAULTS.ansi),
});

export type TerminalSettings = z.infer<typeof TerminalSettingsSchema>;

export const VibrancySettingsSchema = z.object({
  material: z.enum(MATERIALS).catch(VIBRANCY_DEFAULTS.material),
  blurRadius: z
    .number()
    .catch(VIBRANCY_DEFAULTS.blurRadius)
    .transform((value) => Math.min(60, Math.max(0, value))),
  tint: z
    .number()
    .catch(VIBRANCY_DEFAULTS.tint)
    .transform((value) => Math.min(1, Math.max(0, value))),
  paneGlass: z.boolean().catch(VIBRANCY_DEFAULTS.paneGlass),
  openFilesInNewTab: z.boolean().catch(VIBRANCY_DEFAULTS.openFilesInNewTab),
  // Missing or non-object `terminal` fails the object parse and lands on the
  // defaults; each field inside falls back on its own.
  terminal: TerminalSettingsSchema.catch({ ...TERMINAL_DEFAULTS }),
});

export type VibrancySettings = z.infer<typeof VibrancySettingsSchema>;

export function parseVibrancy(raw: unknown): VibrancySettings {
  const input =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const result = VibrancySettingsSchema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  return { ...VIBRANCY_DEFAULTS, terminal: { ...TERMINAL_DEFAULTS } };
}
