# Plugin page, better-paseo glass and signing (2026-11-17)

Decisions taken while adding better-paseo-style plugin pages to Vibrancy and Oxocarbon, and fixing what that work turned up.

## Plugin page metadata

- **Chosen.** Both manifests gain `name`, `description`, `icon` (`assets/icon.png`) and `media` (`docs/hero.png`). Paseo's manifest schema has accepted these since v0.11.0 (getpaseo/paseo #6263, `2d85fe4e`, an ancestor of v0.11.0), so `requirements.paseo` stays `>=0.11.0`.
- **Limit.** Paseo 0.16 shows the icon and the media gallery only from a registry listing (`plugin-page.tsx` renders `listing?.icon` and `MediaStrip` only when a listing exists). Directory installs show the name and description, then a letter tile. A local test registry showed the icon and hero correctly.
- **User decision.** The user decided not to publish to plugins.paseo.sh. The fields stay, because they are harmless and ready if that changes.

## Two-column Vibrancy screen

- **Chosen.** On web at a measured width of 960 px or more, the sections split into two columns: left Appearance, Tabs and Browser; right Terminal and Build. Below that width and on native, the screen stays a single column.
- **Width cap.** Paseo caps the page column at 1080 px in 0.16, and the SDK has no API for a wider page. While the screen is mounted it lifts that cap to 1440 px and restores it on unmount. The hook is adapted from better-paseo (MIT).
- **Turned down.** A live preview column like better-paseo's. Vibrancy's appearance controls already apply live.
- **Oxocarbon.** Metadata only, since it has no settings to lay out.

## better-paseo floating surfaces

- **Cause.** `SURFACE_PATCHES` zero `surface0`, plugins receive Paseo's theme, and better-paseo fills its menus, hover preview and tooltips with `surface0`.
- **Chosen.** Extend `FLOATING_SURFACES_CSS` with better-paseo's test ids, three accessible names and its top-layer tooltip. That is the same mechanism that already covers Paseo's own popovers.
- **Turned down.** An opaque `surface0` for plugins, which would turn better-paseo's in-pane surfaces into opaque slabs. Patching better-paseo, which is not ours.
- **Known gap.** The table copy control loses its glass while both of its labels read "Copied".

## Font overrides kept

- **Request.** The user asked to drop overrides that better-paseo covers.
- **Evidence.** Vibrancy's font settings drive only the xterm terminal (`TERMINAL_METRICS`, `TERMINAL_METRICS_SYNC`) and the workspace title weight. better-paseo's font and size preferences (`uiFont`, `monoFont`, `codeFontSize`, `blockFontSize`, `detailsFontSize`) style only its chat timeline. Its source never references xterm or the terminal resolvers.
- **Result.** Nothing overlaps, so nothing was removed.

## Screen Recording grant

- **Cause.** tccd logged `Failed to match existing code requirement for subject sh.paseo.desktop`. The stored requirement was stock Paseo's Developer ID. The copy is ad-hoc signed, so its requirement was its cdhash, which changes on every rebuild.
- **User decision.** The user chose the durable fix. The build re-signs the outer bundle with `designated => identifier "<CFBundleIdentifier>"`, and the requirement is part of the build fingerprint, so older copies are prompted to rebuild.
- **Accepted cost.** Any ad-hoc app that claims `sh.paseo.desktop` matches the grant. A stock Paseo update would also pass Squirrel's requirement check, which leaves the dead `app-update.yml` feed as the only guard against an update overwriting the copy.
- **Turned down.** A one-off `tccutil reset`, which would break again at the next rebuild.

## Missed 0.16.0 patches

- **Found.** The 0.16.0 build was stamped `missed`: the glass selection (dark and light) and the workspace labels line.
- **User decision.** Fix it in its own bugfix branch.
