import { test } from "node:test";
import assert from "node:assert/strict";

import { Patcher, PatchCountError } from "../server/patch-engine.ts";
import { ASAR_HOOK_ANCHOR, ASAR_HOOK_LINE, patchAsar } from "../server/asar.ts";

test("replaceRe with 0 hits adds a MISSED note and leaves src unchanged", () => {
  const patcher = new Patcher("no match here");
  patcher.replaceRe("missing thing", /nope/g, "x", 1);
  assert.deepEqual(patcher.notes, ["MISSED  missing thing: target not found"]);
  assert.equal(patcher.src, "no match here");
});

test("replaceRe with 2 hits and expect 1 throws PatchCountError with the given label", () => {
  const patcher = new Patcher("foo foo");
  assert.throws(
    () => patcher.replaceRe("double foo", /foo/g, "bar", 1),
    (error: unknown) => {
      assert.ok(error instanceof PatchCountError);
      assert.equal(error.label, "double foo");
      assert.equal(error.expected, 1);
      assert.equal(error.found, 2);
      return true;
    },
  );
});

test("sweepRe reports (3x) and rewrites every match", () => {
  const patcher = new Patcher("a-hover b-hover c-hover");
  patcher.sweepRe("hover sweep", /(\w)-hover/g, "$1-glow");
  assert.deepEqual(patcher.notes, ["ok      hover sweep (3x)"]);
  assert.equal(patcher.src, "a-glow b-glow c-glow");
});

test("sweepRe with no matches adds a 'no matching styles' MISSED note", () => {
  const patcher = new Patcher("nothing to see");
  patcher.sweepRe("hover sweep", /(\w)-hover/g, "$1-glow");
  assert.deepEqual(patcher.notes, ["MISSED  hover sweep: no matching styles"]);
  assert.equal(patcher.src, "nothing to see");
});

test("replaceReFirst applies the first variant whose shape is present, else reports MISSED", () => {
  const variants = [
    { pattern: /old-(\w)/g, replacement: "was-$1" },
    { pattern: /new-(\w)/g, replacement: "now-$1" },
  ];
  const patcher = new Patcher("new-a");
  patcher.replaceReFirst("shape", variants, 1);
  assert.equal(patcher.src, "now-a");
  assert.deepEqual(patcher.notes, ["ok      shape (1x)"]);

  const absent = new Patcher("neither");
  absent.replaceReFirst("shape", variants, 1);
  assert.equal(absent.src, "neither");
  assert.deepEqual(absent.notes, ["MISSED  shape: target not found"]);
});

test("ASAR_HOOK_LINE is 79 bytes", () => {
  assert.equal(ASAR_HOOK_LINE.length, 79);
});

test("patchAsar replaces the anchor, keeps length, and space-pads the tail", () => {
  const input = Buffer.from(`xx${ASAR_HOOK_ANCHOR}yy`, "utf8");
  const { data, notes } = patchAsar(input);
  assert.equal(data.length, input.length);
  assert.ok(data.toString("utf8").includes(ASAR_HOOK_LINE));
  assert.ok(data.toString("utf8").endsWith(" yy"));
  assert.deepEqual(notes, ["ok      window transparency (1x)"]);
});

test("patchAsar without the anchor returns the buffer unchanged with a MISSED note", () => {
  const input = Buffer.from("no anchor in here", "utf8");
  const { data, notes } = patchAsar(input);
  assert.deepEqual(data, input);
  assert.deepEqual(notes, ["MISSED  window transparency: target not found"]);
});
