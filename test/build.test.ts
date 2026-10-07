import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { appVersion, buildFingerprint, buildStaging, serialiseFingerprintInputs, stampFor } from "../server/build.ts";
import { resolveTerm } from "../server/ghostty.ts";
import type { TermMetrics } from "../server/ghostty.ts";
import { writeSettings } from "../server/settings-file.ts";
import { TERMINAL_DEFAULTS, parseVibrancy } from "../shared/vibrancy.ts";
import type { TerminalSettings } from "../shared/vibrancy.ts";

const execFileAsync = promisify(execFile);

const MISSING_GHOSTTY = "/nonexistent/ghostty-config";

const BASE_TERM: TermMetrics = {
  fontSize: 13.5,
  lineHeight: 1.1,
  padding: "0 0 0 10px",
  cursorStyle: "bar",
  fontFamily: null,
  fontWeight: 400,
  fontWeightBold: 600,
  ansi: "oxocarbon",
};

test("buildFingerprint changes with term", () => {
  const a = buildFingerprint(BASE_TERM);
  const b = buildFingerprint({ ...BASE_TERM, lineHeight: 1.08 });
  assert.notEqual(a, b);
  assert.equal(a, buildFingerprint({ ...BASE_TERM }));
  assert.match(a, /^[0-9a-f]{12}$/);
});

test("buildFingerprint changes when any terminal setting changes, including ansi", () => {
  const base = buildFingerprint(resolveTerm(TERMINAL_DEFAULTS, MISSING_GHOSTTY).term);
  const changes: Partial<TerminalSettings>[] = [
    { fontSize: 14 },
    { fontSize: null },
    { lineHeight: 1.3 },
    { fontWeight: 300 },
    { fontWeightBold: 700 },
    { cursorStyle: "block" },
    { paddingLeft: 12 },
    { ansi: "paseo" },
  ];
  for (const change of changes) {
    const next = buildFingerprint(resolveTerm({ ...TERMINAL_DEFAULTS, ...change }, MISSING_GHOSTTY).term);
    assert.notEqual(next, base, JSON.stringify(change));
  }
});

test("fingerprint serialisation is sensitive to DEAD_UPDATE_YML, ASAR_HOOK_ANCHOR and BLUR_CLANG_ARGS", () => {
  const base = serialiseFingerprintInputs(BASE_TERM);
  assert.notEqual(base, serialiseFingerprintInputs(BASE_TERM, { deadUpdateYml: "something else" }));
  assert.notEqual(base, serialiseFingerprintInputs(BASE_TERM, { asarHookAnchor: "something else" }));
  assert.notEqual(base, serialiseFingerprintInputs(BASE_TERM, { blurClangArgs: ["something", "else"] }));
});

test('stampFor joins version and fingerprint as "<ver>|vibrancy=<hash>"', () => {
  assert.equal(stampFor("0.11.0-beta.3", "abc"), "0.11.0-beta.3|vibrancy=abc");
});

test("failed build leaves target untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-build-"));
  const source = join(dir, "NotAnApp.app");
  const staging = join(dir, "staging.app");
  mkdirSync(join(source, "Contents", "Resources"), { recursive: true });
  // No app.asar inside — buildStaging must reject before ever signing.
  try {
    await assert.rejects(() => buildStaging({ source, staging }));
    assert.equal(existsSync(staging), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const pristine = process.env.VIBRANCY_PRISTINE;

async function realBuild(settings: { terminal: Partial<TerminalSettings> } | null) {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-build-pristine-"));
  const staging = join(dir, "staging.app");
  const settingsFile = join(dir, "paseo-vibrancy.json");
  try {
    if (settings) {
      writeSettings(parseVibrancy(settings), settingsFile);
    }
    const { report, missed } = await buildStaging({
      source: pristine!,
      staging,
      settingsFile,
      ghosttyPath: join(dir, "no-ghostty-config"),
    });

    const missedNotes = report.filter((note) => note.startsWith("MISSED"));
    assert.deepEqual(missedNotes, []);
    assert.equal(missed, false);

    await execFileAsync("codesign", ["--verify", "--deep", "--strict", staging]);

    assert.equal(existsSync(join(staging, "Contents", "Resources", "pv.js")), true);
    assert.equal(existsSync(join(staging, "Contents", "Resources", "blur.node")), true);

    const stamp = readFileSync(join(staging, "Contents", "Resources", ".vibrancy-build"), "utf8");
    assert.ok(stamp.startsWith(`${appVersion(pristine!)}|vibrancy=`), stamp);
    return { report, stamp };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "builds a pristine release cleanly",
  { skip: pristine ? false : "set VIBRANCY_PRISTINE=<path to a verified pristine Paseo.app> to run" },
  async () => {
    const { report } = await realBuild(null);
    assert.equal(report.some((note) => note.startsWith("ok      oxocarbon ANSI")), true);
  },
);

test(
  "builds a pristine release cleanly with the stock palette and non-default terminal metrics",
  { skip: pristine ? false : "set VIBRANCY_PRISTINE=<path to a verified pristine Paseo.app> to run" },
  async () => {
    const { report } = await realBuild({
      terminal: {
        followGhostty: false,
        ansi: "paseo",
        fontSize: null,
        lineHeight: 1.3,
        fontWeight: 300,
        fontWeightBold: 800,
        cursorStyle: "block",
        paddingLeft: 24,
      },
    });
    assert.equal(report.some((note) => note.includes("oxocarbon ANSI")), false);
  },
);
