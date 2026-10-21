// The plugin server runs inside Paseo's daemon, i.e. under Electron's Node
// (`Paseo Helper` on macOS, `Paseo.exe` on Windows, ELECTRON_RUN_AS_NODE),
// where `fs` treats every `*.asar` file as a virtual directory. Plain-Node
// tests can't see that, so these run the real code under the real runtime.
// Skipped when no Paseo is installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { localAppData, resourcesDir } from "../server/layout.ts";

const PLUGIN_DIR = join(import.meta.dirname, "..");
const onWindows = process.platform === "win32";

/** An installed Paseo and the executable that runs as Node with ELECTRON_RUN_AS_NODE. */
const runtimes = onWindows
  ? [join(localAppData(), "Programs", "Paseo-Vibrancy"), join(process.env.ProgramFiles ?? "C:\\Program Files", "Paseo")].map(
      (app) => ({ app, node: join(app, "Paseo.exe") }),
    )
  : [join(homedir(), "Applications/Paseo-Vibrancy.app"), "/Applications/Paseo.app"].map((app) => ({
      app,
      node: join(app, "Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper"),
    }));
const paseo = runtimes.find(({ node }) => existsSync(node));
const skip = paseo ? false : "no Paseo install to borrow an Electron runtime and app.asar from";

/** A minimal install holding a real asar archive (cloned on macOS, so it's cheap). */
function bundleWithAsar(dir: string): string {
  const resources = resourcesDir(dir);
  mkdirSync(resources, { recursive: true });
  const asar = join(resourcesDir(paseo!.app), "app.asar");
  if (onWindows) {
    copyFileSync(asar, join(resources, "app.asar"));
    // The asar-integrity fuse check reads Paseo.exe first: a stand-in whose
    // fuse wire says "off" lets the build reach the asar.
    const wire = Buffer.concat([Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"), Buffer.from([1, 9]), Buffer.from("101100011")]);
    writeFileSync(join(dir, "Paseo.exe"), wire);
  } else {
    execFileSync("cp", ["-c", asar, join(resources, "app.asar")]);
  }
  return dir;
}

// The module under test is imported inside the child Electron process, which
// is the only place the asar-patched `fs` exists, so it can't be a static
// import of this (plain-Node) test file.
function runInElectron(code: string): { status: number | null; output: string } {
  const result = spawnSync(paseo!.node, ["--input-type=module", "-e", code], {
    cwd: PLUGIN_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("sweepOlderPristine removes an old install containing app.asar under Electron", { skip }, (t) => {
  const cache = mkdtempSync(join(tmpdir(), "vibrancy-efs-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const old = bundleWithAsar(join(cache, onWindows ? "Paseo-0.0.1" : "Paseo-0.0.1.app"));

  const run = runInElectron(
    `const { sweepOlderPristine } = await import("./server/release.ts");
     await sweepOlderPristine(${JSON.stringify(cache)}, "0.11.0");`,
  );

  assert.equal(run.status, 0, run.output);
  assert.equal(existsSync(old), false);
});

test("buildStaging replaces a staging copy containing app.asar and reads the archive under Electron", { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vibrancy-efs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Source has a real archive but no app-dist, so the build gets past
  // `rm(staging)`, the copy and the asar read/patch/write, then fails at the
  // renderer lookup and cleans up after itself.
  const source = bundleWithAsar(join(dir, onWindows ? "Source" : "Source.app"));
  const staging = bundleWithAsar(join(dir, onWindows ? "Staging" : "Staging.app"));

  const run = runInElectron(
    `const { buildStaging } = await import("./server/build.ts");
     try {
       await buildStaging({ source: ${JSON.stringify(source)}, staging: ${JSON.stringify(staging)}, ghosttyPath: "/nonexistent" });
       console.log("RESULT unexpected success");
     } catch (e) {
       console.log("RESULT " + e.code + " " + e.message);
     }`,
  );

  const result = run.output.match(/^RESULT (.*)$/m)?.[1] ?? run.output;
  assert.match(result, /index\.html/, `expected the renderer lookup to be the first failure, got: ${result}`);
  assert.equal(existsSync(staging), false, "failed build must remove staging");
});
