<div align="center">

# paseo-vibrancy

**A frosted-glass Paseo for macOS and Windows, rebuilt and kept up to date from inside the app.**

[![License: MIT](https://img.shields.io/badge/license-MIT-161616?style=flat-square&labelColor=262626)](LICENSE)
[![Paseo](https://img.shields.io/badge/paseo-%E2%89%A50.11.0-161616?style=flat-square&labelColor=262626)](https://paseo.sh)
[![macOS](https://img.shields.io/badge/macOS-Apple%20silicon-161616?style=flat-square&labelColor=262626)](#requirements)
[![Windows](https://img.shields.io/badge/Windows-11%2022H2%2B-161616?style=flat-square&labelColor=262626)](#requirements)

<img src="docs/hero.png" alt="paseo-vibrancy with paseo-oxocarbon: frosted-glass sidebar and main pane over the desktop" width="100%">

</div>

---

Paseo's window is opaque, and Electron gives plugins no way to change that. Paseo-Vibrancy builds a patched copy of Paseo, `~/Applications/Paseo-Vibrancy.app` on macOS or `%LOCALAPPDATA%\Programs\Paseo-Vibrancy` on Windows, with a see-through window and a real background blur. Its own settings screen then tunes the look live.

## Features

- **Live glass**: material, blur radius, tint and main-pane glass, applied without a restart.
- **Open files in a new tab**: optionally keep Files and Changes from replacing the focused file tab.
- **Self-updating**: checks Paseo's GitHub releases, verifies each download (against Paseo's Developer ID signature on macOS, against GitHub's checksum on Windows), and rebuilds the copy.
- **Glass all the way through**: selected rows and tabs, hover states, menus, dialogs, tooltips, toasts and the diff view are translucent and blurred instead of opaque slabs. Your messages, the composer, its autocomplete and chips, and expanded tool calls share one frosted fill.
- **Workspace labels on their own line**: label chips sit under the branch in the sidebar instead of squeezing it.
- **Readable workspace title**: the workspace header title uses Medium weight instead of stock Paseo's thin Light weight.
- **Calmer while agents run**: spinners and shimmers are stepped instead of animating every frame, which cuts WindowServer load.
- **WebHID in browser tabs**: when a page in a Paseo browser tab calls `navigator.hid.requestDevice()`, a native dialog lists the matching devices and only the one you pick is granted. Stock Paseo shows no chooser, so the request finds nothing. On by default; switch it off under **Browser**.

## Requirements

- macOS on Apple silicon, or Windows 11 22H2 or later
- [Paseo](https://paseo.sh) 0.11.0 or later, with **Settings > Plugins > Enable plugins** on
- macOS: Xcode Command Line Tools (`xcode-select --install`) for the blur radius; without them, the Apple materials still work

On Windows 10, or Windows 11 before 22H2, the build refuses to run: those versions lack the blur materials.

## Install

In Paseo, open **Settings > Plugins**, paste the source below into **Plugin source** and press **Install plugin**:

```
github:MomePP/paseo-vibrancy
```

Or from a terminal:

```sh
paseo plugin install github:MomePP/paseo-vibrancy
```

## Build your copy

1. Open **Settings > Plugins**, then `...` next to **paseo-vibrancy**, then **Vibrancy**.
2. Press **Rebuild & restart**, or **Update & restart** if a newer Paseo release is out. The build takes under a minute; the first one also downloads Paseo, about 180 MB. Paseo then quits, and the copy opens on its own.
3. From now on, launch **Paseo-Vibrancy** instead of Paseo (on Windows, from the **Paseo Vibrancy** Start menu shortcut). Both share the same data, so only run one at a time.

Rebuilding restarts Paseo's daemon, which interrupts any running agents.

## Settings

### Appearance

Applied live, without a restart.

| Control | Range | Default | Effect |
| --- | --- | --- | --- |
| Material | macOS: `none`, `sidebar`, `hud`, `under-window`, ...; Windows: `acrylic`, `mica`, `tabbed`, `none` | macOS `none`, Windows `acrylic` | On macOS an Apple vibrancy material, where `none` uses the blur radius instead. On Windows a Windows 11 backdrop; `none` turns it off. |
| Blur radius | 0 - 60 | 30 | macOS only: background blur behind the window, used when Material is `none`. Windows' materials have a fixed blur. |
| Tint | 0 - 100% | 85% | How much of the theme colour washes over the blur. |
| Main pane glass | on / off | on | Extends the glass behind chats and editors; off keeps the main pane solid. |

### Tabs

Applied live, without a restart. The first build after updating the plugin is needed to carry the patch this toggle relies on.

| Control | Range | Default | Effect |
| --- | --- | --- | --- |
| Open files in a new tab | on / off | off | Clicking a file in Files, or opening one from Changes, always opens a new tab instead of replacing the focused unmodified file tab. Off keeps stock Paseo behaviour. |

### Browser

Applied live, without a restart. The first build after updating the plugin is needed to carry the chooser this toggle switches.

| Control | Range | Default | Effect |
| --- | --- | --- | --- |
| WebHID device chooser | on / off | on | When a page in a browser tab asks for a HID device, a dialog lists the devices it asked for and grants only the one you pick, until Paseo quits. Off keeps stock Paseo behaviour: the request finds no device. |

### Terminal

Terminal changes are baked into the copy, so they apply on the next **Rebuild & restart** or **Update & restart**. After you change one, the Build card shows "Rebuild to apply changes".

| Control | Range | Default | Effect |
| --- | --- | --- | --- |
| Follow Ghostty config | on / off | on | Lets your Ghostty config override the rows below. See below. |
| Font size | 8 - 32, step 0.5 | 13.5 | Terminal font size. Turn on **Use Paseo's Code size** to follow Settings > Appearance > Code instead. |
| Line height | 1.0 - 2.0, step 0.05 | 1.1 | Row height as a multiple of the font size. |
| Font weight | 100 - 900, step 100 | 400 | Weight of normal text. |
| Bold weight | 100 - 900, step 100 | 600 | Weight of bold text. |
| Cursor | `bar`, `block`, `underline` | `bar` | Cursor shape. |
| Left padding | 0 - 40 px | 10 | Space between the pane edge and the terminal text. |
| Terminal colours | Oxocarbon / Paseo default | Oxocarbon | The [Oxocarbon](https://github.com/nyoom-engineering/oxocarbon.nvim) ANSI palette, or Paseo's own. |

With **Follow Ghostty config** on, a key set in `~/.config/ghostty/config` wins over the matching row: `font-family`, `font-style` (font weight), `font-style-bold` (bold weight), `cursor-style` (cursor) and `adjust-cell-height` as a percentage (line height). The font family has no row; without Ghostty it stays on Paseo's Code font. Rows Ghostty is setting show "Set by Ghostty config". With it off, the Ghostty config is not read.

Oxocarbon terminal colours pair with [paseo-oxocarbon](https://github.com/MomePP/paseo-oxocarbon), which matches the rest of the app.

### Build

The **Build** card shows the running and latest Paseo versions, plus the report from the last build:

- **Check for updates** checks GitHub for a newer Paseo release.
- **Update & restart** appears when a newer release was found: it downloads that release and rebuilds onto it, which also applies pending terminal changes.
- **Rebuild & restart** takes its place otherwise, rebuilding from the release you are already running.

While an update or rebuild runs, a progress bar in the card shows the current step.

A sidebar notice appears when a newer Paseo release exists, or when the plugin has changed since your copy was built. The plugin checks at launch and then every hour, so a release published while Paseo stays open still shows up.

## How it works

- The plugin's server half downloads the matching Paseo release and verifies it. On macOS that is twice: by checksum, and by Paseo's Developer ID signature. Paseo's Windows builds are unsigned, so on Windows the only check is the SHA-256 checksum GitHub records for the release file.
- It then patches a copy and adds a small main-process hook. On macOS it also adds a native blur module and signs the copy ad-hoc; on Windows the hook sets a Windows 11 backdrop material, and the build first checks that Paseo still loads a modified `app.asar`.
- macOS refuses to launch a modified bundle that still carries Paseo's original signature, and on Windows the installed Paseo would undo the patches the next time it updates itself, so the copy lives separately and updates through the plugin. Paseo's own updater is switched off inside the copy.
- On Windows the copy's window has square corners: Windows drops the rounded corners from see-through windows.
- Every patch is matched by content. If a Paseo release moves one, the build report lists it as `MISSED` and the rest still apply.

## Files

| macOS | Windows | Purpose |
| --- | --- | --- |
| `~/Applications/Paseo-Vibrancy.app` | `%LOCALAPPDATA%\Programs\Paseo-Vibrancy` | The patched copy |
| `~/Library/Application Support/Paseo/paseo-vibrancy.json` | `%APPDATA%\Paseo\paseo-vibrancy.json` | Live appearance settings |
| `~/Library/Caches/paseo-vibrancy/` | `%LOCALAPPDATA%\paseo-vibrancy\cache` | Verified Paseo downloads |
| `~/Library/Logs/paseo-vibrancy-swap.log` | `%LOCALAPPDATA%\paseo-vibrancy\swap.log` | What happened during the last restart |

## Uninstall

```sh
paseo plugin remove paseo-vibrancy
rm -rf ~/Applications/Paseo-Vibrancy.app ~/Library/Caches/paseo-vibrancy ~/Library/Application\ Support/Paseo/paseo-vibrancy.json ~/Library/Logs/paseo-vibrancy-swap.log
```

On Windows, in PowerShell:

```powershell
paseo plugin remove paseo-vibrancy
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\Paseo-Vibrancy", "$env:LOCALAPPDATA\paseo-vibrancy", "$env:APPDATA\Paseo\paseo-vibrancy.json", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Paseo Vibrancy.lnk"
```

Then launch the regular Paseo again.

## Development

```sh
npm install
npm test
npm run typecheck
```

After editing, run `paseo plugin reload paseo-vibrancy`. Changes to the patches only take effect after a rebuild. Notes on internals and gotchas are in [`.claude/knowledges/paseo-vibrancy.md`](.claude/knowledges/paseo-vibrancy.md).

## License

[MIT](LICENSE)
