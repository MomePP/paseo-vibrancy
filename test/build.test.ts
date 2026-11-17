import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  STAMP_NAME,
  asarIntegrityFuse,
  buildFingerprint,
  buildStaging,
  serialiseFingerprintInputs,
  signAdHoc,
  stampFor,
} from "../server/build.ts";
import { resolveTerm } from "../server/ghostty.ts";
import type { TermMetrics } from "../server/ghostty.ts";
import { appVersion, bundleIdentifier, resourcesDir } from "../server/layout.ts";
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

/** Electron's fuse wire as electron-builder bakes it: sentinel, version 1, nine fuses. */
function fuseWire(fuses: string): Buffer {
  return Buffer.concat([Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"), Buffer.from([1, fuses.length]), Buffer.from(fuses)]);
}

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

test("fingerprint serialisation is sensitive to DEAD_UPDATE_YML, ASAR_HOOK_ANCHOR, BLUR_CLANG_ARGS and DESIGNATED_REQUIREMENT", () => {
  const base = serialiseFingerprintInputs(BASE_TERM);
  assert.notEqual(base, serialiseFingerprintInputs(BASE_TERM, { deadUpdateYml: "something else" }));
  assert.notEqual(base, serialiseFingerprintInputs(BASE_TERM, { asarHookAnchor: "something else" }));
  assert.notEqual(base, serialiseFingerprintInputs(BASE_TERM, { blurClangArgs: ["something", "else"] }));
  assert.notEqual(base, serialiseFingerprintInputs(BASE_TERM, { designatedRequirement: "something else" }));
});

test('stampFor joins version and fingerprint as "<ver>|vibrancy=<hash>"', () => {
  assert.equal(stampFor("0.11.0-beta.3", "abc"), "0.11.0-beta.3|vibrancy=abc");
});

test("failed build leaves target untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-build-"));
  const source = join(dir, "NotAnApp.app");
  const staging = join(dir, "staging.app");
  mkdirSync(resourcesDir(source), { recursive: true });
  // No app.asar inside — buildStaging must reject before ever signing.
  try {
    await assert.rejects(() => buildStaging({ source, staging }));
    assert.equal(existsSync(staging), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("asarIntegrityFuse reads the fuse, including a wire split across read chunks, and null without one", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-fuse-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const chunk = 4 << 20;

  const off = join(dir, "off.exe");
  writeFileSync(off, Buffer.concat([Buffer.alloc(1000), fuseWire("101100011"), Buffer.alloc(1000)]));
  assert.equal(asarIntegrityFuse(off), "0");

  // The sentinel starts 10 bytes before the first chunk ends.
  const straddling = join(dir, "straddling.exe");
  writeFileSync(straddling, Buffer.concat([Buffer.alloc(chunk - 10), fuseWire("101110011"), Buffer.alloc(100)]));
  assert.equal(asarIntegrityFuse(straddling), "1");

  const none = join(dir, "none.exe");
  writeFileSync(none, Buffer.alloc(chunk + 100));
  assert.equal(asarIntegrityFuse(none), null);
});

test("a Windows build refuses an exe whose asar-integrity fuse is on, before copying anything", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "Paseo");
  mkdirSync(join(source, "resources"), { recursive: true });
  writeFileSync(join(source, "Paseo.exe"), fuseWire("101110011"));
  writeFileSync(join(source, "resources", "app.asar"), "");
  const staging = join(dir, "staging");

  await assert.rejects(
    () => buildStaging({ source, staging, platform: "win32" }),
    /Paseo\.exe validates app\.asar's integrity \(fuse 1\)/,
  );
  assert.equal(existsSync(staging), false);
});

const onMac = { skip: process.platform !== "darwin" ? "macOS only (codesign)" : false };

function fakeBundle(app: string, id: string): void {
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>main</string>
<key>CFBundleIdentifier</key><string>${id}</string>
</dict></plist>
`,
  );
  copyFileSync("/usr/bin/true", join(app, "Contents", "MacOS", "main"));
}

async function designatedRequirement(code: string): Promise<string> {
  return (await execFileAsync("codesign", ["-d", "-r-", code])).stdout.trim();
}

async function cdhash(code: string): Promise<string> {
  const { stderr } = await execFileAsync("codesign", ["-dvvv", code]);
  return /^CDHash=(\w+)$/m.exec(stderr)![1]!;
}

test("a rebuilt copy keeps its identifier-only designated requirement, so privacy grants survive", onMac, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-sign-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, "Fake.app");
  const helper = join(app, "Contents", "Frameworks", "Fake Helper.app");
  fakeBundle(app, "test.vibrancy.fake");
  fakeBundle(helper, "test.vibrancy.fake.helper");
  const stamp = join(app, "Contents", "Resources", STAMP_NAME);
  mkdirSync(join(app, "Contents", "Resources"));

  writeFileSync(stamp, "first build\n");
  await signAdHoc(app);
  const firstHash = await cdhash(app);
  assert.equal(await designatedRequirement(app), 'designated => identifier "test.vibrancy.fake"');
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", app]);
  assert.doesNotMatch(await designatedRequirement(helper), /identifier "test\.vibrancy\.fake"$/);

  writeFileSync(stamp, "second build\n");
  await signAdHoc(app);
  assert.notEqual(await cdhash(app), firstHash);
  assert.equal(await designatedRequirement(app), 'designated => identifier "test.vibrancy.fake"');
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", app]);
});

const pristine = process.env.VIBRANCY_PRISTINE;

async function realBuild(settings: { terminal: Partial<TerminalSettings> } | null) {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-build-pristine-"));
  const staging = join(dir, process.platform === "win32" ? "staging" : "staging.app");
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

    const resources = resourcesDir(staging);
    assert.equal(existsSync(join(resources, "pv.js")), true);
    if (process.platform === "darwin") {
      await execFileAsync("codesign", ["--verify", "--deep", "--strict", staging]);
      assert.equal(await designatedRequirement(staging), `designated => identifier "${bundleIdentifier(pristine!)}"`);
      assert.equal(existsSync(join(resources, "blur.node")), true);
    } else {
      assert.equal(existsSync(join(resources, "blur.node")), false);
    }

    const stamp = readFileSync(join(resources, ".vibrancy-build"), "utf8");
    assert.ok(stamp.startsWith(`${appVersion(pristine!)}|vibrancy=`), stamp);
    return { report, stamp };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pristineSkip = pristine ? false : "set VIBRANCY_PRISTINE=<path to a verified pristine Paseo.app or Windows install> to run";

test("builds a pristine release cleanly", { skip: pristineSkip }, async () => {
  const { report } = await realBuild(null);
  assert.equal(report.some((note) => note.startsWith("ok      oxocarbon ANSI")), true);
});

test("builds a pristine release cleanly with the stock palette and non-default terminal metrics", { skip: pristineSkip }, async () => {
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
});
