// Adapted from better-paseo's client/ui/wide-host-column.ts
// (github.com/RoundRedDot/better-paseo, MIT, Copyright (c) 2026 ABorakati).
import { useEffect, type RefObject } from "react";

/**
 * Paseo centres a settings page in a px-capped column (1080 in 0.16), which
 * leaves no room for two columns of cards on most windows; the plugin SDK has
 * no way to ask for more.
 */
export const WIDE_SETTINGS_MAX = 1440;
/** Host wrappers between the plugin's root and the page column: a handful. */
const SEARCH_DEPTH = 12;

export interface WidthCapNode {
  parentElement: WidthCapNode | null;
  style: { maxWidth: string };
}

/**
 * The nearest ancestor of `node` that caps its width in pixels, narrower than
 * `limit`: Paseo's page column. A percentage or `none` is no cap, and a host
 * that already grants `limit` or more is left alone.
 */
export function findWidthCap<T extends WidthCapNode>(
  node: T | null,
  readMaxWidth: (element: T) => string,
  limit = WIDE_SETTINGS_MAX,
): T | null {
  let element = node?.parentElement as T | null | undefined;
  for (let depth = 0; element && depth < SEARCH_DEPTH; depth += 1) {
    const match = /^(\d+(?:\.\d+)?)px$/.exec(readMaxWidth(element).trim());
    if (match) return Number(match[1]) < limit ? element : null;
    element = element.parentElement as T | null;
  }
  return null;
}

/** The renderer's `window`, typed for the one call this hook makes: the project compiles without the DOM lib. */
const dom = globalThis as { getComputedStyle?: (element: WidthCapNode) => { maxWidth: string } };

/**
 * While mounted and `enabled` (web only: the caller decides), lifts the host
 * column's width cap above this screen to `WIDE_SETTINGS_MAX` and restores the
 * host's own value on unmount. The search starts at this screen's own node, so
 * it never reaches another page.
 */
export function useWideHostColumn(ref: RefObject<object | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !dom.getComputedStyle) return;
    const node = ref.current as WidthCapNode | null;
    const cap = findWidthCap(node, (element) => dom.getComputedStyle!(element).maxWidth);
    if (!cap) return;
    const previous = cap.style.maxWidth;
    cap.style.maxWidth = `${WIDE_SETTINGS_MAX}px`;
    return () => {
      cap.style.maxWidth = previous;
    };
  }, [ref, enabled]);
}
