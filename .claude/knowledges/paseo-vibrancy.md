# paseo-vibrancy: how it works

Paseo runs from a patched copy at `~/Applications/Paseo-Vibrancy.app`. The
patches — transparency/vibrancy, oxocarbon ANSI colours (optional), terminal
metrics from the Terminal settings (optionally overridden by the Ghostty
config), lower idle frame rates — are applied by this Paseo
plugin (manifest id `paseo-vibrancy`), installed with
`paseo plugin install github:MomePP/paseo-vibrancy` (or a local clone path)
and rebuilt from Settings > Plugins > paseo-vibrancy > `…` > Vibrancy inside
the app — no cron, no shell hook, no manual invocation. The plugin replaced
an earlier standalone script that did the same patching by hand before
Paseo supported plugins.

The companion oxocarbon theme lives in a separate repo/plugin,
`MomePP/paseo-oxocarbon` (id `paseo-oxocarbon`); the oxocarbon ANSI palette
is applied to the terminal by default, independent of the active Paseo theme,
and can be switched to Paseo's stock palette in the Terminal settings.

## Why a patched copy at all, and why it has to be a copy

Established by experiment against Paseo 0.11.0-beta.3:

| Constraint | Detail |
| --- | --- |
| A patched bundle must be re-signed locally | A copy of the notarized app with modified resources but the *original* signature kept is held at launch by Gatekeeper (`GK evaluateScanResult: 3 … Prompt shown`; `spctl`: "a sealed resource is missing or invalid"). The unmodified build assesses `accepted, Notarized Developer ID`. |
| `/Applications/Paseo.app` can't be patched in place | Write-protected against a non-Paseo responsible process (App Management, `EPERM`), and keeping Paseo's in-app updater pointed at a patched bundle would just let it overwrite the patches anyway. |
| Hardened runtime, no `disable-library-validation` | An unsigned `blur.node` only loads because the whole copy is ad-hoc signed (`codesign --force --deep --sign -`). |
| Server plugins have full Node | `index.server.ts` is esbuild-compiled and runs in a forked daemon subprocess with no permission flags; `node:` imports are only forbidden from client code. |
| Plugin registration | `~/.paseo/config.json` → `plugins.<id>` (`{"source":"directory","path":…,"enabled":true}`), outside the app bundle — a plugin directory, not an installed app resource. |
| `desktop-settings.json` has no `daemon` block | `keepRunningAfterQuit` defaults `false`: quitting the app stops the daemon and every plugin subprocess, including this one mid-build. |
| Isolated dev/test instance | `PASEO_HOME` (daemon home — point its `config.json` at a free port) and `PASEO_ELECTRON_USER_DATA_DIR` (userData + single-instance lock) run a second, independent Paseo without touching the live one. `--user-data-dir` is ignored by Electron here. |

Paseo's designated requirement, used by `verifyPaseoSignature` to confirm a
downloaded release is really Paseo before anything is built from it:

```
identifier "sh.paseo.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "99ZMJMKU9Y"
```

## Layout

```text
paseo-plugin.json          { "id": "paseo-vibrancy", "requirements": { "paseo": ">=0.11.0-beta.3" } }
package.json, tsconfig.json
index.client.tsx            settings screen contribution (renderer)
index.server.ts             registers the five RPC handlers (daemon subprocess)
client/                     VibrancyScreen, RangeRow, vibrancy-css.ts (CSS variable applier)
server/                     asar.ts, build.ts, ghostty.ts, main-hook.ts, blur.ts,
                             patch-engine.ts, patch-renderer.ts, renderer-patches.ts,
                             release.ts, status.ts, swap.ts, settings-file.ts
shared/                     rpc.ts (zod contracts), vibrancy.ts (settings schema/defaults),
                             build-progress.ts (build steps, weights, overall fraction)
test/                       node --test
```

| Part | Runtime | Role |
| --- | --- | --- |
| `index.client.tsx`, `client/` | renderer | Vibrancy settings screen, live `--paseo-*` CSS variables, update notice |
| `index.server.ts`, `server/` | daemon subprocess (full Node) | release fetch/verify, build, swap, settings file |
| `pv.js` (generated into the bundle) | Paseo's Electron main process | per-window material/blur, watches the settings file |
| `blur.node` (compiled into the bundle) | Paseo's Electron main process | `setBlur(handle, radius)` via private CGS calls, `dlsym`'d so a missing symbol is a no-op, not a crash; `matchCorners(handle)` keeps the window server's corner radius equal to AppKit's |

## Live appearance settings

Schema lives in `shared/vibrancy.ts`, persisted by the server to
`~/Library/Application Support/Paseo/paseo-vibrancy.json`:

```ts
{ material: "none" | "sidebar" | "hud" | "under-window" | "fullscreen-ui"
            | "menu" | "popover" | "titlebar" | "header" | "sheet"
            | "window" | "content" | "under-page" | "selection" | "tooltip",
  blurRadius: number,   // 0–60, used when material is "none"
  tint: number,         // 0–1
  paneGlass: boolean }
```

Defaults: `{ material: "none", blurRadius: 30, tint: 0.85, paneGlass: true }`.

- **Main process (`pv.js`).** Loaded by the asar window-options hook line
  `transparent:require(process.resourcesPath+"/pv.js"),visualEffectState:"active",`
  — 79 bytes, space-padded into the 80-byte original
  `backgroundColor: (0, window_manager_js_1.getWindowBackgroundColor)(systemTheme),`
  slot so every byte offset inside the asar stays put. `pv.js` ends with
  `module.exports = true`, so the `require` yields `transparent: true`.
  `visualEffectState` rides in the same slot because Electron has no runtime
  setter for it — it only keeps a material from going flat when the window
  loses focus, read once by `setVibrancy`. Material ≠ `"none"`:
  `win.setVibrancy(material)` and `blur.setBlur(handle, 0)`. Material
  `"none"`: `win.setVibrancy(null)` and `blur.setBlur(handle, blurRadius)`.
  Every `apply` also calls `blur.matchCorners(handle)` (see the corners
  gotcha below).
- **Renderer (`client/vibrancy-css.ts`).** On load and on every change, sets on
  `document.documentElement`:
  - `--paseo-tint` — consumed by the body wash rule:
    `background-color: color-mix(in srgb, var(--colors-surface1, <stock hex>) calc(var(--paseo-tint, <default>) * 100%), transparent);`
  - `--paseo-pane-bg` — `transparent` when `paneGlass`, else
    `var(--colors-surface1)`; consumed by the navigator backdrop patch.
- **Vibrancy screen** (`addSettingsScreen({ id: "vibrancy", title: "Vibrancy", … })`):
  three sections. Appearance: Material (`SettingsSelect`), Blur radius and Tint
  (styled `<input type="range">`), Main pane glass (`SettingsSwitch`); every
  change calls `setSettings`, tint/pane apply locally at once rather than
  waiting on the round trip. Terminal: the settings below (range rows fall
  back to selects off web); rows Ghostty overrides are disabled and hinted
  "Set by Ghostty config". Build: versions, report, actions, and "Rebuild to
  apply changes" when `runningVibrancyBuild && !fingerprintMatches`. Saving
  (debounced 150 ms) refreshes status so that notice tracks edits. In stock
  (unpatched) Paseo the screen shows "Not running the Vibrancy build" and
  only the Build card and Terminal settings are usable.

## Terminal settings (baked in at build time)

`settings.terminal`, all fields with `.catch` defaults (a missing or
malformed object parses to the defaults):

| Field | Range / values | Default |
| --- | --- | --- |
| `followGhostty` | boolean | `true` |
| `fontSize` | 8–32 step 0.5, or `null` = Paseo's Code size | 13.5 |
| `lineHeight` | 1.0–2.0 step 0.05 | 1.1 |
| `fontWeight` / `fontWeightBold` | 100–900 step 100 | 400 / 600 |
| `cursorStyle` | `bar`, `block`, `underline` | `bar` |
| `paddingLeft` | 0–40 integer px | 10 |
| `ansi` | `oxocarbon`, `paseo` | `oxocarbon` |

Unlike appearance, none of this is live: `pv.js` ignores `terminal`, and the
values land in the renderer bundle on the next Rebuild. `resolveTerm`
(`server/ghostty.ts`) turns them into `TermMetrics`; padding becomes
`0 0 0 <paddingLeft>px`. With `followGhostty` on, Ghostty's `font-family`,
`font-style`, `font-style-bold`, `cursor-style` and percentage
`adjust-cell-height` override the matching fields and are returned as
`overriddenByGhostty` (term keys: `fontFamily`, `fontWeight`,
`fontWeightBold`, `cursorStyle`, `lineHeight`); with it off the file is not
read and `fontFamily` is `null` (Paseo's Code font). A `null` `fontSize`
keeps Paseo's own settings-sync behaviour for size.

## RPC contracts (`shared/rpc.ts`)

| RPC | Input | Output |
| --- | --- | --- |
| `vibrancy.status` | — | running version, built-from version, fingerprint match, `ghosttyOverrides` (term keys the Ghostty config currently overrides), latest known release, last build report, last build error, `building`, `progress` (`{ step, fraction, detail }` or `null`; see "Build is asynchronous") |
| `vibrancy.check-update` | — | latest release `{version, zipUrl, sha512, size}` or `null`, plus an error string |
| `vibrancy.build` | `{ version?: string, restart: boolean }` | `{ ok, report: [], error }` — returns immediately once queued (see "Build is asynchronous" below), never waits for the build itself |
| `vibrancy.get-settings` / `vibrancy.set-settings` | settings (appearance + `terminal`) | settings |

**Gotcha: RPC names must be lowercase.** `defineRpc` throws on a camelCase
`name` — the SDK enforces a lowercase-with-dots pattern, pinned by a
dedicated test (`test/rpc-names.test.ts`) asserting every exported RPC's
`name` matches the pattern the SDK accepts.

**Gotcha: Paseo's theme tokens are not the plugin's names.** The oxocarbon
theme plugin maps its eight colours onto Paseo's internal semantic set by
*position*, not name — read off the bundle's own `buildDarkSemanticColors`:
`surface0→background`, `surface1→raised` (this is the one that controls how
bright the whole content pane reads, not `background`), `surface2→control`,
`surface3→border`, `surface4→ring`, `surfaceSidebar→background`,
`foregroundMuted→mutedForeground`, `foregroundExtraMuted→ring`. Getting this
wrong silently produces a theme that applies but reads wrong.

## Release fetch and verification (`server/release.ts`)

1. `GET https://api.github.com/repos/getpaseo/paseo/releases?per_page=20`;
   pick the newest non-draft release by semver — prereleases (betas) count,
   `rolloutHours` is ignored.
2. Fetch that tag's `beta-mac.yml` (fall back to `latest-mac.yml`); hand-roll
   the electron-builder yml just far enough to pull the `Paseo-<ver>-arm64.zip`
   entry's `sha512`/`size` out of its `files:` list (no YAML dependency — the
   format is small and fixed).
3. Download to `~/Library/Caches/paseo-vibrancy/`, hashing while streaming
   (zips run ~186 MB; nothing is buffered in memory). Size and base64 sha512
   must both match what the yml published, or the download is rejected and
   the cache dir is left exactly as found.
4. `ditto -x -k` the zip, then
   `codesign --verify --deep --strict -R='<designated requirement above>'`
   on the extracted bundle. This is the identity check (really Paseo, not a
   same-named impostor); the sha512 above is the integrity check (the bytes
   electron-builder actually published). Both must pass.
5. Move the verified app into `~/Library/Caches/paseo-vibrancy/Paseo-<ver>.app`
   as the build source; `sweepOlderPristine` deletes strictly-older cached
   copies for the same keep-version (parse failures are left alone rather
   than guessed at).

Without network, `build` falls back to the cached pristine app for the
version being built (`cachedPristine`).

## Build (`server/build.ts`, into `~/Applications/.Paseo-Vibrancy.staging.app`)

1. `ditto` the pristine source into staging.
2. `asar.ts`: a single same-length replace in `app.asar` (the window-options
   hook line above). A length change aborts rather than risk corrupting the
   archive's internal offsets.
3. Renderer bundle + `index.html` (`patch-renderer.ts`,
   `renderer-patches.ts`): every renderer patch, with its own anchors,
   occurrence counts, and `ok`/`MISSED`/sweep semantics — alpha helper,
   surface alphas, window chrome payload, terminal metrics + sync, diff
   palette, overlay surfaces (annotate card, toast pill), frame-rate
   stepping, readable surface0 foregrounds, hover fills, backdrop masks,
   trailing scrim, kebab chip/gutter, resize handle, navigator backdrop
   (now `var(--paseo-pane-bg, transparent)`), oxocarbon ANSI, opaque-surfaces
   stylesheet (`<style id="paseo-vibrancy-opaque-surfaces">`) + xterm
   padding + workspace title weight (`font-weight: 500 !important` on
   `[data-testid="workspace-header-title"]`; stock is 300 from 720px up via
   a unistyles media rule; font smoothing deliberately left at stock
   `antialiased` — `auto` read as bold), flash-guard → tint rule. The
   terminal metrics come from
   `resolveTerm(settings.terminal)` in `server/ghostty.ts`; `buildStaging`
   reads the saved settings with `readSettings(opts.settingsFile)`. The
   oxocarbon ANSI patch runs only when `terminal.ansi === "oxocarbon"`; with
   `"paseo"` the stock palette stays and no note is emitted for it.
4. Write `pv.js` (`server/main-hook.ts`); compile `blur.node`
   (`server/blur.ts`) with `clang -bundle -undefined dynamic_lookup -framework AppKit -fobjc-arc`.
   A failed compile reports `MISSED window blur: <reason>` but materials
   keep working — blur is best-effort, not load-bearing.
5. `app-update.yml` → `DEAD_UPDATE_YML`, a neutered `provider: generic`
   pointing at `https://127.0.0.1:1/paseo-vibrancy-disabled/`, an address
   that cannot resolve. Asserted (the file must exist first), not written
   blind — if Paseo ever moves or renames this file, a blind write would
   silently fail to disable the real updater.
6. `PlistBuddy -c 'Set :ElectronAsarIntegrity:Resources/app.asar:hash …'`
   (not `plutil -replace` — the key name contains a dot, which `plutil`
   would read as two nested keys).
7. Write the build stamp (`.vibrancy-build`, format `<version>|vibrancy=<fingerprint>`,
   `\nmissed` appended if any patch was `MISSED`) **before** signing — once
   the bundle is sealed, anything added under `Contents/Resources`  makes
   `codesign --verify` report a missing sealed resource.
8. `codesign --force --deep --sign -` (ad-hoc). Editing anything under
   `Contents/` invalidates the Developer ID signature, and the hardened
   runtime refuses to launch unsigned.

`buildFingerprint` hashes every byte-affecting input — `BUILD_TABLES` (every
renderer/html patch table and constant), the asar hook anchor/line, `pv.js`,
the blur source and its clang flags, `DEAD_UPDATE_YML`, and the resolved
terminal metrics (`TermMetrics`, which includes `ansi` and the Ghostty
overrides actually applied) — so any edit to a patch, the main-process hook,
blur, the updater-neutering text, the saved terminal settings, or the Ghostty
config changes the stamp. `vibrancy.status`'s `fingerprintMatches` compares
the *running* bundle's stamped fingerprint against a fresh
`buildFingerprint(resolveTerm(readSettings().terminal).term)`, so "Rebuild
needed" reflects source drift and saved-setting changes since the last build,
not just a version bump.

## Build is asynchronous (`index.server.ts`)

Paseo's daemon rejects a plugin RPC that runs past its 30 s timeout. A
rebuild from the cached pristine app takes ~4.5 s (it was ~21.5 s until the
two synced-loader frame-rate patterns were anchored with `(?<![\w$])`;
unanchored, each scan retried from every character of the bundle's long
word runs); an Update (~186 MB download + `ditto` + `codesign --deep`
verify + build) routinely blows past 30 s. So `vibrancy.build` never awaits
the build: it returns `{ok:true}` the instant the job is queued (or
`{ok:false, error:"build already running"}` if one is already in flight)
and the job itself runs in the background through `BuildQueue`. The job
records its own outcome — `lastReport` and a
`lastError: string | null` in `vibrancy.status` — before it settles, success
or failure, including the partial `report` `buildStaging` attaches to a
thrown error (notes collected before the failing step). `restart: true`
only calls `startSwap` once the build has actually succeeded.

While the job runs, `progress` in `vibrancy.status` is
`{ step, fraction, detail }`. `BUILD_STEPS` (`shared/build-progress.ts`)
lists the steps in run order with weights in measured seconds (download is
network-bound and weighted 20): `download`, `extract`, `verify`, `copy`,
`patch`, `compile`, `sign`. A rebuild from a cached pristine copy plans
`copy`..`sign`; a build that has to download plans `download`..`sign`
(`buildPlan`). `fraction` is overall 0..1, computed only by
`overallFraction`: finished planned weights plus the current step's own
fraction times its weight, over the planned total. Only the download
reports progress inside a step (its byte fraction, `detail` like
`"84 / 186 MB"`); every other step reports its start through
`downloadVerified`'s `onProgress` or `buildStaging`'s `onStep`. `patch`
covers asar, renderer, html and `pv.js`; the updater and plist edits
(milliseconds) run after `compile` starts. Measured on beta.4: copy
~0.3 s, patch ~1.9 s, compile ~0.7 s, sign ~1.6 s. `patchRenderer` is
synchronous, so `vibrancy.status` cannot answer for those ~1.7 s. On
failure, or success without restart, `progress` returns to `null`; after a
successful `restart: true` job it stays `{ step: "restart", fraction: 1 }`,
since the swap quits this process within about a second.

`client/VibrancyScreen.tsx` polls `vibrancy.status` every 500 ms while a
build runs. The polling is an effect keyed on `buildQueued ||
status.building`, not a loop owned by the button handler, so reopening the
screen mid-build picks the live bar back up from the first status fetch.
`buildQueued` is set once `vibrancy.build` queues, so polling starts even
before a status showing `building` has arrived (and catches a job that
fails instantly). Build buttons and appearance controls stay disabled
while polling. When `building` turns false it toasts `lastError`, or the
button's success message; a screen that joined a build already running
has none and shows "Build finished". With `progress` non-null the Build
card shows a row above the actions: the step's label ("Restarting Paseo"
for `restart`), `detail` as hint, and a 4 px accent bar with the
percentage.

## Swap and restart (`server/swap.ts`)

`build({ restart: true })` spawns a detached POSIX sh script
(`detached: true`, `stdio: "ignore"`, `unref()`) that survives the moment
Paseo — and this plugin's own server subprocess, a child of Paseo's daemon —
quits. The script itself traps SIGHUP so the process group's
controlling-terminal hangup on quit can't cut it short either. Every step
(and the failure reason) is appended, timestamped, to
`~/Library/Logs/paseo-vibrancy-swap.log` (`exec >>LOG 2>&1` at the top of the
script) — nothing else observes a detached, unref'd child's output, so
without the log a silent failure here just looks like Paseo never reopened.

With `quit: true` it asks the running patched copy to quit by bundle id
(`osascript … quit`), then polls `pgrep -a -f` on the bare executable
path(s) — anchored (`^…$`) and regex-escaped, so a path containing `(`, `)`,
`+` or `.` still matches only itself — up to 60 s (120 × 0.5 s) before
giving up. Bootstrapping from stock `/Applications/Paseo.app`, the
*currently-running* exe differs from the *target* (`Paseo-Vibrancy.app`)
exe the swap is about to replace, so the handler also passes `runningExe`
(the running bundle's `Contents/MacOS/<CFBundleExecutable>`, read via
`execName`, falling back to `"Paseo"`); the wait only ends once neither
process matches.

Each `mv` is checked and the failure paths matter: a failed trash-move
leaves `staging` untouched; a failed staging→target move (dangling
`staging`, read-only `target` parent, …) restores the trashed copy from
`$TRASHED` rather than leaving the user with no app at all or a
half-swapped bundle. `target` is never left holding both the old and new
bundle nested inside each other. On *any* failure after the quit request —
the wait timing out, a failed trash-move, or a failed staging-move (already
rolled back) — the script reopens `previousApp`, the app that was running
(stock `/Applications/Paseo.app` when bootstrapping, otherwise `target`,
back to the old bundle by that point), when `open` is true, then exits 1.

`restart: false` (the only mode this plugin's own install/smoke steps use)
never calls `startSwap`; `buildStaging` already deletes any prior `staging`
before writing a new one, so there is nothing left over to swap in later —
a subsequent "Rebuild & restart" always starts from a fresh build, not a
leftover staging copy.

## Update notice

On client load, `index.client.tsx` calls both `checkUpdate` and `status` (not
status alone — status's `latest` is empty at launch, so a status-only poll
would never surface the toast on a fresh session). A newer release shows a
conditional sidebar item pointing at the Vibrancy screen (surface id
`vibrancy-update`); a fingerprint mismatch (plugin edited since the last
build) shows "Vibrancy rebuild needed" the same way. The SDK's toast is
hook-only (`useToast`, usable only inside a rendered screen) — there is no
imperative/global toast API, so the launch-time notice is `addSidebarItem` +
`addScreen` (not the deprecated `addSurface`, which the host wraps into
`addScreen({id, title:id, …})` and so shows the raw id as the header instead
of "Vibrancy"), registered/removed imperatively from `contribute()`;
`useToast` is used only for in-screen action results (a build finishing, an
update completing).

## Gotchas found during implementation

- **The server runs on Electron's Node, where `fs` treats `*.asar` as a
  directory** — the plugin server is a child of Paseo's daemon (`Paseo
  Helper`, ELECTRON_RUN_AS_NODE). Async `rm -r` of a bundle fails with
  ENOTEMPTY on `Contents/Resources` (it recurses into `app.asar` instead of
  unlinking it) and `readFile(app.asar)` is ENOENT. Bundle file I/O goes
  through `server/fs.ts`, which picks Electron's `original-fs` and falls back
  to `node:fs` under plain Node. Plain-Node tests and scripts can't see this:
  `test/electron-fs.test.ts` runs the real code under Paseo's Electron
  runtime. Get both modules from `process.getBuiltinModule` — a default or
  namespace import of `node:fs` makes Paseo's plugin bundler read every
  export and log `fs.F_OK` deprecation warnings.
- **The quit wait needs `pgrep -a`.** The swap script descends from the
  running Paseo (app -> supervisor -> daemon -> plugin -> script), and macOS
  `pgrep` leaves out its own ancestors unless given `-a`. Without it the wait
  ended at once, the new copy opened while the old Paseo was still quitting,
  and it attached to the old copy's daemon: killing that daemon left the new
  copy stuck on "reconnecting to host". `test/swap.test.ts` runs the real
  check under a binary sitting at the target's executable path.
- **Quitting the app can leave its daemon running.** After a Rebuild &
  restart from stock Paseo, the app exited within ~170 ms of the quit request
  without its usual "stopping captured supervisor" step, so its supervisor and
  daemon (both running from the old bundle) stayed up — the Dock showed
  "Paseo — Running in Background" — and the relaunched copy attached to them.
  The cause inside Paseo is unconfirmed. The swap no longer relies on it:
  once the app is gone it runs the old bundle's own
  `Contents/Resources/bin/paseo daemon stop --timeout 15 --force` before
  moving anything, so the new copy always starts a daemon from its own bundle.
- **The swap script must not inherit `ELECTRON_*` variables.** The plugin
  server inherits the daemon's ELECTRON_RUN_AS_NODE=1, and `open -a` hands
  the caller's environment to the app it launches: a Paseo started that way
  runs as plain Node, finds no script and exits 0 within milliseconds,
  writing nothing to `main.log`. `startSwap` spawns the script with
  `launchEnv(process.env)`, which drops every `ELECTRON_*` key. In the system
  log the failed launch also showed a first-launch `syspolicyd` assessment and
  an AMFI "constraint violation" on `libffmpeg.dylib`; both are harmless and
  appear on successful first launches too.
- **RPC names must be lowercase** — see above; `defineRpc` throws otherwise.
- **Theme tokens differ from Paseo's internal names** — see above; map by
  position (`buildDarkSemanticColors`'s own order), not by matching names.
- **`fs.watch` arming race in `pv.js`.** The settings-file watcher is
  debounced (50 ms) and set up once at load; a settings write that lands in
  the narrow window before the watcher is armed is missed until the *next*
  write. The test covering this makes the race practically unobservable by
  reissuing the write every 200 ms and polling the effect every 20 ms
  against a 2 s deadline, instead of relying on the very first write landing.
- **The swap `mv` needs a rollback, not just a check.** An early version
  checked the first `mv` but not the second — a failed staging→target move
  after the old bundle was already trashed left no app at all. Both `mv`s
  are checked and the second failure re-`mv`s `$TRASHED` back into place.
- **Blur targets nothing until the window is shown.** Paseo creates its
  `BrowserWindow` with `show: false` and reveals it on `ready-to-show`; an
  NSWindow that has never been ordered on screen has no window-server number
  yet, so a blur call issued from `browser-window-created` targets nothing.
  `pv.js` re-applies (`apply(win)`) on the window's own `'show'` event, not
  just at creation.
- **A transparent window gets square corners in the window server.** On
  macOS 27 (observed on 27.0.1), AppKit clips a transparent window's content
  at the system radius (16 pt) itself, but because its corner mask does not
  define the shadow shape (`-[NSWindow _cornerMaskShouldDefineShadow]` is
  `NO` for a clear background), the pre-commit flush sends the window server
  a corner radius of 0. The background blur and the window outline follow
  the window server's shape, so glass showed past the rounded content: a
  square glass corner, or a dark outline with a smaller radius than the
  content. Stock Paseo (opaque) reports radii `16,16,16,16` from
  `SLSWindowIteratorGetCornerRadii`; the patched window reported `0,0,0,0`.
  Setting the radius once is not enough: AppKit recomputes the mask through
  `-[NSWindow _cornerMaskChanged]` on every appearance change (Paseo's theme,
  macOS auto light/dark) and around native fullscreen, and writes 0 again.
  That is why a relaunch "fixed" it for a while. `matchCorners` adds a
  `_cornerMaskShouldDefineShadow` returning `YES` to the window's class and
  calls `_cornerMaskChanged`, so AppKit itself sends 16 on every recompute.
  Both selectors are checked with `respondsToSelector:` first; if a future
  macOS drops them, `matchCorners` returns `false` and does nothing.
- **`runningBundle` must walk to the outermost `.app`.** The daemon's own
  `execPath` resolves inside
  `…/Paseo-Vibrancy.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper`
  — two `.app` segments. `runningBundle` takes the *first* `.app` boundary
  from the root, landing on `Paseo-Vibrancy.app`, not the nested helper.
  Outside the daemon (e.g. a throwaway smoke script run under plain `node`),
  `process.execPath` has no `.app` segment at all and `runningBundle` returns
  `null` — pass `version` explicitly to `build()` in that case.
- **Plugin RPCs time out at 30 s.** A `vibrancy.build` call that awaited the
  actual build (rebuild ~21.5 s at the time, ~4.5 s now; Update well over a
  minute) routinely got killed by Paseo's daemon mid-build with no way to
  recover the result — see "Build is asynchronous" above.
- **Quit-wait must track the *running* exe, not just the target's.**
  Bootstrapping from stock `/Applications/Paseo.app`, `Paseo-Vibrancy.app`
  (the swap target) was never running, so a wait that only polled the
  target's executable ended immediately while stock Paseo was still
  quitting and holding the shared userData lock — see "Swap and restart"
  above for the `runningExe` fix.

## Verifying a build outside the GUI

There is no CLI RPC for `vibrancy.build`. To drive a real build without
restarting Paseo (e.g. after installing/reloading the plugin), import
`createHandlers` from `index.server.ts` in a throwaway Node script and call
`await handlers.build({ version, restart: false })` with no injected deps —
it uses the real filesystem/network defaults (`~/Library/Caches/paseo-vibrancy/`,
`~/Applications/.Paseo-Vibrancy.staging.app`). `build()` itself resolves as
soon as the job is queued (see "Build is asynchronous" above);
`await handlers.queue.whenIdle()` afterward to wait for the real build to
finish, then read `(await handlers.status()).lastReport`/`lastError`. A
clean build reports zero `lastReport` lines starting with `MISSED`,
`lastError` is `null`, and
`codesign --verify --deep --strict ~/Applications/.Paseo-Vibrancy.staging.app`
exits 0.
