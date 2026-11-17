// Adapted from better-paseo's client/ui/wide-host-column.ts
// (github.com/RoundRedDot/better-paseo, MIT, Copyright (c) 2026 ABorakati).
import { useEffect, type RefObject } from "react";

/**
 * Paseo centres a settings page in a px-capped column (1080 in 0.16), which
 * leaves no room for two columns of cards on most windows; the plugin SDK has
 * no way to ask for more.
 */
export const WIDE_SETTINGS_MAX = 1440;
const MAX_ANCESTOR_HOPS = 12;

export interface WidthCapNode {
  parentElement: WidthCapNode | null;
  style: { maxWidth: string };
}

export function findWidthCap<T extends WidthCapNode>(
  node: T | null,
  readMaxWidth: (element: T) => string,
  limit = WIDE_SETTINGS_MAX,
): T | null {
  let element = node?.parentElement as T | null | undefined;
  for (let depth = 0; element && depth < MAX_ANCESTOR_HOPS; depth += 1) {
    const match = /^(\d+(?:\.\d+)?)px$/.exec(readMaxWidth(element).trim());
    if (match) return Number(match[1]) < limit ? element : null;
    element = element.parentElement as T | null;
  }
  return null;
}

const renderer = globalThis as { getComputedStyle?: (element: WidthCapNode) => { maxWidth: string } };

export function useWideHostColumn(ref: RefObject<object | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !renderer.getComputedStyle) return;
    const node = ref.current as WidthCapNode | null;
    const cap = findWidthCap(node, (element) => renderer.getComputedStyle!(element).maxWidth);
    if (!cap) return;
    const previous = cap.style.maxWidth;
    cap.style.maxWidth = `${WIDE_SETTINGS_MAX}px`;
    return () => {
      cap.style.maxWidth = previous;
    };
  }, [ref, enabled]);
}
