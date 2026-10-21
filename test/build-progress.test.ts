import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPlan, overallFraction } from "../shared/build-progress.ts";
import type { BuildStepId } from "../shared/build-progress.ts";

test("a rebuild from cache plans copy through sign; an update plans download through sign", () => {
  assert.deepEqual(buildPlan(false, "darwin"), ["copy", "patch", "compile", "sign"]);
  assert.deepEqual(buildPlan(true, "darwin"), ["download", "extract", "verify", "copy", "patch", "compile", "sign"]);
});

test("Windows plans no signature check, blur compile or signing", () => {
  assert.deepEqual(buildPlan(false, "win32"), ["copy", "patch"]);
  assert.deepEqual(buildPlan(true, "win32"), ["download", "extract", "copy", "patch"]);
});

test("overallFraction is 0 at the first planned step and 1 once the last finishes", () => {
  for (const plan of [buildPlan(false, "darwin"), buildPlan(true, "darwin"), buildPlan(false, "win32"), buildPlan(true, "win32")]) {
    assert.equal(overallFraction(plan, plan[0]!, 0), 0);
    assert.equal(overallFraction(plan, plan.at(-1)!, 1), 1);
  }
});

test("overallFraction climbs monotonically through a download-plan run", () => {
  const plan = buildPlan(true, "darwin");
  const run: Array<[BuildStepId, number]> = [
    ["download", 0],
    ["download", 0.1],
    ["download", 0.6],
    ["download", 1],
    ["extract", 0],
    ["verify", 0],
    ["copy", 0],
    ["patch", 0],
    ["compile", 0],
    ["sign", 0],
    ["sign", 1],
  ];
  const fractions = run.map(([step, fraction]) => overallFraction(plan, step, fraction));
  for (let i = 1; i < fractions.length; i++) {
    assert.ok(fractions[i] >= fractions[i - 1], `${run[i].join(" ")}: ${fractions[i]} < ${fractions[i - 1]}`);
  }
  assert.equal(fractions.at(-1), 1);
});

test("overallFraction rejects a step outside the plan", () => {
  assert.throws(() => overallFraction(buildPlan(false, "darwin"), "download", 0.5), /not in the build plan/);
  assert.throws(() => overallFraction(buildPlan(true, "win32"), "sign", 0), /not in the build plan/);
});
