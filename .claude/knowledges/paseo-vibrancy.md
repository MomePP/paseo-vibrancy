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
paseo-plugin.json          { "id": "paseo-vibrancy", "requirements": { "paseo": ">=0.11.0" } }
package.json, tsconfig.json
index.client.tsx            settings screen contribution (renderer)
index.server.ts             registers the five RPC handlers (daemon subprocess)
client/                     VibrancyScreen, RangeRow, live-settings.ts (CSS variable applier)
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
| `pv.js` (generated into the bundle) | Paseo's Electron main process | per-window material/blur, watches the settings file, WebHID chooser for browser tabs |
| `blur.node` (compiled into the bundle) | Paseo's Electron main process | `setBlur(handle, radius)` via private CGS calls, `dlsym`'d so a missing symbol is a no-op, not a crash; `matchCorners(handle)` keeps the window server's corner radius equal to AppKit's |

## WebHID chooser for browser tabs (`pv.js`)

Paseo's browser tabs are `<webview>` guests on the `persist:paseo-browser`
partition (`dist/features/browser-profile.js`). Electron gives an app no HID
chooser: with no `select-hid-device` listener on the session,
`navigator.hid.requestDevice()` resolves to `[]` and nothing is shown.
Paseo 0.13.0 sets no listener and no permission handlers, so stock Paseo
cannot use WebHID at all (observed: code.gogoboard.org's Connect returned
`[]` with a GoGo Board 7, `0461:0020`, plugged in).

`pv.js` listens on `app`'s `web-contents-created`; for a `webview` guest it
adds one `select-hid-device` listener per session (a `WeakSet` dedupes the
guests that share the partition). The listener calls `preventDefault()` and
shows `dialog.showMessageBox` (a sheet on the focused window) with one button
per device, `<name> (<vid>:<pid>)` in 4-digit hex, plus Cancel. The picked
device's `deviceId` goes to `callback`; Cancel, a dialog error, or an empty
list calls `callback()` with no argument, which Electron treats as cancel.
The dialog lists only what Chromium already filtered: the page's filters,
minus devices whose reports are all protected (Chromium logs "Chooser dialog
is not displaying a device whose reports are all protected" for the GoGo
board's keyboard interface; its raw-HID interface is listed).

Permission checks need no handler: with none set, Electron allows them, and
Paseo sets none. No `setDevicePermissionHandler` either, so a grant lasts for
the session (Chromium's default), not across relaunches. Paseo's own window
(`getType() === "window"`) gets no listener.

Verified on a patched 0.13.0 copy run isolated (`PASEO_HOME` +
`PASEO_ELECTRON_USER_DATA_DIR`, `--remote-debugging-port`): a webview on
`persist:paseo-browser` calling `requestDevice({filters:[{vendorId:0x0461}]})`
with a CDP `userGesture` resolved to `GoGo Board 7 461:20` with one collection.

## Live appearance settings

Schema lives in `shared/vibrancy.ts`, persisted by the server to
`~/Library/Application Support/Paseo/paseo-vibrancy.json`:

```ts
{ material: "none" | "sidebar" | "hud" | "under-window" | "fullscreen-ui"
            | "menu" | "popover" | "titlebar" | "header" | "sheet"
            | "window" | "content" | "under-page" | "selection" | "tooltip",
  blurRadius: number,   // 0–60, used when material is "none"
  tint: number,         // 0–1
  paneGlass: boolean,
  openFilesInNewTab: boolean }  // plus `terminal`, see below
```

Defaults: `{ material: "none", blurRadius: 30, tint: 0.85, paneGlass: true,
openFilesInNewTab: false }`.

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
- **Renderer (`client/live-settings.ts`).** On load and on every change, sets on
  `document.documentElement`:
  - `--paseo-tint` — consumed by the body wash rule:
    `background-color: color-mix(in srgb, var(--colors-surface1, <stock hex>) calc(var(--paseo-tint, <default>) * 100%), transparent);`
  - `--paseo-pane-bg` — `transparent` when `paneGlass`, else
    `var(--colors-surface1)`; consumed by the navigator backdrop patch.

  It also sets `globalThis.__paseoOpenFilesInNewTab`
  (`OPEN_FILES_IN_NEW_TAB_GLOBAL`) to `openFilesInNewTab`, before the
  `document` check. The renderer's `canReplacePreview` (file branch) is
  patched unconditionally to read that global at call time, so the toggle is
  live; plugin disabled ⇒ flag undefined ⇒ stock behaviour. The first build
  after updating the plugin is needed to carry the patch.
- **Vibrancy screen** (`addSettingsScreen({ id: "vibrancy", title: "Vibrancy", … })`):
  four sections. Appearance: Material (`SettingsSelect`), Blur radius and Tint
  (styled `<input type="range">`), Main pane glass (`SettingsSwitch`); every
  change calls `setSettings`, tint/pane apply locally at once rather than
  waiting on the round trip. Tabs: Open files in a new tab (`SettingsSwitch`,
  disabled like the Appearance controls). Terminal: the settings below (range rows fall
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
| `vibrancy.status` | — | host `platform` (`darwin`/`win32`), running version, built-from version, fingerprint match, `ghosttyOverrides` (term keys the Ghostty config currently overrides), latest known release, last build report, last build error, `building`, `progress` (`{ step, fraction, detail }` or `null`; see "Build is asynchronous") |
| `vibrancy.check-update` | - | latest release `{version, zipUrl, size, algorithm, digest}` (`digest` hex; `sha512` on macOS, `sha256` on Windows) or `null`, plus an error string |
| `vibrancy.build` | `{ version?: string, restart: boolean }` | `{ ok, report: [], error }` — returns immediately once queued (see "Build is asynchronous" below), never waits for the build itself |
| `vibrancy.get-settings` / `vibrancy.set-settings` | settings (appearance + `terminal`) | settings; the RPC schema accepts either OS's materials and `set-settings` narrows to the host's own before saving |

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
   format is small and fixed). The base64 sha512 becomes a hex `digest`.
3. Download to `~/Library/Caches/paseo-vibrancy/`, hashing while streaming
   (zips run ~186 MB; nothing is buffered in memory). Size and digest
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
   trailing scrim, kebab chip/gutter, resize handle, file tab reuse guard
   (`"file"===…nextTarget.kind&&!globalThis.__paseoOpenFilesInNewTab&&…`),
   navigator backdrop
   (now `var(--paseo-pane-bg, transparent)`), oxocarbon ANSI, floating-surfaces
   stylesheet (`<style id="paseo-vibrancy-floating-surfaces">`, glass since 0.3.0) + xterm
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
- **Paseo 0.13 changed the bundle's object syntax.** Its Expo 57 toolchain
  emits object spread natively: a style 0.12 compiled to
  `toast:Object.assign({…},e.shadow.md,{…})` is `toast:{…,...e.shadow.md,…}`
  in 0.13. Anchors take `(?:Object\.assign\()?\{` so one table serves both.
- **An anchor that differs between Paseo versions is a `variants` entry.**
  0.13 replaced `tabHovered`/`tabActive`/`tabActiveUnfocused` with one
  `tabFill(backdrop)`, so `TAB_FILLS` lists both shapes and
  `Patcher.replaceReFirst` applies the first one present. A plain table entry
  per shape would leave the other shape MISSED, and the build stamp `missed`,
  on every version. Every patch applies on both 0.12.0-beta.1 and 0.13.0.
- **The client's SDK imports must exist on the oldest supported host.** The
  plugin client runs against the host Paseo's own SDK modules. SDK 0.13
  deprecates `@getpaseo/plugin/client/react-native` for `client/ui`, but
  `client/ui` only exports `ScrollView` and `useToast` from 0.13 on, so moving
  the imports would break the Vibrancy screen (the one that updates Paseo) on
  0.11 and 0.12. The deprecated entry stays until `requirements.paseo` is
  raised to `>=0.13.0`; the SDK removes it after 2027-04-20. The devDependency
  stays pinned to the minimum host (0.11.0) for the same reason.

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

## Windows (since the `feature/windows-support` port, Paseo 0.12.0)

Verified on Windows 11 build 26300 against Paseo 0.12.0 x64; the whole
Install → Rebuild & restart → copy launches → live settings flow ran end to
end in an isolated instance.

| Topic | Fact |
| --- | --- |
| Platform switch | `shared/platform.ts` `HOST_PLATFORM` is `process.platform`, meaningful on the server only. The client can run on another device than the host (browser, phone), so it takes the host's OS from `vibrancy.status.platform` for the material list and the blur-radius row, and the RPC settings schema accepts both OSes' materials. Everything platform-specific on the server takes an optional `platform` argument defaulting to `HOST_PLATFORM`, so tests can drive the other OS's branch. |
| Install layout | `server/layout.ts`: the install is the folder holding `Paseo.exe`; `resources/` replaces `Contents/Resources`. Every Paseo process (app, daemon, plugin server) runs `Paseo.exe`, so `runningBundle` is just its folder. |
| Version | No Info.plist: `appVersion` reads `package.json` out of `resources/app.asar` by parsing the asar header (16-byte prefix, header JSON length at byte 12, file data at `8 + headerSize + offset`). |
| Release asset | `Paseo-Setup-<v>-{x64,arm64}.zip`, its root is the install itself. No yml lists it; the GitHub API's `assets[].digest` (`sha256:<hex>`) and `size` are the only integrity check, and there is no identity check (builds are unsigned). `Release` carries `algorithm` + hex `digest` for both platforms. Extract with `%SystemRoot%\System32\tar.exe`, never `tar` from PATH (Git's GNU tar can't read zips). |
| Asar integrity | Windows Electron has no plist hash to update. The build reads the fuse wire (sentinel `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`, version byte 1, count, one ASCII byte per fuse) out of `Paseo.exe` and refuses unless `EnableEmbeddedAsarIntegrityValidation` (index 4) is `0`. 0.12.0: `101100011`. |
| Copy | `copyTree` through `original-fs`, so `app.asar` is copied as a file under the daemon's asar-patched fs (`test/electron-fs.test.ts` runs this under the real `Paseo.exe`). No compile or sign step; `buildPlan` drops `verify`, `compile`, `sign` on Windows. |
| Material | `setBackgroundMaterial` (`none`, `acrylic`, `mica`, `tabbed`), default `acrylic`; needs Windows 11 22H2 (build 22621). `assertWindowsBlurSupported` refuses older builds before any download. The registry `ProductName` says "Windows 10" on Windows 11: use the build number. The client hides the blur radius row. A material from the other OS's list parses to this OS's default. |
| Window | `frame: false`, transparent: square corners (electron#47510): Electron leaves out `WS_THICKFRAME` for transparent windows, and DWM only rounds framed ones. Electron answers `WM_NCHITTEST` with the resize codes at the edges. |
| Maximize | Electron can't maximize a transparent window natively, so it sizes it to the work area (`IsZoomed` stays false). With an auto-hide taskbar the work area is the whole monitor, the window covers it exactly, and Windows treats it as full screen: the taskbar never slides up. `pv.js` replaces `maximize`/`unmaximize`/`isMaximized`/`getNormalBounds` on each window (Paseo's toggle, its title-bar button label and its window-state persistence all go through those) and leaves the bottom 2 px free when the work area equals the monitor. Verified: maximized rect `0,0,2560,1438`, the taskbar slides up, restore and relaunch-maximized work. |
| Quit | `CloseMainWindow()` on the main `Paseo.exe` quits the whole tree, daemon and plugin server included, within about a second (with `keepRunningAfterQuit` false). |

### Gotchas: starting the swap script on Windows

- **A detached PowerShell does nothing.** Node's `detached: true` is
  `DETACHED_PROCESS`: no console at all, and `powershell.exe` then exits 0
  without running its script. Confirmed with a marker-file script.
- **A detached Node runner pins the folder.** `process.execPath` in the plugin
  server is `Paseo.exe` of the running copy. Running the swap through it makes
  the swap wait on (and be unable to move) its own executable: the quit wait
  timed out with that runner as the one process left.
- **What works:** a non-detached, hidden PowerShell runs `Start-Process
  powershell.exe -WindowStyle Hidden ... -EncodedCommand`. libuv's job object
  has silent breakaway, so the grandchild survives the plugin server and
  Paseo quitting, and it gets a hidden console. Its working directory is the
  temp dir, so it never pins a folder it has to move.
- Paths are passed as PowerShell single-quoted strings (`'` doubled); the
  scripts are tested with apostrophes, spaces and `$(...)` in paths.
- The old copy is renamed aside, staging moved in and the new copy launched
  first; only then come the shell calls, the Start menu shortcut
  `Paseo Vibrancy.lnk` (written only when missing) and the Recycle Bin
  (`Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory`). Each runs in a
  `Start-Job` cut off after 15 s: `IWshShortcut.Save()` sometimes wrote the
  file and never returned (about 1 run in 40, more with several at once),
  which used to stop the swap before it relaunched Paseo.

### Testing on Windows

- The agent session itself runs inside stock Paseo, so never quit it. Run a
  test copy isolated: `PASEO_HOME` (a `config.json` with `daemon.listen` on a
  free port) plus `PASEO_ELECTRON_USER_DATA_DIR`, from a folder other than
  `C:\Program Files\Paseo` — the swap closes every process run from the
  running exe's path, which would include the real Paseo if both ran from it.
  The server's default settings file follows `PASEO_ELECTRON_USER_DATA_DIR`.
- `paseo.cmd plugin install <dir> --home <PASEO_HOME>` registers the plugin;
  "Enable plugins" is a switch in Settings > Plugins.
- Launch with `--remote-debugging-port=<port>` to drive the renderer over CDP
  (`/json/list`, `Runtime.evaluate`); the settings screen is
  `paseo://app/settings/hosts/<id>/plugins/paseo-vibrancy/vibrancy`.
- `npm test` quotes the glob with double quotes: cmd.exe passes single
  quotes through literally, and the run found 0 tests.
- An open `fs.watch` keeps the Windows test process alive after the tests
  finish: `test/main-hook.test.ts` closes the watchers `PV_JS` opens.
