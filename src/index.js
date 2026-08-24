// TEDI RTK Bridge - routes the AI agent's shell commands through RTK (Rust
// Token Killer) for token-trimmed output, configurable per project via a local
// `.tedi/rtk.json` file (the same convention TEDI uses for memory and skills).
//
// Architecture:
//   - TEDI core exposes a generic `ctx.shell.registerCommandTransformer` hook
//     and a read-only app context (`ctx.app`). No RTK-specific code lives in
//     the host; this bridge owns the prefix logic and the configuration.
//   - On activate it probes `rtk --version` once. If RTK is on PATH it reads the
//     active workspace's config, then registers a synchronous transformer that
//     wraps each AI shell command with the configured prefix. The config is
//     re-read whenever the active workspace changes.
//   - On deactivate / uninstall the host disposes the transformer and the
//     context subscription; the transform chain returns to passthrough.
//
// Configuration - `<workspace>/.tedi/rtk.json` (every key optional):
//   {
//     "enabled": true,        // false disables wrapping for this project
//     "command": "rtk",       // the prefix / binary to route through
//     "skip": ["cd", "export"] // first-token commands to leave untouched
//   }
// A project with no `.tedi/rtk.json` keeps the original behavior: every command
// is wrapped with `rtk`. The configured prefix is always skip-listed implicitly,
// so a meta call like `rtk gain` is never double-wrapped.
//
// RTK install: out of scope. See README.

const VERIFY_TIMEOUT_SECS = 5;
const PROBE_VERSION_CMD = "rtk --version";
const CONFIG_REL_PATH = ".tedi/rtk.json";

/** Behavior when no project config is present: wrap every command with `rtk`. */
const DEFAULT_CONFIG = { enabled: true, command: "rtk", skip: [] };

/** @type {import("../tedi").ExtensionContext | null} */
let ctx = null;
/** Disposers from the host. Captured even though the host auto-runs them on
 *  deactivate, so teardown is explicit and idempotent. */
let disposeTransformer = null;
let disposeContext = null;
/** Active rewrite config. The synchronous transformer reads this; file reads
 *  never happen on the command hot path, only on activate / workspace change. */
let config = DEFAULT_CONFIG;
/** Workspace root the current config was loaded for, so context-change events
 *  that don't move the workspace skip a redundant re-read. */
let loadedRoot = null;

async function probeOnce() {
  try {
    const result = await ctx.invoke("shell_run_command", {
      command: PROBE_VERSION_CMD,
      cwd: null,
      timeoutSecs: VERIFY_TIMEOUT_SECS,
    });
    const stdout = String(result?.stdout ?? "").trim();
    if (result?.exit_code === 0 && stdout) {
      return stdout.split(/\r?\n/)[0].trim().replace(/^rtk\s+/i, "");
    }
  } catch (err) {
    // ENOENT / command-not-found surfaces here on most platforms. Treat as
    // not-installed without spamming the user with an error.
    ctx.logger?.info?.("rtk --version not available", err);
  }
  return null;
}

/** Coerce arbitrary parsed JSON into a valid config, filling defaults so a
 *  partial or malformed file can never break the transformer. */
function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;
  const command =
    typeof raw.command === "string" && raw.command.trim() ? raw.command.trim() : "rtk";
  const skip = Array.isArray(raw.skip)
    ? raw.skip.filter((s) => typeof s === "string" && s.length > 0)
    : [];
  // `enabled` defaults to true: a file that omits it still opts the project in.
  return { enabled: raw.enabled !== false, command, skip };
}

/** Read `<root>/.tedi/rtk.json`. A missing, unreadable, or invalid file falls
 *  back to the default (wrap everything), so RTK keeps working with no config. */
async function loadConfig(root) {
  if (!root) return DEFAULT_CONFIG;
  const path = `${root.replace(/[\\/]+$/, "")}/${CONFIG_REL_PATH}`;
  try {
    const res = await ctx.invoke("fs_read_file", { path });
    if (!res || res.kind !== "text") return DEFAULT_CONFIG;
    return normalizeConfig(JSON.parse(res.content));
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Reload config for `root` unless it is already the loaded one. */
async function refreshConfig(root) {
  if (root === loadedRoot) return;
  loadedRoot = root;
  config = await loadConfig(root);
}

/**
 * Synchronous transformer the host calls for every AI shell command (both the
 * hidden `bash` kind and the visible `terminal` kind). Wraps the command with
 * the configured prefix unless wrapping is disabled, the first token is in
 * `skip`, or it already starts with the prefix (which prevents `rtk rtk ...`).
 */
function rtkTransformer(command) {
  if (!config.enabled) return command;
  const firstToken = command.trimStart().split(/\s+/)[0] ?? "";
  if (firstToken === config.command || config.skip.includes(firstToken)) return command;
  return `${config.command} ${command}`;
}

/** @param {import("../tedi").ExtensionContext} context */
export async function activate(context) {
  ctx = context;

  let hasShownOnboarding = false;
  try {
    hasShownOnboarding = (await ctx.storage.get("onboarding_shown")) === true;
  } catch {
    // Storage unavailable; fall through and let the toast fire. Worst case the
    // user sees the onboarding hint twice across reinstalls.
  }

  const version = await probeOnce();
  if (!version) {
    ctx.logger?.info?.(
      "RTK not detected on PATH. Install RTK and toggle this extension off/on to retry.",
    );
    return;
  }
  ctx.logger?.info?.(`RTK ${version} detected; registering shell transformer`);

  // Load the active workspace's config before registering, so the first command
  // already runs under the project's settings. Then track workspace switches:
  // onContextChange fires once immediately on subscribe (a no-op here since the
  // root is unchanged) and again on every later switch.
  await refreshConfig(ctx.app.getContext().workspaceCwd ?? null);
  disposeContext = ctx.app.onContextChange((c) => {
    void refreshConfig(c.workspaceCwd ?? null);
  });

  try {
    disposeTransformer = ctx.shell.registerCommandTransformer(rtkTransformer);
  } catch (err) {
    // Permission error or older TEDI without the API. Surface clearly so the
    // user knows nothing is being wrapped.
    ctx.logger?.error?.("registerCommandTransformer failed", err);
    try {
      ctx.ui.toast(
        "RTK Bridge: this TEDI build doesn't expose ctx.shell. Update TEDI to >= 0.3.9 or grant `shell:transform` permission.",
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
      `RTK ${version} detected. AI shell commands are routed through RTK; configure it per project in .tedi/rtk.json.`,
      { variant: "success" },
    );
  } catch (err) {
    ctx.logger?.warn?.("onboarding toast failed", err);
  }
  void ctx.storage.set("onboarding_shown", true).catch(() => {});
}

export async function deactivate() {
  // The host auto-clears both registrations on deactivate; call the captured
  // disposers too for safety - they are idempotent so the double-clear is fine.
  if (typeof disposeContext === "function") {
    try {
      disposeContext();
    } catch {
      // ignore - already disposed
    }
    disposeContext = null;
  }
  if (typeof disposeTransformer === "function") {
    try {
      disposeTransformer();
    } catch {
      // ignore - registry already cleared
    }
    disposeTransformer = null;
  }
  config = DEFAULT_CONFIG;
  loadedRoot = null;
  ctx = null;
}
