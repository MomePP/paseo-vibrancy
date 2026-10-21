import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchEnv, startSwap, swapScript, windowsSwapScript } from "../server/swap.ts";
import { STAMP_NAME } from "../server/build.ts";

const macOnly = { skip: process.platform !== "darwin" ? "macOS swap script (sh, osascript, pgrep)" : false };
const windowsOnly = { skip: process.platform !== "win32" ? "Windows swap script (PowerShell)" : false };

/**
 * Polls `predicate` up to `timeoutMs`. Exception to fake-timer-only polling:
 * `startSwap` detaches a real `/bin/sh` child that mutates the filesystem
 * out-of-process (`mv`), so there is no in-process event or promise to await
 * — only the platform clock and the resulting files on disk.
 */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  assert.ok(predicate(), `condition not met within ${timeoutMs}ms`);
}

function makeStaging(dir: string, marker: string): string {
  const staging = join(dir, "staging.app");
  mkdirSync(join(staging, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(staging, "Contents", "Resources", STAMP_NAME), "0.11.0-beta.3|vibrancy=abc123");
  writeFileSync(join(staging, "Contents", "Resources", "marker.txt"), marker);
  return staging;
}

test("swaps staging into target and trashes old", macOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-swap-"));
  try {
    const staging = makeStaging(dir, "new-build");
    const target = join(dir, "target.app");
    mkdirSync(join(target, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(target, "Contents", "Resources", "marker.txt"), "old-build");
    const trashDir = mkdtempSync(join(tmpdir(), "vibrancy-trash-"));

    try {
      startSwap({ staging, target, quit: false, open: false, trashDir, logPath: join(dir, "swap.log") });

      await waitFor(() => !existsSync(staging));
      assert.equal(readFileSync(join(target, "Contents", "Resources", "marker.txt"), "utf8"), "new-build");
      assert.equal(existsSync(staging), false);

      const trashed = readdirSync(trashDir).filter((name) => name.startsWith("Paseo-Vibrancy-"));
      assert.equal(trashed.length, 1);
      assert.ok(trashed[0]!.endsWith(".app"));
      assert.equal(
        readFileSync(join(trashDir, trashed[0]!, "Contents", "Resources", "marker.txt"), "utf8"),
        "old-build",
      );
    } finally {
      rmSync(trashDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses staging without stamp", macOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-swap-"));
  try {
    const staging = join(dir, "staging.app");
    mkdirSync(join(staging, "Contents", "Resources"), { recursive: true });
    // No .vibrancy-build stamp written.
    const target = join(dir, "target.app");
    mkdirSync(join(target, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(target, "Contents", "Resources", "marker.txt"), "old-build");
    const trashDir = mkdtempSync(join(tmpdir(), "vibrancy-trash-"));

    try {
      assert.throws(
        () => startSwap({ staging, target, quit: false, open: false, trashDir }),
        /staging has no build stamp/,
      );
      assert.equal(existsSync(staging), true);
      assert.equal(
        readFileSync(join(target, "Contents", "Resources", "marker.txt"), "utf8"),
        "old-build",
      );
      assert.deepEqual(readdirSync(trashDir), []);
    } finally {
      rmSync(trashDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("works when target does not exist yet", macOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-swap-"));
  try {
    const staging = makeStaging(dir, "first-install");
    const target = join(dir, "target.app");
    const trashDir = mkdtempSync(join(tmpdir(), "vibrancy-trash-"));

    try {
      startSwap({ staging, target, quit: false, open: false, trashDir, logPath: join(dir, "swap.log") });

      await waitFor(() => existsSync(join(target, "Contents", "Resources", "marker.txt")));
      assert.equal(readFileSync(join(target, "Contents", "Resources", "marker.txt"), "utf8"), "first-install");
      assert.equal(existsSync(staging), false);
      assert.deepEqual(readdirSync(trashDir), []);
    } finally {
      rmSync(trashDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a MISSED stamp is still swappable", macOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-swap-"));
  try {
    const staging = join(dir, "staging.app");
    mkdirSync(join(staging, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(staging, "Contents", "Resources", STAMP_NAME), "0.11.0-beta.3|vibrancy=missed");
    writeFileSync(join(staging, "Contents", "Resources", "marker.txt"), "missed-build");
    const target = join(dir, "target.app");
    const trashDir = mkdtempSync(join(tmpdir(), "vibrancy-trash-"));

    try {
      startSwap({ staging, target, quit: false, open: false, trashDir, logPath: join(dir, "swap.log") });

      await waitFor(() => existsSync(join(target, "Contents", "Resources", "marker.txt")));
      assert.equal(readFileSync(join(target, "Contents", "Resources", "marker.txt"), "utf8"), "missed-build");
    } finally {
      rmSync(trashDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quotes paths containing spaces and single quotes safely", macOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-swap-"));
  try {
    const trickyRoot = join(dir, "Paseo Helper's App Support");
    mkdirSync(trickyRoot, { recursive: true });

    const staging = makeStaging(trickyRoot, "tricky-build");
    const target = join(trickyRoot, "Paseo-Vibrancy's Copy.app");
    const trashDir = join(trickyRoot, "O'Brien's Trash");
    mkdirSync(trashDir, { recursive: true });

    startSwap({ staging, target, quit: false, open: false, trashDir, logPath: join(trickyRoot, "swap.log") });

    await waitFor(() => existsSync(join(target, "Contents", "Resources", "marker.txt")));
    assert.equal(readFileSync(join(target, "Contents", "Resources", "marker.txt"), "utf8"), "tricky-build");
    assert.equal(existsSync(staging), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("swapScript quits the running copy and waits for it to clear, but omits that when quit is false", macOnly, () => {
  const opts = { staging: "/tmp/staging.app", target: "/tmp/target.app", trashDir: "/tmp/trash", open: false };

  const withQuit = swapScript({ ...opts, quit: true });
  assert.match(withQuit, /tell application id "sh\.paseo\.desktop" to quit/);
  assert.match(withQuit, /pgrep -a -f "\$PATTERN"/);
  assert.match(withQuit, /PATTERN='\^\/tmp\/target\\\.app\/Contents\/MacOS\/Paseo\$'/);
  assert.match(withQuit, /^if pgrep -a -f "\$PATTERN".*\n {2}echo .*\n {2}exit 1\nfi$/m);

  const withoutQuit = swapScript({ ...opts, quit: false });
  assert.doesNotMatch(withoutQuit, /osascript/);
  assert.doesNotMatch(withoutQuit, /pgrep/);
});

test("quit wait tracks both the target's and the currently-running bundle's executables", macOnly, () => {
  const withBoth = swapScript({
    staging: "/tmp/staging.app",
    target: "/tmp/Paseo-Vibrancy.app",
    runningExe: "/Applications/Paseo.app/Contents/MacOS/Paseo",
    trashDir: "/tmp/trash",
    quit: true,
    open: false,
  });
  assert.match(withBoth, /PATTERN='\^\/tmp\/Paseo-Vibrancy\\\.app\/Contents\/MacOS\/Paseo\$'/);
  assert.match(withBoth, /RUNNING_PATTERN='\^\/Applications\/Paseo\\\.app\/Contents\/MacOS\/Paseo\$'/);
  assert.match(withBoth, /pgrep -a -f "\$PATTERN" >\/dev\/null 2>&1 \|\| pgrep -a -f "\$RUNNING_PATTERN" >\/dev\/null 2>&1 \|\| break/);
  assert.equal(spawnSync("/bin/sh", ["-n", "-c", withBoth]).status, 0, "generated script must be valid POSIX sh");

  // runningExe identical to the target's own exe: no second pattern needed.
  const sameExe = swapScript({
    staging: "/tmp/staging.app",
    target: "/tmp/target.app",
    runningExe: "/tmp/target.app/Contents/MacOS/Paseo",
    trashDir: "/tmp/trash",
    quit: true,
    open: false,
  });
  assert.doesNotMatch(sameExe, /RUNNING_PATTERN/);
});

test("every failure branch after the quit request reopens the previous app when open is true", macOnly, () => {
  const script = swapScript({
    staging: "/tmp/staging.app",
    target: "/tmp/target.app",
    trashDir: "/tmp/trash",
    quit: true,
    open: true,
  });
  const reopenCount = [...script.matchAll(/open -a '\/tmp\/target\.app'/g)].length;
  // quit-timeout, trash-move-failed, staging-move-failed, and the final success open: four call sites.
  assert.equal(reopenCount, 4);
  assert.equal(spawnSync("/bin/sh", ["-n", "-c", script]).status, 0, "generated script must be valid POSIX sh");
});

test("failure branches reopen the app that was running, not the new target, when bootstrapping", macOnly, () => {
  const script = swapScript({
    staging: "/tmp/staging.app",
    target: "/tmp/target.app",
    previousApp: "/Applications/Paseo.app",
    trashDir: "/tmp/trash",
    quit: true,
    open: true,
  });
  // quit-timeout, trash-move-failed, staging-move-failed reopen stock Paseo;
  // only the success path opens the freshly swapped-in target.
  assert.equal([...script.matchAll(/open -a '\/Applications\/Paseo\.app'/g)].length, 3);
  assert.equal([...script.matchAll(/open -a '\/tmp\/target\.app'/g)].length, 1);
});

test("logs timestamped steps and the failure reason to logPath", macOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-swap-"));
  try {
    const target = join(dir, "target.app");
    mkdirSync(join(target, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(target, "Contents", "Resources", "marker.txt"), "old-build");
    const staging = join(dir, "no-such-staging.app"); // deliberately never created, forces a failure
    const trashDir = mkdtempSync(join(tmpdir(), "vibrancy-trash-"));
    const logPath = join(dir, "swap.log");

    try {
      const script = swapScript({ staging, target, trashDir, quit: false, open: false, logPath });
      const result = spawnSync("/bin/sh", ["-c", script]);

      assert.notEqual(result.status, 0);
      const log = readFileSync(logPath, "utf8");
      assert.match(log, /^\[\S+\] swap: starting$/m);
      assert.match(log, /^\[\S+\] swap: staging move failed, restoring previous app$/m);
    } finally {
      rmSync(trashDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed trash-move aborts before staging is touched (e.g. a missing trashDir)", macOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-swap-"));
  try {
    const staging = makeStaging(dir, "new-build");
    const target = join(dir, "target.app");
    mkdirSync(join(target, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(target, "Contents", "Resources", "marker.txt"), "old-build");
    const trashDir = join(dir, "no-such-trash-dir"); // deliberately never created

    const script = swapScript({ staging, target, trashDir, quit: false, open: false, logPath: join(dir, "swap.log") });
    const result = spawnSync("/bin/sh", ["-c", script]);

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(staging), true);
    assert.equal(
      readFileSync(join(target, "Contents", "Resources", "marker.txt"), "utf8"),
      "old-build",
    );
    // The failed mv must never have nested staging inside the still-live target.
    assert.equal(existsSync(join(target, "staging.app")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed staging-move restores the trashed target", macOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-swap-"));
  try {
    const target = join(dir, "target.app");
    mkdirSync(join(target, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(target, "Contents", "Resources", "marker.txt"), "old-build");
    const trashDir = mkdtempSync(join(tmpdir(), "vibrancy-trash-"));
    const staging = join(dir, "no-such-staging.app"); // deliberately never created

    try {
      const script = swapScript({ staging, target, trashDir, quit: false, open: false, logPath: join(dir, "swap.log") });
      const result = spawnSync("/bin/sh", ["-c", script]);

      assert.notEqual(result.status, 0);
      assert.equal(
        readFileSync(join(target, "Contents", "Resources", "marker.txt"), "utf8"),
        "old-build",
      );
      assert.deepEqual(readdirSync(trashDir), []);
    } finally {
      rmSync(trashDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("escapes regex metacharacters in the exe path so pgrep -f matches only the literal path", macOnly, () => {
  const target = "/tmp/Paseo (x)+.app";
  const exe = join(target, "Contents", "MacOS", "Paseo");
  const script = swapScript({ staging: "/tmp/staging.app", target, trashDir: "/tmp/trash", quit: true, open: false });

  const patternLine = script.match(/^PATTERN='(.*)'$/m);
  assert.ok(patternLine, "expected a single-quoted PATTERN= assignment line");
  const pattern = patternLine![1]!.replaceAll(`'\\''`, "'");

  // Mirrors pgrep's own matcher (extended regular expressions).
  const literalMatch = spawnSync("/bin/sh", ["-c", `echo '${exe}' | grep -E '${pattern}'`]);
  assert.equal(literalMatch.status, 0);
});

test("launchEnv drops Electron's variables so `open -a` launches a GUI app, not Node", () => {
  // The swap runs from Paseo's daemon, which is Electron with
  // ELECTRON_RUN_AS_NODE=1; `open` passes its environment to the app it
  // launches, and a Paseo started with that variable runs as plain Node and
  // exits 0 at once.
  const env = launchEnv({
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    HOME: "/Users/someone",
    PATH: "/usr/bin:/bin",
  });
  assert.deepEqual(env, { HOME: "/Users/someone", PATH: "/usr/bin:/bin" });
});

test("the quit wait sees the running app even when the script descends from it", macOnly, (t) => {
  // The swap script runs under Paseo's own process tree (app -> supervisor ->
  // daemon -> plugin -> script), and macOS pgrep leaves out its ancestors
  // unless told otherwise — so the wait used to end at once while Paseo was
  // still quitting. Run the script's own "still running?" check as a child of
  // a binary sitting at the target's executable path.
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-swap-ancestor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "Fake.app");
  const exe = join(target, "Contents", "MacOS", "Paseo");
  mkdirSync(join(target, "Contents", "MacOS"), { recursive: true });
  const compiled = spawnSync(
    "xcrun",
    ["clang", "-x", "c", "-o", exe, "-"],
    { input: '#include <stdlib.h>\nint main(void){return system(getenv("CHECK"))==0?0:1;}\n' },
  );
  assert.equal(compiled.status, 0, String(compiled.stderr));

  const script = swapScript({ staging: join(dir, "s.app"), target, trashDir: dir, quit: true, open: false });
  const pattern = script.match(/^PATTERN=.*$/m)![0];
  const check = script.match(/^if (.*); then$/m)![1];

  const run = spawnSync(exe, [], { env: { ...process.env, CHECK: `${pattern}; ${check}` } });
  assert.equal(run.status, 0, "the check must find the ancestor process running at the target path");
});

test("after the app quits, the swap stops the old bundle's daemon before moving anything", macOnly, () => {
  // Quitting Paseo can leave its supervisor and daemon running ("Running in
  // Background"), and the relaunched copy then attaches to a daemon still
  // running from the old bundle — which this swap moves to the Trash.
  const script = swapScript({
    staging: "/tmp/staging.app",
    target: "/tmp/Paseo-Vibrancy.app",
    previousApp: "/Applications/Paseo.app",
    trashDir: "/tmp/trash",
    quit: true,
    open: true,
  });
  const stop = script.indexOf("'/Applications/Paseo.app/Contents/Resources/bin/paseo' daemon stop");
  assert.ok(stop > script.indexOf("quit wait timed out"), "daemon stop must come after the quit wait");
  assert.ok(stop < script.indexOf("moving previous app to trash"), "daemon stop must come before the bundle is moved");
  assert.equal(spawnSync("/bin/sh", ["-n", "-c", script]).status, 0, "generated script must be valid POSIX sh");

  assert.doesNotMatch(swapScript({ staging: "/tmp/s.app", target: "/tmp/t.app", trashDir: "/tmp/x", quit: false, open: false }), /daemon stop/);
});

/** A Windows staging copy: stamp and marker under `resources/`. */
function makeWindowsStaging(dir: string, marker: string): string {
  const staging = join(dir, ".Paseo-Vibrancy.staging");
  mkdirSync(join(staging, "resources"), { recursive: true });
  writeFileSync(join(staging, "resources", STAMP_NAME), "0.12.0|vibrancy=abc123");
  writeFileSync(join(staging, "resources", "marker.txt"), marker);
  return staging;
}

/** Runs a generated Windows swap script the way `startSwap` does, but waits for it. */
function runPowerShell(script: string): SpawnSyncReturns<Buffer> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]);
}

test("Windows: refuses staging without a stamp under resources/", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-swap-"));
  try {
    const staging = join(dir, "staging");
    mkdirSync(join(staging, "resources"), { recursive: true });
    assert.throws(
      () => startSwap({ staging, target: join(dir, "target"), quit: false, open: false }, "win32"),
      /staging has no build stamp/,
    );
    assert.equal(existsSync(join(dir, "target")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows: startSwap moves staging into a first-time target, writes the shortcut, and logs each step", windowsOnly, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-swap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const staging = makeWindowsStaging(dir, "first-install");
  const target = join(dir, "Paseo-Vibrancy");
  const shortcutPath = join(dir, "Paseo Vibrancy.lnk");
  const logPath = join(dir, "logs", "swap.log");

  startSwap({ staging, target, quit: false, open: false, logPath, shortcutPath });

  await waitFor(() => existsSync(logPath) && /swap: complete/.test(readFileSync(logPath, "utf8")), 15000);
  assert.equal(readFileSync(join(target, "resources", "marker.txt"), "utf8"), "first-install");
  assert.equal(existsSync(staging), false);
  assert.equal(existsSync(shortcutPath), true);
  assert.match(readFileSync(logPath, "utf8"), /^\[\S+\] swap: starting\r?$/m);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".previous-")), []);
});

test("Windows: a failed staging move puts the previous app back in place and logs why", windowsOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-swap-"));
  try {
    const target = join(dir, "Paseo-Vibrancy");
    mkdirSync(join(target, "resources"), { recursive: true });
    writeFileSync(join(target, "resources", "marker.txt"), "old-build");
    const logPath = join(dir, "swap.log");

    const script = windowsSwapScript({
      staging: join(dir, "no-such-staging"),
      target,
      quit: false,
      open: false,
      logPath,
      shortcutPath: join(dir, "x.lnk"),
    });
    const result = runPowerShell(script);

    assert.equal(result.status, 1);
    assert.equal(readFileSync(join(target, "resources", "marker.txt"), "utf8"), "old-build");
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".previous-")), []);
    assert.match(readFileSync(logPath, "utf8"), /swap: staging move failed, restoring previous app/);
    assert.equal(existsSync(join(dir, "x.lnk")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows: quotes paths containing spaces and apostrophes, typographic ones included, safely", windowsOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-swap-"));
  try {
    const trickyRoot = join(dir, "O'Brien’s Programs");
    mkdirSync(trickyRoot);
    const staging = makeWindowsStaging(trickyRoot, "tricky-build");
    const target = join(trickyRoot, "Paseo-Vibrancy's Copy");

    const script = windowsSwapScript({
      staging,
      target,
      quit: false,
      open: false,
      logPath: join(trickyRoot, "swap $(log).log"),
      shortcutPath: join(trickyRoot, "Paseo's.lnk"),
    });
    const result = runPowerShell(script);

    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(readFileSync(join(target, "resources", "marker.txt"), "utf8"), "tricky-build");
    assert.equal(existsSync(join(trickyRoot, "swap $(log).log")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows: with quit, the script closes both exes, stops the old daemon before moving, and every failure reopens the previous app", windowsOnly, () => {
  const script = windowsSwapScript({
    staging: "C:\\x\\.Paseo-Vibrancy.staging",
    target: "C:\\x\\Paseo-Vibrancy",
    runningExe: "C:\\Program Files\\Paseo\\Paseo.exe",
    previousApp: "C:\\Program Files\\Paseo",
    quit: true,
    open: true,
  });

  const errors = runPowerShell(
    `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString("base64")}')), [ref]$null, [ref]$errors); exit $errors.Count`,
  );
  assert.equal(errors.status, 0, "generated script must parse as PowerShell");

  const exesLine = script.match(/^\$exes = .*$/m)?.[0] ?? "";
  assert.ok(exesLine.includes("'C:\\x\\Paseo-Vibrancy\\Paseo.exe'"), exesLine);
  assert.ok(exesLine.includes("'C:\\Program Files\\Paseo\\Paseo.exe'"), exesLine);
  const reopen = script.match(/^function Reopen \{(.*)\}$/m)?.[1] ?? "";
  assert.ok(reopen.includes("Start-Process -FilePath 'C:\\Program Files\\Paseo\\Paseo.exe'"), reopen);
  const exits = [...script.matchAll(/\bexit 1\b/g)];
  assert.ok(exits.length > 0);
  for (const exit of exits) {
    assert.ok(script.slice(0, exit.index).trimEnd().endsWith("Reopen;"), "every failure exit reopens the previous app first");
  }
  const stop = script.indexOf("& 'C:\\Program Files\\Paseo\\resources\\bin\\paseo.cmd' daemon stop");
  assert.ok(stop > script.indexOf("CloseMainWindow"), "the daemon is stopped only after the app was asked to quit");
  assert.ok(stop < script.indexOf("moving previous app aside"), "the daemon is stopped before anything moves");
  assert.match(script, /^Start-Process -FilePath 'C:\\x\\Paseo-Vibrancy\\Paseo\.exe'$/m);

  const quiet = windowsSwapScript({ staging: "C:\\s", target: "C:\\t", quit: false, open: false });
  assert.doesNotMatch(quiet, /CloseMainWindow|daemon stop|Start-Process/);
});
