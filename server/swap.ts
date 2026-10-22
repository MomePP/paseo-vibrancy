/**
 * Detached swap-and-relaunch: moves a freshly built staging copy over the
 * live patched app and optionally relaunches it, surviving the moment Paseo
 * (and this plugin's own server subprocess, a child of Paseo's daemon) quits.
 *
 * `startSwap` spawns the generated POSIX sh script as its own process group
 * (`detached: true`, then `unref()`) so it keeps running after the daemon
 * that spawned it is gone, and the script itself ignores SIGHUP so the
 * group's controlling-terminal hangup on quit cannot cut it short either.
 * Every step is appended to `logPath` (`exec >>LOG 2>&1` at the top of the
 * script) since nothing else observes a detached, unref'd child's output —
 * a silent failure here otherwise just looks like Paseo never reopened.
 *
 * Ports the quit/wait half of the former paseo-repatch script's
 * `quit_patched` and `running_pids`: `osascript` asks the running patched
 * copy to quit by bundle id, then the script polls `pgrep -f` on the bare
 * executable path(s) (anchored, so it never matches a helper the app
 * spawned that is meant to outlive a quit) up to 60 s before giving up.
 * Bootstrapping from stock `/Applications/Paseo.app`, the *running* exe
 * differs from the *target* (`Paseo-Vibrancy.app`) exe the swap is about to
 * replace, so both are tracked: the wait only ends once neither matches.
 *
 * Windows: the same flow as a PowerShell script (`windowsSwapScript`),
 * started so it outlives Paseo (see `startSwap`). It closes the main window of every process started
 * from the target or running `Paseo.exe` (Paseo quits, daemon included, when
 * it is closed), stops a daemon that outlives that with the old copy's
 * `paseo.cmd`, and waits until no process runs from either exe — Windows
 * will not move a folder while an exe inside it runs. The old copy goes to
 * the Recycle Bin, and a Start menu shortcut points at the new one.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { HOST_PLATFORM } from "../shared/platform.ts";
import type { HostPlatform } from "../shared/platform.ts";
import { STAMP_NAME } from "./build.ts";
import { WINDOWS_EXE, localAppData, resourcesDir } from "./layout.ts";

export type SwapOpts = {
  staging: string;
  target: string;
  /** The currently-running bundle's executable (may differ from `target`'s when bootstrapping from stock Paseo.app). */
  runningExe?: string;
  /** The app to reopen if the swap fails after quitting; defaults to `target`. Stock Paseo.app when bootstrapping. */
  previousApp?: string;
  trashDir: string;
  quit: boolean;
  open: boolean;
  logPath?: string;
  /** Windows: the shortcut to (re)write; defaults to `WINDOWS_SHORTCUT_NAME` in the Start menu's Programs folder. */
  shortcutPath?: string;
};

export const DEFAULT_SWAP_LOG =
  HOST_PLATFORM === "win32"
    ? join(localAppData(), "paseo-vibrancy", "swap.log")
    : join(homedir(), "Library", "Logs", "paseo-vibrancy-swap.log");

/** The Start menu shortcut the Windows swap (re)writes for the patched copy. */
const WINDOWS_SHORTCUT_NAME = "Paseo Vibrancy.lnk";

/** How many 0.5s polls `swapScript` waits for the running app to quit — 60s total. */
const QUIT_WAIT_ATTEMPTS = 120;
const QUIT_WAIT_INTERVAL_SECONDS = "0.5";

/** Shell expression for a timestamp, embedded in every logged step line. */
const SH_TIMESTAMP = "$(date '+%Y-%m-%dT%H:%M:%S%z')";

/**
 * Quotes `s` as a single POSIX sh word by wrapping it in single quotes and
 * escaping any embedded single quote as `'\''` (close quote, literal quote,
 * reopen quote). Safe for any byte sequence, including spaces and `$`/`` ` ``.
 */
function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Escapes POSIX extended-regular-expression metacharacters in `s` so it can
 * be embedded in a `pgrep -f` pattern and still match only itself. Without
 * this, a target path containing e.g. `(`, `)`, `+` or `.` would make the
 * pattern match something other than the literal executable path — or fail
 * to match it at all — and the script could swap out from under a still-live
 * Paseo process, or spin for the full 60 s grace period on a process that
 * already quit.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the POSIX sh script `startSwap` runs detached. With `quit`, it asks
 * the running patched copy to quit and waits up to 60 s for both its own
 * process and (if `runningExe` differs — bootstrapping from stock Paseo.app)
 * the currently-running process to clear before touching anything; if
 * either is still up after the grace period, the script reopens the
 * previous app (when `open`) and exits 1, leaving `staging`/`target`
 * untouched. Otherwise (or once the old process has cleared) it trashes any
 * existing `target`, moves `staging` into place, and — if `open` —
 * relaunches it. Any failure after the quit request (timed-out wait, a
 * failed trash-move, a failed staging-move already rolled back) reopens
 * `previousApp` — the app that was running, which is `target` itself except
 * when bootstrapping from stock Paseo.app — when `open` is true.
 */
export function swapScript(opts: SwapOpts): string {
  const logPath = opts.logPath ?? DEFAULT_SWAP_LOG;
  const exe = join(opts.target, "Contents", "MacOS", "Paseo");
  const exePattern = `^${escapeRegex(exe)}$`;
  const runningPattern = opts.runningExe !== undefined ? `^${escapeRegex(opts.runningExe)}$` : null;
  const dualPattern = runningPattern !== null && runningPattern !== exePattern;
  const trashed = join(opts.trashDir, `Paseo-Vibrancy-${Math.floor(Date.now() / 1000)}.app`);

  const log = (message: string) => `echo "[${SH_TIMESTAMP}] swap: ${message}"`;
  const reopenOnFailure = opts.open
    ? [log("reopening previous app"), `open -a ${shq(opts.previousApp ?? opts.target)}`]
    : [];

  const lines = ["trap '' HUP", `exec >>${shq(logPath)} 2>&1`, log("starting")];

  if (opts.quit) {
    lines.push(`PATTERN=${shq(exePattern)}`);
    if (dualPattern) {
      lines.push(`RUNNING_PATTERN=${shq(runningPattern!)}`);
    }
    // `-a`: the script descends from the running Paseo (app -> supervisor ->
    // daemon -> plugin -> script), and macOS pgrep skips its own ancestors
    // without it — the wait would end at once while Paseo is still quitting.
    const stillRunning = dualPattern
      ? `pgrep -a -f "$PATTERN" >/dev/null 2>&1 || pgrep -a -f "$RUNNING_PATTERN" >/dev/null 2>&1`
      : `pgrep -a -f "$PATTERN" >/dev/null 2>&1`;
    lines.push(
      log("requesting quit"),
      `osascript -e 'tell application id "sh.paseo.desktop" to quit' >/dev/null 2>&1 || true`,
      `i=0`,
      `while [ "$i" -lt ${QUIT_WAIT_ATTEMPTS} ]; do`,
      `  ${stillRunning} || break`,
      `  i=$((i + 1))`,
      `  sleep ${QUIT_WAIT_INTERVAL_SECONDS}`,
      `done`,
      `if ${stillRunning}; then`,
      `  ${log("quit wait timed out")}`,
      ...reopenOnFailure.map((line) => `  ${line}`),
      `  exit 1`,
      `fi`,
    );
    // Quitting the app does not reliably stop Paseo's supervisor and daemon:
    // they can stay up ("Running in Background"), and the relaunched copy then
    // attaches to a daemon still running from the old bundle — which is about
    // to be moved to the Trash. Stop it with the old bundle's own CLI while
    // that bundle is still in place; the new copy starts its own on launch.
    // A failure is logged, not fatal: the swap is still worth finishing.
    const oldCli = join(opts.previousApp ?? opts.target, "Contents", "Resources", "bin", "paseo");
    lines.push(
      `if [ -x ${shq(oldCli)} ]; then`,
      `  ${log("stopping the previous daemon")}`,
      `  ${shq(oldCli)} daemon stop --timeout 15 --force || ${log("daemon stop failed, continuing")}`,
      `fi`,
    );
  }

  // Each `mv` is checked: a failed trash-move stops before `staging` is ever
  // touched, and a failed staging-move (e.g. a dangling `staging` or a
  // read-only `target` parent) restores the trashed copy rather than leaving
  // the bundle half-swapped or the user with no app at all. `target` is never
  // left holding both the old and new bundle nested inside each other. Either
  // failure reopens the previous app (see `previousApp`).
  lines.push(`TRASHED=${shq(trashed)}`);
  lines.push(
    `if [ -e ${shq(opts.target)} ]; then`,
    `  ${log("moving previous app to trash")}`,
    `  if ! mv ${shq(opts.target)} "$TRASHED"; then`,
    `    ${log("trash move failed")}`,
    ...reopenOnFailure.map((line) => `    ${line}`),
    `    exit 1`,
    `  fi`,
    `fi`,
    log("moving staging into place"),
    `if ! mv ${shq(opts.staging)} ${shq(opts.target)}; then`,
    `  ${log("staging move failed, restoring previous app")}`,
    `  if [ -e "$TRASHED" ]; then`,
    `    mv "$TRASHED" ${shq(opts.target)}`,
    `  fi`,
    ...reopenOnFailure.map((line) => `  ${line}`),
    `  exit 1`,
    `fi`,
  );

  lines.push(log("complete"));
  if (opts.open) {
    lines.push(log("opening updated app"), `open -a ${shq(opts.target)}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * The environment for the swap script: everything but Electron's own
 * `ELECTRON_*` variables. This runs inside Paseo's daemon, which is Electron
 * with ELECTRON_RUN_AS_NODE=1, and `open` hands its environment to the app it
 * launches — a Paseo started with that variable runs as plain Node, finds no
 * script, and exits 0 before writing a log line or opening a window.
 */
export function launchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("ELECTRON_")));
}

/**
 * Quotes `s` as a PowerShell single-quoted string: no expansion inside, and
 * every quote character doubled — PowerShell also ends a single-quoted
 * string at the typographic quotes U+2018 to U+201B (`D’Angelo`).
 */
function psq(s: string): string {
  return `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

/**
 * Builds the PowerShell script `startSwap` runs detached on Windows; same
 * contract as `swapScript`. With `quit`: close the main window of every
 * process run from the target's or the running `Paseo.exe`, wait up to 20 s
 * for them all to exit, stop a daemon still running (e.g. kept running after
 * quit) with the old copy's `paseo.cmd`, wait up to 40 s more, and give up —
 * reopening the previous app when `open` — if anything is still running.
 * Then the old copy is renamed aside, staging is moved into place (the old
 * copy is restored if that fails) and the new copy is launched if `open`.
 * Only after that come the two shell calls: writing the Start menu shortcut
 * (when it is missing) and sending the old copy to the Recycle Bin. Both go
 * through Explorer, and `IWshShortcut.Save()` was seen to write the file and
 * then never return, so each runs in a background job cut off after 15 s.
 */
export function windowsSwapScript(opts: Omit<SwapOpts, "trashDir">): string {
  const logPath = opts.logPath ?? DEFAULT_SWAP_LOG;
  const targetExe = join(opts.target, WINDOWS_EXE);
  const previousApp = opts.previousApp ?? opts.target;
  const aside = `${opts.target}.previous-${Math.floor(Date.now() / 1000)}`;
  const shortcut =
    opts.shortcutPath !== undefined
      ? psq(opts.shortcutPath)
      : `(Join-Path ([Environment]::GetFolderPath('Programs')) ${psq(WINDOWS_SHORTCUT_NAME)})`;

  const lines = [
    `$log = ${psq(logPath)}`,
    `New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null`,
    `function Log($m) { Add-Content -LiteralPath $log -Value ("[{0}] swap: {1}" -f (Get-Date -Format o), $m) }`,
    opts.open
      ? `function Reopen { Log 'reopening previous app'; Start-Process -FilePath ${psq(join(previousApp, WINDOWS_EXE))} }`
      : `function Reopen { }`,
    `function Bounded($what, $block, $arguments) {`,
    `  $job = Start-Job -ScriptBlock $block -ArgumentList $arguments`,
    `  if (-not (Wait-Job $job -Timeout 15)) { Log "$what timed out" }`,
    `  elseif ($job.State -eq 'Failed') { Log "$what failed: $($job.ChildJobs[0].JobStateInfo.Reason)" }`,
    `  Remove-Job $job -Force`,
    `}`,
    `Log 'starting'`,
  ];

  if (opts.quit) {
    const exes = [...new Set([targetExe, opts.runningExe ?? targetExe])].map(psq).join(", ");
    const oldCli = join(previousApp, "resources", "bin", "paseo.cmd");
    lines.push(
      `$exes = @(${exes})`,
      `function Running { @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($exes -contains $_.Path) }) }`,
      `function WaitGone($polls) { for ($i = 0; $i -lt $polls -and (Running).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 } }`,
      `Log 'requesting quit'`,
      `Running | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }`,
      `WaitGone 40`,
      `if ((Running).Count -gt 0 -and (Test-Path -LiteralPath ${psq(oldCli)})) {`,
      `  Log 'stopping the previous daemon'`,
      `  & ${psq(oldCli)} daemon stop --timeout 15 --force`,
      `  if ($LASTEXITCODE -ne 0) { Log 'daemon stop failed, continuing' }`,
      `  WaitGone 80`,
      `}`,
      `if ((Running).Count -gt 0) { Log 'quit wait timed out'; Reopen; exit 1 }`,
    );
  }

  lines.push(
    `$aside = ${psq(aside)}`,
    `if (Test-Path -LiteralPath ${psq(opts.target)}) {`,
    `  Log 'moving previous app aside'`,
    `  try { Move-Item -LiteralPath ${psq(opts.target)} -Destination $aside -ErrorAction Stop }`,
    `  catch { Log "move aside failed: $_"; Reopen; exit 1 }`,
    `}`,
    `Log 'moving staging into place'`,
    `try { Move-Item -LiteralPath ${psq(opts.staging)} -Destination ${psq(opts.target)} -ErrorAction Stop }`,
    `catch {`,
    `  Log "staging move failed, restoring previous app: $_"`,
    `  if (Test-Path -LiteralPath $aside) {`,
    `    try { Move-Item -LiteralPath $aside -Destination ${psq(opts.target)} -ErrorAction Stop }`,
    `    catch { Log "restore failed, previous app left at $($aside): $_" }`,
    `  }`,
    `  Reopen; exit 1`,
    `}`,
  );
  if (opts.open) {
    lines.push(`Log 'opening updated app'`, `Start-Process -FilePath ${psq(targetExe)}`);
  }
  lines.push(
    `$lnk = ${shortcut}`,
    `if (-not (Test-Path -LiteralPath $lnk)) {`,
    `  Log 'writing the Start menu shortcut'`,
    `  Bounded 'shortcut' { param($l, $e, $d) $s = (New-Object -ComObject WScript.Shell).CreateShortcut($l); $s.TargetPath = $e; $s.WorkingDirectory = $d; $s.Save() } @($lnk, ${psq(targetExe)}, ${psq(opts.target)})`,
    `}`,
    `if (Test-Path -LiteralPath $aside) {`,
    `  Log 'moving previous app to the Recycle Bin'`,
    `  Bounded 'recycling the previous app' { param($a) Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($a, 'OnlyErrorDialogs', 'SendToRecycleBin') } @($aside)`,
    `  if (Test-Path -LiteralPath $aside) { Log "previous app left at $($aside)" }`,
    `}`,
    `Log 'complete'`,
  );

  return lines.join("\n") + "\n";
}

/**
 * Validates `staging` carries a build stamp (a stamp ending in `missed` is
 * still swappable — MISSED patches are cosmetic, not a reason to block a
 * rebuild) and starts the swap script so it outlives this process and
 * Paseo's daemon, with no inherited stdio. macOS: `/bin/sh`, detached into
 * its own process group. Windows: see below; the script runs from the temp
 * directory, so its working directory never pins a folder it has to move.
 */
export function startSwap(
  opts: Omit<SwapOpts, "trashDir"> & { trashDir?: string },
  platform: HostPlatform = HOST_PLATFORM,
): void {
  const stampPath = join(resourcesDir(opts.staging, platform), STAMP_NAME);
  if (!existsSync(stampPath)) {
    throw new Error("staging has no build stamp");
  }

  if (platform === "win32") {
    // Neither the obvious detached PowerShell (`detached` means no console,
    // and PowerShell then exits 0 without running anything) nor a detached
    // Node runner (that is Paseo.exe itself, running from the very folder
    // the swap waits on and moves) works. A short-lived hidden PowerShell
    // starts the real one with Start-Process instead: libuv lets processes
    // its children create break away from its kill-on-close job, so the
    // script survives Paseo quitting, and it gets a hidden console of its own.
    const encoded = Buffer.from(windowsSwapScript(opts), "utf16le").toString("base64");
    const launch = `Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`;
    spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", launch], {
      stdio: "ignore",
      windowsHide: true,
      cwd: tmpdir(),
      env: launchEnv(process.env),
    }).unref();
    return;
  }

  const trashDir = opts.trashDir ?? join(homedir(), ".Trash");
  const script = swapScript({ ...opts, trashDir });

  spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore", env: launchEnv(process.env) }).unref();
}
