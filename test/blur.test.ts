import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileBlur } from "../server/blur.ts";

interface BlurExports {
  setBlur: (handle: Buffer, radius: number) => boolean;
  matchCorners: (handle: Buffer) => boolean;
}

test("compileBlur compiles blur.node and its exports reject a null-pointer buffer without crashing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-blur-"));
  const dest = join(dir, "blur.node");
  try {
    const note = await compileBlur(dest);
    assert.equal(note, "ok      window blur (compiled)");

    const addon = { exports: {} as BlurExports };
    process.dlopen(addon as unknown as NodeJS.Module, dest);

    assert.equal(typeof addon.exports.setBlur, "function");
    assert.equal(addon.exports.setBlur(Buffer.alloc(8), 30), false);
    assert.equal(addon.exports.matchCorners(Buffer.alloc(8)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
