# Changelog

All notable changes to **TEDI RTK Bridge**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.2.4] - 26-05-2026

### Changed

- **Manifest description trimmed.** Reduced to the same "what + how" one-liner the other reference extensions use, so the *Settings → Extensions → From GitHub* install dialog reads cleanly when this card sits alongside SQL Explorer / Beautify / Discord Rich Presence. No runtime behaviour change.

## [0.2.3] - 25-05-2026

### Changed

- **Cosmetic em-dash sweep.** Replaced `—` (U+2014 EM DASH) with `-` (U+002D HYPHEN-MINUS) in `README.md` and `CHANGELOG.md`. No runtime code touched; functional behaviour identical to 0.2.2.

## [0.2.2] - 23-05-2026

### Changed

- Refreshed `logo.png` to the new TEDI extension iconography. No functional changes - the runtime code, permissions, and host APIs in use are identical to 0.2.1.

## [0.2.1] - 21-05-2026

### Changed

- README points to the canonical RTK repo at [rtk-ai/rtk](https://github.com/rtk-ai/rtk) instead of the old `IlhamriSKY/RTK` slug.

## [0.2.0] - 20-05-2026

### Changed

- **Breaking.** Switched from the now-removed `aiShellPrefix` core preference to TEDI's new generic `ctx.shell.registerCommandTransformer` host API (introduced in TEDI 0.2.9). The extension registers `(cmd) => "rtk " + cmd` synchronously at activate when RTK is detected on PATH; TEDI's host auto-disposes on deactivate / uninstall for plug-and-play teardown with zero leftover state.
- Requires TEDI **>= 0.2.9**. Older builds surface an error toast at activate.

### Added

- `shell:transform` permission (high risk: the extension chooses what actually runs in the AI shell).

### Removed

- Dependency on `aiShellPrefix` core preference (it was removed from TEDI core in 0.2.9).
- Unused `statusbar:write` and `settings:*` permissions.

## [0.1.2] - 20-05-2026

### Removed

- Status-bar icon. Reduced to a one-shot onboarding toast.
- `rtk gain` periodic polling (no UI surface to display savings into).
- 30 s `rtk --version` repolling. Probe now runs once at activate; toggle the extension off / on to re-detect if RTK was installed after the fact.

### Permissions

- Dropped `statusbar:write`.

## [0.1.1] - 20-05-2026

### Removed

- Inner **Show savings in status bar tooltip** toggle. The card-level Switch in Settings → Extensions is the only on / off control.

## [0.1.0] - 20-05-2026

### Added

- Initial release: detect RTK on PATH, surface install status + savings in the status bar, onboarding toast on first detect. Paired with the (since-removed) `aiShellPrefix` core preference; user manually set the prefix to `rtk ` in Settings → Agents to enable the wrapping.
