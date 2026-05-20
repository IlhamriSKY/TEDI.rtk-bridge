# TEDI RTK Bridge

Companion extension for [TEDI](https://github.com/IlhamriSKY/TEDI) that
routes the built-in AI agent's shell tools through
[RTK](https://github.com/IlhamriSKY/RTK), the Rust Token Killer proxy,
for **60–90% token savings** on git / npm / dev operations.

<p align="center">
  <img src="logo.png" alt="RTK Bridge" width="128" />
</p>

> [!NOTE]
> RTK is not bundled with this extension. Install it separately and put
> `rtk` on your PATH; the extension only detects it and surfaces savings
> in the status bar. The actual `rtk <cmd>` prefixing is a TEDI core
> preference (`aiShellPrefix`); see step 3 in
> [Install](#install) below.

---

## Install

In TEDI:

1. Open **Settings → Extensions**.
2. Switch to the **From GitHub** tab.
3. Paste `IlhamriSKY/TEDI.rtk-bridge` (or the full URL).
4. Click **Review → Install**.

Then flip the AI shell prefix once:

5. Open **Settings → Agents** → **AI shell prefix**, type `rtk ` (with a
   trailing space), click **Save**.

TEDI hits `releases/latest` on this repo, downloads the `.zip` asset
produced by the [release workflow](.github/workflows/release.yml), runs
its standard install pipeline (size cap, path-traversal guard, manifest
validation, fingerprint), and activates the extension. The card with
this README's logo appears in Settings → Extensions, and the RTK status
icon appears in the bottom-right of TEDI's status bar.

### Updating

The same Settings → Extensions screen has a **Check updates** button.
TEDI compares `tag_name` of the latest GitHub release against the
installed `manifest.version`. If newer, an **Update** button re-runs
the install pipeline against the new release. No manual download.

---

## How it works

```
TEDI AI agent
    │
    │  tool: bash_run({ command: "git status" })
    ▼
src/modules/ai/tools/shell.ts  ── reads `aiShellPrefix`
    │
    │  effective = "rtk " + "git status"
    ▼
Rust: shell_session_run
    │
    │  PowerShell on Windows, $SHELL -lc on Unix
    ▼
rtk git status  ──▶  git  ──▶  trimmed output  ──▶  fewer tokens billed
```

The extension itself never touches the command stream. It only:

1. Probes `rtk --version` every 30 s to detect the install.
2. Polls `rtk gain` every 60 s for cumulative token-savings.
3. Paints a status-bar icon with the version + savings line.
4. Toasts once on first detect with the one-line setup nudge.

The icon reflects RTK install state only. Extension-scoped settings
cannot read or write core TEDI preferences (by design), so the icon
brightness is independent of the `aiShellPrefix` flag. To verify the
bridge is fully active, look at the tooltip *and* confirm Settings →
Agents shows `rtk ` in the prefix field.

---

## Permissions

Declared in `manifest.json`:

```json
"permissions": [
  "ui:toast",
  "statusbar:write",
  "invoke:shell_run_command"
]
```

| Permission                  | What it lets the extension do                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `ui:toast`                  | Onboarding toast on first RTK detect.                                                      |
| `statusbar:write`           | Show / hide the RTK icon in TEDI's status bar.                                             |
| `invoke:shell_run_command`  | Run `rtk --version` and `rtk gain`. One-shot; no long-running process, no sidecar.         |

No filesystem, no keychain, no network access. RTK itself is invoked
over local shell so no outbound traffic ever leaves the machine.

---

## Cross-platform notes

The probe command (`rtk --version`) is identical on every platform;
TEDI wraps it in `pwsh -NoProfile -Command` on Windows and `$SHELL -lc`
on Unix. The single gotcha is making sure RTK is on the PATH that
non-interactive shells inherit:

- **Windows**: drop `rtk.exe` anywhere on `%PATH%` (e.g.
  `%USERPROFILE%\.local\bin`) and restart TEDI so the new PATH is
  inherited.
- **macOS / Linux**: put `rtk` somewhere on `$PATH` (`/usr/local/bin`,
  `/opt/homebrew/bin`, `~/.local/bin`). PATH additions made in
  `.bashrc` / `.zshrc` may be skipped by non-interactive shells; put
  them in `.profile` / `.zprofile` instead.

If the status bar says **"RTK not detected on PATH"** while
`rtk --version` works in your regular terminal, this is almost always
the cause.

---

## Local development

```bash
git clone https://github.com/IlhamriSKY/TEDI.rtk-bridge.git
cd TEDI.rtk-bridge

# Package + install into TEDI to test:
zip dev.zip manifest.json extension.js logo.png README.md LICENSE
# In TEDI: Settings → Extensions → From file → dev.zip
```

After install, watch TEDI's dev-tools console (`Ctrl+Shift+I`) for
`[ext:tedi.rtk-bridge]` log lines (probe results, toast, status-bar
updates all print there).
