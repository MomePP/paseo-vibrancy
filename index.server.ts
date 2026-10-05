/**
 * Server entry: registers the five `shared/rpc.ts` contracts against live
 * (or injected, for tests) release/build/swap dependencies, serialises
 * builds through a single-flight queue, and keeps the small bits of
 * in-process state (`latest`, `lastReport`, `lastError`) `vibrancy.status`
 * reports.
 *
 * `vibrancy.build` returns as soon as a build is queued (or rejects
 * immediately if one is already running) rather than waiting for it to
 * finish: Paseo's daemon rejects plugin RPCs that run past its 30 s
 * timeout, and an Update (~186 MB download + ditto + `codesign --deep`
 * verify + build) routinely exceeds that. The actual work runs in the
 * background through `queue`; its outcome lands in `lastReport`/`lastError`
 * for the client to pick up by polling `vibrancy.status`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PluginCleanup } from "@getpaseo/plugin";

import { DEFAULT_STAGING, appVersion, buildFingerprint, buildStaging as buildStagingDefault, execName } from "./server/build.ts";
import { DEFAULT_SETTINGS_FILE, readSettings, writeSettings } from "./server/settings-file.ts";
import { resolveTerm } from "./server/ghostty.ts";
import {
  DEFAULT_CACHE_DIR,
  cachedPristine as cachedPristineDefault,
  checkLatest as checkLatestDefault,
  downloadVerified as downloadVerifiedDefault,
  fetchRelease as fetchReleaseDefault,
} from "./server/release.ts";
import { isVibrancyBuild, readStamp, runningBundle } from "./server/status.ts";
import { startSwap as startSwapDefault } from "./server/swap.ts";
import { buildRpc, checkUpdateRpc, getSettingsRpc, setSettingsRpc, statusRpc } from "./shared/rpc.ts";
import type { Release } from "./shared/rpc.ts";
import type { VibrancySettings } from "./shared/vibrancy.ts";

export const DEFAULT_TARGET = join(homedir(), "Applications", "Paseo-Vibrancy.app");

/** Single-flight guard: a second `run` while one is pending rejects immediately, never queues. */
export class BuildQueue {
  #busy = false;
  #settled: Promise<void> = Promise.resolve();

  get busy(): boolean {
    return this.#busy;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#busy) {
      throw new Error("build already running");
    }
    this.#busy = true;
    const settled = (async () => {
      try {
        return await fn();
      } finally {
        this.#busy = false;
      }
    })();
    this.#settled = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }

  /** Resolves once the in-flight `run` (if any) has settled, immediately when idle — a test seam for `vibrancy.build`'s fire-and-forget job. */
  async whenIdle(): Promise<void> {
    await this.#settled;
  }
}

export type VibrancyHandlerDeps = {
  settingsFile?: string;
  execPath?: string;
  staging?: string;
  target?: string;
  cacheDir?: string;
  ghosttyPath?: string;
  checkLatest?: typeof checkLatestDefault;
  fetchRelease?: typeof fetchReleaseDefault;
  downloadVerified?: typeof downloadVerifiedDefault;
  cachedPristine?: typeof cachedPristineDefault;
  buildStaging?: typeof buildStagingDefault;
  startSwap?: typeof startSwapDefault;
};

type BuildInput = { version?: string; restart: boolean };
type BuildOutput = { ok: boolean; report: string[]; error: string | null };

/** Pulls the partial report `buildStaging` attaches to a thrown error (notes collected before the failure), else none. */
function reportFromError(error: unknown): string[] {
  if (error instanceof Error && Array.isArray((error as Error & { report?: unknown }).report)) {
    return (error as Error & { report: string[] }).report;
  }
  return [];
}
/** Builds the five RPC handlers against `deps` (all optional, defaulting to the real filesystem/network). */
export function createHandlers(deps: VibrancyHandlerDeps = {}) {
  const settingsFile = deps.settingsFile ?? DEFAULT_SETTINGS_FILE;
  const execPath = deps.execPath ?? process.execPath;
  const staging = deps.staging ?? DEFAULT_STAGING;
  const target = deps.target ?? DEFAULT_TARGET;
  const cacheDir = deps.cacheDir ?? DEFAULT_CACHE_DIR;
  const ghosttyPath = deps.ghosttyPath;
  const doCheckLatest = deps.checkLatest ?? checkLatestDefault;
  const doFetchRelease = deps.fetchRelease ?? fetchReleaseDefault;
  const doDownloadVerified = deps.downloadVerified ?? downloadVerifiedDefault;
  const doCachedPristine = deps.cachedPristine ?? cachedPristineDefault;
  const doBuildStaging = deps.buildStaging ?? buildStagingDefault;
  const doStartSwap = deps.startSwap ?? startSwapDefault;

  const queue = new BuildQueue();
  let latest: Release | null = null;
  let lastReport: string[] = [];
  let lastError: string | null = null;

  async function status() {
    const bundle = runningBundle(execPath);
    const stamp = bundle ? readStamp(bundle) : null;
    let runningVersion: string | null = null;
    if (bundle) {
      try {
        runningVersion = appVersion(bundle);
      } catch {
        runningVersion = null;
      }
    }
    const { term, overriddenByGhostty } = resolveTerm(readSettings(settingsFile).terminal, ghosttyPath);
    return {
      runningVersion,
      runningVibrancyBuild: bundle !== null && isVibrancyBuild(bundle),
      builtFrom: stamp?.version ?? null,
      fingerprintMatches: stamp !== null && stamp.fingerprint === buildFingerprint(term),
      ghosttyOverrides: overriddenByGhostty,
      latest,
      lastReport,
      lastError,
      building: queue.busy,
    };
  }

  async function checkUpdate() {
    const result = await doCheckLatest();
    if (result.release) {
      latest = result.release;
    }
    return result;
  }

  /**
   * Runs the actual build (and, if requested, swap) inside `queue`, then
   * records the outcome in `lastReport`/`lastError` itself (success or
   * failure, including the partial report attached to a thrown error) —
   * never throwing, so `queue.run`'s returned promise (and `whenIdle()`,
   * which tracks it) only ever settles once that state is already correct.
   * `version` defaults to the running bundle's version (the client omits it
   * for "Rebuild", passes the checked `latest.version` for "Update").
   */
  async function runBuildJob(input: BuildInput): Promise<void> {
    try {
      const bundle = runningBundle(execPath);
      const version = input.version ?? (bundle ? appVersion(bundle) : undefined);
      if (!version) {
        throw new Error("no version to build: nothing running and none requested");
      }
      const source = doCachedPristine(version, cacheDir) ?? (await doDownloadVerified(await doFetchRelease(version), cacheDir));
      const { report } = await doBuildStaging({ source, staging, ghosttyPath, settingsFile });
      lastReport = report;
      lastError = null;
      if (input.restart) {
        const runningExe = bundle ? join(bundle, "Contents", "MacOS", execName(bundle)) : undefined;
        doStartSwap({ staging, target, quit: true, open: true, runningExe, previousApp: bundle ?? undefined });
      }
    } catch (error) {
      lastReport = reportFromError(error);
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Returns immediately — `{ok:true}` once the job is queued, `{ok:false,
   * error:"build already running"}` if one is already in flight — so this
   * RPC always completes well inside the daemon's 30 s plugin-RPC timeout
   * even though the job itself can run for minutes. `runBuildJob` never
   * throws, so the queued run can never surface as an unhandled rejection.
   */
  async function build(input: BuildInput): Promise<BuildOutput> {
    if (queue.busy) {
      return { ok: false, report: [], error: "build already running" };
    }
    void queue.run(() => runBuildJob(input));
    return { ok: true, report: [], error: null };
  }

  async function getSettings(): Promise<VibrancySettings> {
    return readSettings(settingsFile);
  }

  async function setSettings(settings: VibrancySettings): Promise<VibrancySettings> {
    writeSettings(settings, settingsFile);
    return settings;
  }

  return { status, checkUpdate, build, getSettings, setSettings, queue };
}

export default function contribute(server: PluginServerContext): PluginCleanup {
  const handlers = createHandlers();
  server.handle(statusRpc, async () => handlers.status());
  server.handle(checkUpdateRpc, async () => handlers.checkUpdate());
  server.handle(buildRpc, async (input) => handlers.build(input));
  server.handle(getSettingsRpc, async () => handlers.getSettings());
  server.handle(setSettingsRpc, async (input) => handlers.setSettings(input));
  return () => {};
}
