// TEDI RTK Bridge - registers a shell-command transformer that prefixes
// AI-issued commands with `rtk `, routing them through RTK (Rust Token
// Killer) for token-trimmed output.
//
// Architecture (v0.2 onwards):
//   - TEDI core exposes a generic `ctx.shell.registerCommandTransformer`
//     hook. Zero RTK-specific code lives in the host; the bridge fully
//     owns the prefix logic and re-registers it on every activate.
//   - On activate, the extension probes `rtk --version` once. If RTK is
//     on PATH, it registers a transformer that returns "rtk " + cmd for
//     every AI shell call (bash_run, bash_background, run_in_terminal,
//     suggest_command). If RTK isn't on PATH, the extension activates
//     but registers nothing - the AI keeps working with raw commands.
//   - On deactivate / uninstall, TEDI's host runs the disposer returned
//     by registerCommandTransformer, which clears the entry from the
//     registry. The transform chain returns to passthrough cleanly with
//     no leftover state.
//   - First-detect onboarding toast nudges the user that RTK is wired
//     up. Latched in per-extension storage so it appears at most once
//     per machine.
//
// RTK install: out of scope. See README.

const VERIFY_TIMEOUT_SECS = 5;
const PROBE_VERSION_CMD = "rtk --version";

let ctx = null;
/** Disposer returned by `ctx.shell.registerCommandTransformer`. Captured
 *  defensively even though the host auto-runs it on deactivate, so a
 *  future re-probe path can re-register cleanly. */
let disposeTransformer = null;

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
      return firstLine.replace(/^rtk\s+/i, "");
    }
  } catch (err) {
    // ENOENT / command-not-found surfaces here on most platforms.
    // Treat as not-installed without spamming the user with an error.
    ctx.logger?.info?.("rtk --version not available", err);
  }
  return null;
}

/**
 * Sync transformer the host calls for every AI shell command. Prefixes
 * with "rtk " unconditionally - the `kind` arg ("bash" | "terminal")
 * is ignored because RTK rewraps identically in both code paths.
 *
 * The transformer must stay synchronous: it sits in the AI tool hot
 * path and an async hop would add a roundtrip per command. Async work
 * (probing RTK) happens once at activate; the result decides whether
 * to register at all.
 */
function rtkTransformer(command /* , kind */) {
  return `rtk ${command}`;
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
  ctx.logger?.info?.(`RTK ${version} detected; registering shell transformer`);

  // Hook the host's generic transformer registry. From here on every
  // AI shell call passes through `rtkTransformer` until the extension
  // is disabled / uninstalled (the host auto-disposes for us).
  try {
    disposeTransformer = ctx.shell.registerCommandTransformer(rtkTransformer);
  } catch (err) {
    // Permission error or older TEDI without the API. Surface clearly so
    // the user knows nothing is being wrapped.
    ctx.logger?.error?.("registerCommandTransformer failed", err);
    try {
      ctx.ui.toast(
        "RTK Bridge: this TEDI build doesn't expose ctx.shell. Update TEDI to >= 0.2.9 or grant `shell:transform` permission.",
        { variant: "error" },
      );
    } catch {
      // Toast permission missing too; nothing more to do here.
    }
    return;
  }

  if (hasShownOnboarding) return;
  try {
    ctx.ui.toast(
      `RTK ${version} detected. AI shell commands are now routed through RTK for token savings.`,
      { variant: "success" },
    );
  } catch (err) {
    ctx.logger?.warn?.("onboarding toast failed", err);
  }
  void ctx.storage.set("onboarding_shown", true).catch(() => {});
}

export async function deactivate() {
  // The host auto-clears our transformer entry on deactivate, but call
  // the captured disposer too for safety - it's idempotent so the
  // double-clear is harmless.
  if (typeof disposeTransformer === "function") {
    try {
      disposeTransformer();
    } catch {
      // ignore - registry already cleared
    }
    disposeTransformer = null;
  }
  ctx = null;
}
