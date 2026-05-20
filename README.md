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
> `rtk` on your PATH; the extension detects it at activate and wires the
> prefix automatically. Disable or uninstall the extension to fully
> revert (TEDI's AI shell tools fall back to running commands raw).

---

## Install

In TEDI:

1. Open **Settings → Extensions**.
2. Switch to the **From GitHub** tab.
3. Paste `IlhamriSKY/TEDI.rtk-bridge` (or the full URL).
4. Click **Review → Install**.

That's it. No manual settings to flip. The extension registers a shell-
command transformer with TEDI's generic extension API at activate; from
then on every AI-issued shell command becomes `rtk <command>` until you
disable or uninstall.

TEDI hits `releases/latest` on this repo, downloads the `.zip` asset
produced by the [release workflow](.github/workflows/release.yml), runs
its standard install pipeline (size cap, path-traversal guard, manifest
validation, fingerprint), and activates the extension. The card with
this README's logo appears in Settings → Extensions; the card-level
Switch is the only on/off control.

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
src/modules/ai/tools/shell.ts
    │
    │  applyShellTransformers(cmd, "bash")
    │     iterates registered extension transformers in insertion order
    ▼
ctx.shell.registerCommandTransformer((cmd) => "rtk " + cmd)
    │  (registered by this extension at activate)
    ▼
Rust: shell_session_run
    │
    │  PowerShell on Windows, $SHELL -lc on Unix
    ▼
rtk git status  →  git  →  trimmed output  →  fewer tokens billed
```

The extension itself never touches the command stream. On activate it:

1. Runs `rtk --version` once to confirm RTK is on PATH.
2. If detected, calls `ctx.shell.registerCommandTransformer((cmd) => "rtk " + cmd)`.
3. Toasts the user once that RTK Bridge is active (latched in
   per-extension storage, so the prompt appears at most once per machine).

On deactivate / uninstall, TEDI's extension host automatically runs the
disposer the registration returned; the transformer chain returns to
passthrough with zero leftover state. No core TEDI code is RTK-aware.

If you install RTK *after* enabling the extension, toggle the extension
off then on from Settings → Extensions to retrigger the probe.

---

## Permissions

Declared in `manifest.json`:

```json
"permissions": [
  "ui:toast",
  "shell:transform",
  "invoke:shell_run_command"
]
```

| Permission                  | What it lets the extension do                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `ui:toast`                  | Onboarding toast on first RTK detect.                                                      |
| `shell:transform`           | Register a synchronous function the host calls before every AI shell command. **High risk** — the extension chooses what actually runs. |
| `invoke:shell_run_command`  | Run `rtk --version`. One-shot per activate; no long-running process, no sidecar.           |

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

If the onboarding toast never appears while `rtk --version` works in
your regular terminal, this is almost always the cause. Check the
dev-tools console (`Ctrl+Shift+I`) for the `[ext:tedi.rtk-bridge]`
log line confirming whether the probe succeeded.

---

## Compatibility

Requires TEDI **>= 0.2.9** for the generic `ctx.shell` host API. Older
TEDI builds don't expose `registerCommandTransformer`; the extension
detects this and shows a clear error toast instead of failing silently.

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
`[ext:tedi.rtk-bridge]` log lines (probe result, transformer
registration, toast attempt).
