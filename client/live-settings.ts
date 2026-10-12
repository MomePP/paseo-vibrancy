/**
 * Maps `VibrancySettings` to the two CSS custom properties the patched
 * renderer's stylesheet reads (see `server/renderer-patches.ts`), and
 * applies them live so Settings changes show immediately without a reload.
 */

import type { VibrancySettings } from "../shared/vibrancy.ts";

export type VibrancyCssVars = {
  "--paseo-tint": string;
  "--paseo-pane-bg": string;
};

export function vibrancyCssVars(settings: VibrancySettings): VibrancyCssVars {
  return {
    "--paseo-tint": String(settings.tint),
    "--paseo-pane-bg": settings.paneGlass ? "transparent" : "var(--colors-surface1)",
  };
}

/**
 * The slice of `Document` this needs. Named locally (instead of the global
 * `document`/`Document` from lib `dom`) so the plugin's `tsconfig.json`
 * never has to add `dom` to `lib` just for this one call — doing so once
 * leaked ambient DOM types (`URL`, etc.) into the server/test compilation
 * unit and broke unrelated files.
 */
interface StyleHost {
  documentElement: { style: { setProperty(name: string, value: string): void } };
}

/** No-op off the web (mobile/native has no `document`). */
export function applyLiveSettings(settings: VibrancySettings): void {
  if (!("document" in globalThis)) {
    return;
  }
  // Presence just checked above; this tsconfig has no lib "dom" entry (see
  // `StyleHost`), so `globalThis` carries no ambient `document` field to narrow.
  const doc = (globalThis as unknown as { document: StyleHost }).document;
  const vars = vibrancyCssVars(settings);
  for (const [name, value] of Object.entries(vars)) {
    doc.documentElement.style.setProperty(name, value);
  }
}
