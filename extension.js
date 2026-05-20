// TEDI RTK Bridge - one-shot RTK detector + onboarding nudge.
//
// Architecture:
//   - TEDI core reads `aiShellPrefix` from preferences and prepends it to
//     every shell command run by the built-in AI agent (`bash_run`,
//     `bash_background`). See src/modules/ai/tools/shell.ts.
//   - This extension does NOT write that preference (extension settings
//     are auto-namespaced as `ext:<id>:<key>` and cannot overwrite core
//     preferences; intentional security boundary).
//   - On activate, the extension runs `rtk --version` once. If RTK is on
//     PATH and the onboarding toast hasn't fired before, it toasts the
//     setup instructions and latches a flag in `ctx.storage` so the
//     prompt appears at most once per machine.
//   - RTK installs are user-driven (manual). See the README for per-OS
//     install commands.
//
// No status-bar icon, no polling, no `rtk gain` UI. The card-level Switch
// in Settings -> Extensions is the only on/off control.

const VERIFY_TIMEOUT_SECS = 5;
const PROBE_VERSION_CMD = "rtk --version";

let ctx = null;

async function probeOnce() {
  try {
    const result = await ctx.invoke("shell_run_command", {
      command: PROBE_VERSION_CMD,
      cwd: null,
      timeoutSecs: VERIFY_TIMEOUT_SECS,
    });
    const stdout = String(result?.stdout ?? "").trim();
    if (result?.exit_code === 0 && stdout) {
      const firstLine = stdout.split(/\r?\n/)[0].trim();
      const version = firstLine.replace(/^rtk\s+/i, "");
      return version;
    }
  } catch (err) {
    // ENOENT / command-not-found arrives here on most platforms. Treat
    // as not-installed without spamming the user with an error toast.
    ctx.logger?.info?.("rtk --version not available", err);
  }
  return null;
}

export async function activate(context) {
  ctx = context;

  let hasShownOnboarding = false;
  try {
    hasShownOnboarding = (await ctx.storage.get("onboarding_shown")) === true;
  } catch {
    // Storage unavailable; fall through and let the toast fire. Worst
    // case the user sees the onboarding hint twice across reinstalls.
  }

  const version = await probeOnce();
  if (!version) {
    ctx.logger?.info?.(
      "RTK not detected on PATH. Install RTK and toggle this extension off/on to retry.",
    );
    return;
  }
  ctx.logger?.info?.(`RTK ${version} detected`);

  if (hasShownOnboarding) return;
  try {
    ctx.ui.toast(
      `RTK ${version} detected. Open Settings → Agents and set 'rtk ' (with trailing space) as the AI shell prefix to enable token savings.`,
      { variant: "info" },
    );
  } catch (err) {
    ctx.logger?.warn?.("onboarding toast failed", err);
  }
  void ctx.storage.set("onboarding_shown", true).catch(() => {});
}

export async function deactivate() {
  ctx = null;
}
