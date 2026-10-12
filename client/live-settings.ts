/**
 * Applies the settings the patched renderer reads live, so Settings changes
 * show immediately without a reload: the two CSS custom properties its
 * stylesheet reads, and the global flag its file-tab reuse guard reads (see
 * `server/renderer-patches.ts`).
 */

import { OPEN_FILES_IN_NEW_TAB_GLOBAL, type VibrancySettings } from "../shared/vibrancy.ts";

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

/** The CSS half is a no-op off the web (mobile/native has no `document`). */
export function applyLiveSettings(settings: VibrancySettings): void {
  (globalThis as Record<string, unknown>)[OPEN_FILES_IN_NEW_TAB_GLOBAL] = settings.openFilesInNewTab;
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
