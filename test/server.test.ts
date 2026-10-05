import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BuildQueue, createHandlers } from "../index.server.ts";
import { readSettings, writeSettings } from "../server/settings-file.ts";
import { isVibrancyBuild, runningBundle } from "../server/status.ts";
import { TERMINAL_DEFAULTS, VIBRANCY_DEFAULTS } from "../shared/vibrancy.ts";
import { BUILD_STEPS } from "../shared/build-progress.ts";
import type { BuildStepId } from "../shared/build-progress.ts";
import { buildFingerprint, stampFor } from "../server/build.ts";
import { resolveTerm } from "../server/ghostty.ts";

/** Overall fraction at which `id` starts within `plan`, from the step weights. */
function stepStart(plan: readonly BuildStepId[], id: BuildStepId): number {
  const planned = BUILD_STEPS.filter((s) => plan.includes(s.id));
  const total = planned.reduce((sum, s) => sum + s.weight, 0);
  const before = planned.slice(0, planned.findIndex((s) => s.id === id));
  return before.reduce((sum, s) => sum + s.weight, 0) / total;
}

test("writeSettings then readSettings round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-file-"));
  const file = join(dir, "paseo-vibrancy.json");
  try {
    const settings = {
      material: "hud" as const,
      blurRadius: 12,
      tint: 0.4,
      paneGlass: false,
      terminal: { ...TERMINAL_DEFAULTS, cursorStyle: "block" as const, paddingLeft: 3 },
    };
    writeSettings(settings, file);
    assert.deepEqual(readSettings(file), settings);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSettings on missing file falls back to defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-file-"));
  try {
    assert.deepEqual(readSettings(join(dir, "missing.json")), VIBRANCY_DEFAULTS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runningBundle resolves the outermost .app, not a nested helper", () => {
  const execPath = "/Users/x/Applications/Paseo-Vibrancy.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";
  assert.equal(runningBundle(execPath), "/Users/x/Applications/Paseo-Vibrancy.app");
});

test("runningBundle returns null when no segment ends in .app", () => {
  assert.equal(runningBundle("/usr/local/bin/node"), null);
});

test("isVibrancyBuild is false for a dir without a stamp", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-bundle-"));
  try {
    mkdirSync(join(dir, "Contents", "Resources"), { recursive: true });
    assert.equal(isVibrancyBuild(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent build is rejected", async () => {
  const queue = new BuildQueue();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.run(async () => {
    await pending;
    return "first";
  });
  await assert.rejects(() => queue.run(async () => "second"), /build already running/);
  release();
  assert.equal(await first, "first");
});

test("build handler returns before a slow build resolves, then records the report once it finishes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const { promise: pending, resolve: release } = Promise.withResolvers<void>();
    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: "/usr/local/bin/node",
      cachedPristine: () => join(dir, "pristine.app"),
      buildStaging: async () => {
        await pending;
        return { report: ["ok      fake"], missed: false };
      },
    });

    const queued = await handlers.build({ version: "1.2.3", restart: false });
    assert.deepEqual(queued, { ok: true, report: [], error: null });
    assert.equal((await handlers.status()).building, true);

    release();
    await handlers.queue.whenIdle();

    const status = await handlers.status();
    assert.equal(status.building, false);
    assert.equal(status.lastError, null);
    assert.deepEqual(status.lastReport, ["ok      fake"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build handler rejects a concurrent call immediately instead of queuing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const { promise: pending, resolve: release } = Promise.withResolvers<void>();
    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: "/usr/local/bin/node",
      cachedPristine: () => join(dir, "pristine.app"),
      buildStaging: async () => {
        await pending;
        return { report: ["ok      fake"], missed: false };
      },
    });

    await handlers.build({ version: "1.2.3", restart: false });
    const rejected = await handlers.build({ version: "1.2.3", restart: false });
    assert.deepEqual(rejected, { ok: false, report: [], error: "build already running" });

    release();
    await handlers.queue.whenIdle();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a thrown build error records lastError and the partial report attached to it, never escapes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: "/usr/local/bin/node",
      cachedPristine: () => join(dir, "pristine.app"),
      buildStaging: async () => {
        throw Object.assign(new Error("ditto failed"), { report: ["ok      asar"] });
      },
    });

    const queued = await handlers.build({ version: "1.2.3", restart: false });
    assert.equal(queued.ok, true);

    await handlers.queue.whenIdle();

    const status = await handlers.status();
    assert.equal(status.lastError, "ditto failed");
    assert.deepEqual(status.lastReport, ["ok      asar"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build handler never restarts when restart is false, even with no running bundle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    let swapped = false;
    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: "/usr/local/bin/node",
      cachedPristine: () => join(dir, "pristine.app"),
      buildStaging: async () => ({ report: ["ok      fake"], missed: false }),
      startSwap: () => {
        swapped = true;
      },
    });

    await handlers.build({ version: "1.2.3", restart: false });
    await handlers.queue.whenIdle();
    assert.equal((await handlers.status()).lastError, null);
    assert.equal(swapped, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart:true calls startSwap only once the build succeeds, never on failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    let swapped = false;
    const failing = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: "/usr/local/bin/node",
      cachedPristine: () => join(dir, "pristine.app"),
      buildStaging: async () => {
        throw new Error("codesign failed");
      },
      startSwap: () => {
        swapped = true;
      },
    });
    await failing.build({ version: "1.2.3", restart: true });
    await failing.queue.whenIdle();
    assert.equal(swapped, false);

    const succeeding = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: "/usr/local/bin/node",
      cachedPristine: () => join(dir, "pristine.app"),
      buildStaging: async () => ({ report: ["ok      fake"], missed: false }),
      startSwap: () => {
        swapped = true;
      },
    });
    await succeeding.build({ version: "1.2.3", restart: true });
    await succeeding.queue.whenIdle();
    assert.equal(swapped, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status reports the build step a running rebuild is in, past the previous step and short of the next", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const { promise: pending, resolve: release } = Promise.withResolvers<void>();
    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: "/usr/local/bin/node",
      cachedPristine: () => join(dir, "pristine.app"),
      buildStaging: async ({ onStep }) => {
        onStep?.("copy");
        onStep?.("patch");
        await pending;
        onStep?.("compile");
        onStep?.("sign");
        return { report: ["ok      fake"], missed: false };
      },
    });

    await handlers.build({ version: "1.2.3", restart: false });
    const { progress } = await handlers.status();
    const plan: BuildStepId[] = ["copy", "patch", "compile", "sign"];
    assert.equal(progress?.step, "patch");
    assert.equal(progress.detail, null);
    assert.ok(progress.fraction > stepStart(plan, "copy"), `${progress.fraction}`);
    assert.ok(progress.fraction < stepStart(plan, "compile"), `${progress.fraction}`);

    release();
    await handlers.queue.whenIdle();
    assert.equal((await handlers.status()).progress, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status reports download progress, weighted into the whole update, while a release downloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const { promise: pending, resolve: release } = Promise.withResolvers<void>();
    const { promise: downloading, resolve: reachedDownload } = Promise.withResolvers<void>();
    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: "/usr/local/bin/node",
      cachedPristine: () => null,
      fetchRelease: async (version) => ({ version, zipUrl: "http://127.0.0.1:1/x.zip", sha512: "x", size: 186e6 }),
      downloadVerified: async (_release, _cacheDir, onProgress) => {
        onProgress?.("download", 0.45, "84 / 186 MB");
        reachedDownload();
        await pending;
        return join(dir, "pristine.app");
      },
      buildStaging: async () => ({ report: ["ok      fake"], missed: false }),
    });

    await handlers.build({ version: "1.2.3", restart: false });
    await downloading;
    const { progress } = await handlers.status();
    const plan: BuildStepId[] = ["download", "extract", "verify", "copy", "patch", "compile", "sign"];
    assert.equal(progress?.step, "download");
    assert.equal(progress.detail, "84 / 186 MB");
    assert.ok(progress.fraction > stepStart(plan, "download"), `${progress.fraction}`);
    assert.ok(progress.fraction < stepStart(plan, "extract"), `${progress.fraction}`);

    release();
    await handlers.queue.whenIdle();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed build clears progress", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: "/usr/local/bin/node",
      cachedPristine: () => join(dir, "pristine.app"),
      buildStaging: async ({ onStep }) => {
        onStep?.("copy");
        onStep?.("patch");
        throw new Error("asar anchor missing");
      },
    });

    await handlers.build({ version: "1.2.3", restart: true });
    await handlers.queue.whenIdle();
    const status = await handlers.status();
    assert.equal(status.lastError, "asar anchor missing");
    assert.equal(status.progress, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a successful restart build leaves progress on the restart step", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: "/usr/local/bin/node",
      cachedPristine: () => join(dir, "pristine.app"),
      buildStaging: async ({ onStep }) => {
        onStep?.("copy");
        onStep?.("sign");
        return { report: ["ok      fake"], missed: false };
      },
      startSwap: () => {},
    });

    await handlers.build({ version: "1.2.3", restart: true });
    await handlers.queue.whenIdle();
    assert.deepEqual((await handlers.status()).progress, { step: "restart", fraction: 1, detail: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build handler defaults version to the running bundle's version when none is requested", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const bundle = join(dir, "Paseo.app");
    mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    const plist = `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>`;
    writeFileSync(join(bundle, "Contents", "Info.plist"), plist, "utf8");

    const requestedVersions: Array<string | undefined> = [];
    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: join(bundle, "Contents", "MacOS", "Paseo"),
      cachedPristine: (version) => {
        requestedVersions.push(version);
        return join(dir, "pristine.app");
      },
      buildStaging: async () => ({ report: ["ok      fake"], missed: false }),
    });

    await handlers.build({ restart: false });
    await handlers.queue.whenIdle();

    assert.deepEqual(requestedVersions, ["1.2.3"]);
    assert.equal((await handlers.status()).lastError, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status reflects an injected non-vibrancy running bundle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const bundle = join(dir, "Paseo.app");
    mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    const plist = `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>`;
    writeFileSync(join(bundle, "Contents", "Info.plist"), plist, "utf8");

    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: join(bundle, "Contents", "MacOS", "Paseo"),
    });

    const status = await handlers.status();
    assert.equal(status.runningVersion, "1.2.3");
    assert.equal(status.runningVibrancyBuild, false);
    assert.equal(status.builtFrom, null);
    assert.equal(status.fingerprintMatches, false);
    assert.equal(status.building, false);
    assert.equal(status.latest, null);
    assert.deepEqual(status.lastReport, []);
    assert.equal(status.lastError, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getSettings/setSettings round-trip through the handlers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const handlers = createHandlers({ settingsFile: join(dir, "paseo-vibrancy.json") });
    assert.deepEqual(await handlers.getSettings(), VIBRANCY_DEFAULTS);

    const settings = {
      material: "sidebar" as const,
      blurRadius: 20,
      tint: 0.6,
      paneGlass: false,
      terminal: { ...TERMINAL_DEFAULTS, ansi: "paseo" as const, fontSize: null },
    };
    const written = await handlers.setSettings(settings);
    assert.deepEqual(written, settings);
    assert.deepEqual(await handlers.getSettings(), settings);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkUpdate handler records the release for status to report as latest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const release = { version: "9.9.9", zipUrl: "https://example.com/x.zip", sha512: "abc", size: 1 };
    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: "/usr/local/bin/node",
      checkLatest: async () => ({ release, error: null }),
    });

    const result = await handlers.checkUpdate();
    assert.deepEqual(result, { release, error: null });
    assert.deepEqual((await handlers.status()).latest, release);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status: saving a different terminal setting makes fingerprintMatches false for an old stamp", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const bundle = join(dir, "Paseo.app");
    mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    const plist = `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>`;
    writeFileSync(join(bundle, "Contents", "Info.plist"), plist, "utf8");

    const ghosttyPath = join(dir, "no-ghostty");
    const fingerprint = buildFingerprint(resolveTerm(TERMINAL_DEFAULTS, ghosttyPath).term);
    writeFileSync(join(bundle, "Contents", "Resources", ".vibrancy-build"), stampFor("1.2.3", fingerprint) + "\n", "utf8");

    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: join(bundle, "Contents", "MacOS", "Paseo"),
      ghosttyPath,
    });

    const before = await handlers.status();
    assert.equal(before.runningVibrancyBuild, true);
    assert.equal(before.fingerprintMatches, true);
    assert.deepEqual(before.ghosttyOverrides, []);

    await handlers.setSettings({ ...VIBRANCY_DEFAULTS, terminal: { ...TERMINAL_DEFAULTS, lineHeight: 1.4 } });
    assert.equal((await handlers.status()).fingerprintMatches, false);

    await handlers.setSettings({ ...VIBRANCY_DEFAULTS, terminal: { ...TERMINAL_DEFAULTS } });
    assert.equal((await handlers.status()).fingerprintMatches, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status reports which terminal settings the Ghostty config overrides", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath: "/usr/local/bin/node",
      ghosttyPath: `${import.meta.dirname}/fixtures/ghostty-config`,
    });
    assert.deepEqual([...(await handlers.status()).ghosttyOverrides].sort(), ["cursorStyle", "fontFamily", "lineHeight"]);

    await handlers.setSettings({ ...VIBRANCY_DEFAULTS, terminal: { ...TERMINAL_DEFAULTS, followGhostty: false } });
    assert.deepEqual((await handlers.status()).ghosttyOverrides, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
