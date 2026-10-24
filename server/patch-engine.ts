/**
 * Ports `patch_renderer`'s inner `replace`/`replace_re`/`sweep_re` helpers
 * from the former paseo-repatch script. Semantics and note-line format
 * are kept byte-for-byte identical so downstream tasks can port the ~30
 * regex patches verbatim.
 */

export class PatchCountError extends Error {
  readonly label: string;
  readonly expected: number;
  readonly found: number;

  constructor(label: string, expected: number, found: number) {
    super(`${label}: expected ${expected} occurrence(s), found ${found} — refusing to guess`);
    this.name = "PatchCountError";
    this.label = label;
    this.expected = expected;
    this.found = found;
  }
}

type Replacer = string | ((...match: string[]) => string);

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export class Patcher {
  src: string;
  readonly notes: string[] = [];

  constructor(src: string) {
    this.src = src;
  }

  replace(label: string, old: string, neu: string, expect: number): void {
    const hits = countOccurrences(this.src, old);
    if (hits === 0) {
      this.notes.push(`MISSED  ${label}: target not found`);
      return;
    }
    if (hits !== expect) {
      throw new PatchCountError(label, expect, hits);
    }
    this.src = this.src.split(old).join(neu);
    this.notes.push(`ok      ${label} (${hits}x)`);
  }

  replaceRe(label: string, re: RegExp, neu: Replacer, expect: number): void {
    const global = re.global ? re : new RegExp(re.source, `${re.flags}g`);
    const hits = [...this.src.matchAll(global)].length;
    if (hits === 0) {
      this.notes.push(`MISSED  ${label}: target not found`);
      return;
    }
    if (hits !== expect) {
      throw new PatchCountError(label, expect, hits);
    }
    this.src = this.src.replace(global, neu as string);
    this.notes.push(`ok      ${label} (${hits}x)`);
  }

  /** One patch whose anchor differs between Paseo versions: the first shape present wins. */
  replaceReFirst(label: string, variants: readonly { pattern: RegExp; replacement: string }[], expect: number): void {
    const variant = variants.find(({ pattern }) => this.src.search(pattern) !== -1);
    if (!variant) {
      this.notes.push(`MISSED  ${label}: target not found`);
      return;
    }
    this.replaceRe(label, variant.pattern, variant.replacement, expect);
  }

  sweepRe(label: string, re: RegExp, neu: Replacer): void {
    const global = re.global ? re : new RegExp(re.source, `${re.flags}g`);
    const hits = [...this.src.matchAll(global)].length;
    if (hits === 0) {
      this.notes.push(`MISSED  ${label}: no matching styles`);
      return;
    }
    this.src = this.src.replace(global, neu as string);
    this.notes.push(`ok      ${label} (${hits}x)`);
  }
}
