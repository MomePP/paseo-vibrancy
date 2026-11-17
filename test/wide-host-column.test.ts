import { test } from "node:test";
import assert from "node:assert/strict";

import { WIDE_SETTINGS_MAX, findWidthCap } from "../client/wide-host-column.ts";
import type { WidthCapNode } from "../client/wide-host-column.ts";

interface FakeNode extends WidthCapNode {
  name: string;
  maxWidth: string;
  parentElement: FakeNode | null;
}

function innermostOf(...ancestors: Array<[string, string]>): FakeNode {
  let parent: FakeNode | null = null;
  for (const [name, maxWidth] of ancestors) {
    parent = { name, maxWidth, parentElement: parent, style: { maxWidth: "" } };
  }
  return parent!;
}

const read = (node: FakeNode) => node.maxWidth;

test("finds Paseo's page column above the plugin's wrappers", () => {
  const root = innermostOf(
    ["scroll", "none"],
    ["page", "1080px"],
    ["settings-content", "none"],
    ["error-boundary", "none"],
    ["plugin-root", "none"],
  );
  assert.equal(findWidthCap(root, read)?.name, "page");
});

test("does not count the node it starts from", () => {
  const root = innermostOf(["page", "none"], ["plugin-root", "600px"]);
  assert.equal(findWidthCap(root, read), null);
});

test("ignores percentages and leaves a host that is already wide enough alone", () => {
  assert.equal(findWidthCap(innermostOf(["page", "100%"], ["root", "none"]), read), null);
  assert.equal(findWidthCap(innermostOf(["page", `${WIDE_SETTINGS_MAX}px`], ["root", "none"]), read), null);
  assert.equal(findWidthCap(innermostOf(["outer", "720px"], ["page", "1600px"], ["root", "none"]), read), null);
});

test("gives up after a bounded number of ancestors", () => {
  const pairs: Array<[string, string]> = [["far", "720px"]];
  for (let index = 0; index < 20; index += 1) pairs.push([`wrapper-${index}`, "none"]);
  assert.equal(findWidthCap(innermostOf(...pairs), read), null);
});
