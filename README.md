# TEDI RTK Bridge

Connects TEDI's built-in AI agent to [RTK](https://github.com/IlhamriSKY/RTK)
— the Rust Token Killer proxy — so AI-issued shell commands flow through
`rtk <cmd>` instead of running raw. Typical token savings on git/npm/dev
operations: **60–90%**.

<p align="center">
  <img src="logo.png" alt="RTK Bridge" width="128" />
</p>

> [!IMPORTANT]
> **RTK must already be installed on your machine.** This extension only
> *bridges* TEDI to a working RTK install — it does not bundle, install,
> or update RTK. See [Install RTK](#install-rtk) below.

---

## What this extension does

1. **Detects RTK** by running `rtk --version` once on activate and every
   30 seconds afterwards.
2. **Surfaces status** as a small icon in TEDI's bottom-right status bar:
   - bright + `RTK x.y.z` tooltip → RTK is detected on PATH
   - pulsing → RTK not detected (install instructions below)
3. **Shows token savings** by polling `rtk gain` every 60 seconds and
   adding `· saved 12.3k tokens` to the tooltip.
4. **Toasts you once** on first detection with the one-line setup nudge:
   *"set `rtk ` as the AI shell prefix in Settings → Agents."*

The icon reflects RTK install state only — it cannot read TEDI's global
`aiShellPrefix` preference (extension-scoped settings cannot read or
write core preferences, by design). To verify the bridge is fully active,
look at the tooltip *and* confirm Settings → Agents shows `rtk ` in the
AI shell prefix field.

The extension does **not** modify TEDI's preferences directly — that's a
deliberate trust-model boundary (extension-scoped settings cannot
overwrite core preferences). You flip the prefix once in Settings; from
then on every AI `bash_run` / `bash_background` call routes through RTK.

---

## Setup (one-time, per machine)

### 1. Install RTK

> RTK install commands vary by platform. Use whichever fits your OS.
> Refer to the [RTK README](https://github.com/IlhamriSKY/RTK#install)
> for the canonical, up-to-date instructions.

| OS              | Suggested install                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Windows**     | Download the latest `.zip` from RTK releases, extract `rtk.exe` to a folder on your `PATH` (e.g. `%USERPROFILE%\.local\bin`). Or `winget install rtk` if a package is published. |
| **macOS**       | `brew install ilhamrisky/tap/rtk` (if tap is set up) — or download the macOS binary from RTK releases and `chmod +x`, then drop in `/usr/local/bin`. |
| **Linux**       | `cargo install rtk` if you have the Rust toolchain — or download the prebuilt `.tar.gz` for your arch (x86_64 / aarch64) and put `rtk` somewhere on `$PATH`.    |

Verify with:

```bash
rtk --version
rtk gain   # zero savings on first run, but the command should work
```

If either command fails with "command not found", your shell's `PATH`
doesn't see RTK yet — add the install dir to your shell rc (`.bashrc`,
`.zshrc`, `$PROFILE` for PowerShell) and reopen your terminal.

### 2. Install this extension in TEDI

1. Open **Settings → Extensions**.
2. Switch to the **From GitHub** tab.
3. Paste `IlhamriSKY/TEDI.rtk-bridge`.
4. Click **Review → Install**.

### 3. Flip the AI shell prefix

1. Open **Settings → Agents**.
2. Find the **AI shell prefix** field.
3. Type `rtk ` (with a trailing space) and click **Save**.

That's it. The status-bar icon flips to bright as soon as RTK is detected
(within ~5 s of activate). The prefix you set in step 3 is what actually
routes AI shell calls through RTK — the icon doesn't reflect that flag
because the extension can't read core preferences.

---

## How it works

```
TEDI AI agent
   │
   │ tool: bash_run({ command: "git status" })
   ▼
src/modules/ai/tools/shell.ts
   │
   │ const prefix = preferences.aiShellPrefix; // "rtk "
   │ effective = prefix + command;            // "rtk git status"
   ▼
Rust: shell_session_run
   │
   ▼
$SHELL -lc "rtk git status"
   │
   ▼
RTK proxy → git → trimmed output → AI sees less noise → fewer tokens billed
```

The extension never touches the command stream itself. The core TEDI
patch in [shell.ts](https://github.com/IlhamriSKY/TEDI/blob/main/src/modules/ai/tools/shell.ts)
reads the `aiShellPrefix` preference and prepends it; the extension is
just the friendly companion that detects RTK and tells you the prefix is
ready to flip on.

---

## Permissions

Declared in `manifest.json`:

```json
"permissions": [
  "ui:toast",
  "statusbar:write",
  "settings:read",
  "invoke:shell_run_command"
]
```

| Permission                | What it lets the extension do                                                          |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `ui:toast`                | Onboarding toast on first RTK detect.                                                  |
| `statusbar:write`         | Show / hide the RTK icon in TEDI's status bar.                                         |
| `settings:read`           | Read the contributed `showSavings` toggle so it can short-circuit the gain probe.      |
| `invoke:shell_run_command`| Run `rtk --version` and `rtk gain`. One-shot — no long-running process, no sidecar.    |

The "onboarding shown" latch lives in per-extension storage (`ctx.storage`)
which is a separate JSON file and doesn't require `settings:write`.

No filesystem, no keychain, no network. RTK itself is invoked over local
shell so no traffic leaves the machine.

---

## Settings

Contributed under the extension's card in **Settings → Extensions**:

| Setting                            | Default | Purpose                                                          |
| ---------------------------------- | ------- | ---------------------------------------------------------------- |
| Show savings in status bar tooltip  | on     | When off, the extension skips the `rtk gain` poll entirely and the tooltip omits the savings line. |

---

## Cross-platform support

The extension runs identically on Windows, macOS, and Linux. The probe
command (`rtk --version`) is the same on every platform; TEDI's
`shell_run_command` handles shell wrapping (`pwsh -NoProfile -Command`
on Windows, `$SHELL -lc` on Unix). RTK itself must be on the PATH the
shell wrapper inherits.

| Platform | Where to put `rtk` | Shell hosting `rtk` |
| -------- | ------------------ | ------------------- |
| Windows  | Any folder in `%PATH%`, typically `%USERPROFILE%\.local\bin` | PowerShell 7 / 5.1   |
| macOS    | `/usr/local/bin`, `/opt/homebrew/bin`, or a custom dir on `PATH` | zsh (default), bash |
| Linux    | `/usr/local/bin`, `~/.local/bin`, or a custom dir on `PATH` | bash / zsh / fish    |

---

## Troubleshooting

**Status bar shows "RTK not detected on PATH" even though `rtk --version`
works in my regular terminal.**

TEDI's `shell_run_command` spawns a non-interactive shell. PATH additions
made in `.bashrc` / `.zshrc` may be skipped — put them in `.profile` /
`.zprofile` instead so non-interactive sessions pick them up. On Windows,
restart TEDI after editing PATH so the new value is inherited.

**Token savings show 0 even though I've made lots of AI shell calls.**

Confirm the prefix is actually set: open **Settings → Agents** and check
the **AI shell prefix** field reads `rtk ` (with a trailing space). The
core patch only prepends when the field is non-empty.

**The status bar icon never changes from "checking".**

The first probe is async — give it a couple of seconds after activate.
If it stays pulsing forever, open TEDI's dev tools (Ctrl+Shift+I) and
check the console for `[ext:tedi.rtk-bridge]` lines.

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
`[ext:tedi.rtk-bridge]` log lines — the probe results and any toast /
status-bar updates print there.

---

## License

MIT. RTK itself is governed by its own license — see the RTK repo.
