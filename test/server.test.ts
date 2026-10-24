import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BuildQueue, createHandlers } from "../index.server.ts";
import { resourcesDir } from "../server/layout.ts";
import { readSettings, writeSettings } from "../server/settings-file.ts";
import { isVibrancyBuild, runningBundle } from "../server/status.ts";
import { TERMINAL_DEFAULTS, VIBRANCY_DEFAULTS, materialsFor } from "../shared/vibrancy.ts";
import { HOST_PLATFORM } from "../shared/platform.ts";
import { BUILD_STEPS, buildPlan } from "../shared/build-progress.ts";
import type { BuildStepId } from "../shared/build-progress.ts";
import { buildFingerprint, stampFor } from "../server/build.ts";
import { resolveTerm } from "../server/ghostty.ts";
import { fakeInstall } from "./fake-install.ts";

/** Overall fraction at which `id` starts within `plan`, from the step weights; 1 past the last step. */
function stepStart(plan: readonly BuildStepId[], id: BuildStepId | undefined): number {
  const planned = BUILD_STEPS.filter((s) => plan.includes(s.id));
  const total = planned.reduce((sum, s) => sum + s.weight, 0);
  const index = planned.findIndex((s) => s.id === id);
  const before = index === -1 ? planned : planned.slice(0, index);
  return before.reduce((sum, s) => sum + s.weight, 0) / total;
}

/** The step after `id` in `plan`, or undefined when `id` is last. */
function nextStep(plan: readonly BuildStepId[], id: BuildStepId): BuildStepId | undefined {
  return plan[plan.indexOf(id) + 1];
}

/** A material this host's schema accepts other than the default. */
const OTHER_MATERIAL = materialsFor(HOST_PLATFORM).find((material) => material !== VIBRANCY_DEFAULTS.material)!;

test("writeSettings then readSettings round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-file-"));
  const file = join(dir, "paseo-vibrancy.json");
  try {
    const settings = {
      material: OTHER_MATERIAL,
      blurRadius: 12,
      tint: 0.4,
      paneGlass: false,
      openFilesInNewTab: false,
      webHidChooser: false,
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
  assert.equal(runningBundle(execPath, "darwin"), "/Users/x/Applications/Paseo-Vibrancy.app");
});

test("runningBundle returns null when no segment ends in .app", () => {
  assert.equal(runningBundle("/usr/local/bin/node", "darwin"), null);
});

test("runningBundle on Windows is the folder holding Paseo.exe, whatever its case, and null for plain Node", () => {
  assert.equal(
    runningBundle("C:\\Users\\x\\AppData\\Local\\Programs\\Paseo-Vibrancy\\Paseo.exe", "win32"),
    "C:\\Users\\x\\AppData\\Local\\Programs\\Paseo-Vibrancy",
  );
  assert.equal(runningBundle("C:\\Program Files\\Paseo\\PASEO.EXE", "win32"), "C:\\Program Files\\Paseo");
  assert.equal(runningBundle("C:\\Program Files\\nodejs\\node.exe", "win32"), null);
});

test("isVibrancyBuild is false for a dir without a stamp", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-bundle-"));
  try {
    mkdirSync(resourcesDir(dir), { recursive: true });
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
        return { report: ["ok      fake"], missed: false };
      },
    });

    await handlers.build({ version: "1.2.3", restart: false });
    const { progress } = await handlers.status();
    const plan = buildPlan(false);
    assert.equal(progress?.step, "patch");
    assert.equal(progress.detail, null);
    assert.ok(progress.fraction > stepStart(plan, "copy"), `${progress.fraction}`);
    assert.ok(progress.fraction < stepStart(plan, nextStep(plan, "patch")), `${progress.fraction}`);

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
      fetchRelease: async (version) => ({ version, zipUrl: "http://127.0.0.1:1/x.zip", size: 186e6, algorithm: "sha512" as const, digest: "x" }),
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
    const plan = buildPlan(true);
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
        onStep?.("patch");
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
    const { execPath } = fakeInstall(dir, "1.2.3");

    const requestedVersions: Array<string | undefined> = [];
    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath,
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

test("restart hands startSwap the running install's executable and the install to reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const { app, execPath } = fakeInstall(dir, "1.2.3");
    const swaps: Array<{ runningExe?: string; previousApp?: string }> = [];
    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath,
      cachedPristine: () => join(dir, "pristine.app"),
      buildStaging: async () => ({ report: ["ok      fake"], missed: false }),
      startSwap: ({ runningExe, previousApp }) => {
        swaps.push({ runningExe, previousApp });
      },
    });

    await handlers.build({ restart: true });
    await handlers.queue.whenIdle();

    assert.deepEqual(swaps, [{ runningExe: execPath, previousApp: app }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status reflects an injected non-vibrancy running bundle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const { execPath } = fakeInstall(dir, "1.2.3");

    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath,
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
      material: OTHER_MATERIAL,
      blurRadius: 20,
      tint: 0.6,
      paneGlass: false,
      openFilesInNewTab: false,
      webHidChooser: false,
      terminal: { ...TERMINAL_DEFAULTS, ansi: "paseo" as const, fontSize: null },
    };
    const written = await handlers.setSettings(settings);
    assert.deepEqual(written, settings);
    assert.deepEqual(await handlers.getSettings(), settings);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setSettings narrows a material from the other OS to this host's default, and status names the host's OS", async () => {
  // A client on another device (a browser, a phone) offers its own idea of
  // the materials; what gets saved must still be one this host can apply.
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const handlers = createHandlers({ settingsFile: join(dir, "paseo-vibrancy.json"), execPath: "/usr/local/bin/node" });
    const foreign = HOST_PLATFORM === "win32" ? "hud" : "mica";

    const written = await handlers.setSettings({ ...VIBRANCY_DEFAULTS, material: foreign, tint: 0.4 });
    assert.equal(written.material, VIBRANCY_DEFAULTS.material);
    assert.equal(written.tint, 0.4);
    assert.deepEqual(readSettings(join(dir, "paseo-vibrancy.json")), written);
    assert.equal((await handlers.status()).platform, HOST_PLATFORM);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkUpdate handler records the release for status to report as latest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-handlers-"));
  try {
    const release = { version: "9.9.9", zipUrl: "https://example.com/x.zip", size: 1, algorithm: "sha512" as const, digest: "abc" };
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
    const { app, execPath } = fakeInstall(dir, "1.2.3");

    const ghosttyPath = join(dir, "no-ghostty");
    const fingerprint = buildFingerprint(resolveTerm(TERMINAL_DEFAULTS, ghosttyPath).term);
    writeFileSync(join(resourcesDir(app), ".vibrancy-build"), stampFor("1.2.3", fingerprint) + "\n", "utf8");

    const handlers = createHandlers({
      settingsFile: join(dir, "paseo-vibrancy.json"),
      execPath,
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
