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
// The rewrite decision itself lives in `transform.js`, which is pure and has
// its own runnable check. This file is host wiring only.
//
// Configuration - `<workspace>/.tedi/rtk.json` (every key optional):
//   {
//     "enabled": true,          // false disables wrapping for this project
//     "command": "rtk",         // the prefix / binary to route through
//     "wrap": ["terraform"],    // extra commands to route through RTK
//     "skip": ["docker"]        // commands to leave alone
//   }
//
// RTK install: out of scope. See README.

import {
  DEFAULT_CONFIG,
  DEFAULT_WRAP,
  makeConfig,
  normalizeConfig,
  parseProbe,
  probeCommand,
  transform,
} from "./transform.js";

const VERIFY_TIMEOUT_SECS = 5;
const PROBE_VERSION_CMD = "rtk --version";
const CONFIG_REL_PATH = ".tedi/rtk.json";

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
/** Monotonic ticket for `refreshConfig`, so two workspace switches in flight
 *  cannot land out of order and leave `config` describing the wrong project. */
let refreshSeq = 0;
/** The wrap set every project starts from: `DEFAULT_WRAP` narrowed to what the
 *  availability probe found on PATH. Falls back to the full list if the probe
 *  cannot run, which is exactly the pre-probe behavior. */
let wrapBase = DEFAULT_WRAP;

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

/**
 * Which of `names` resolve on PATH. `null` when the probe could not answer -
 * it errored, timed out, or came back with nothing - in which case the caller
 * keeps the full list rather than silently disabling the extension.
 *
 * Dropping a tool that is not installed is what stops `rtk <tool>` from
 * printing "[rtk: program not found]" and then exiting 0 on a command that
 * never ran. Narrowing too far only costs savings; never correctness.
 */
async function probeAvailable(names) {
  // `rtk` is the canary: `probeOnce` just ran `rtk --version` successfully, so
  // it is definitely on PATH. Not seeing it back means the shell did not read
  // the whole argument list and the answer is partial, not informative.
  const canary = "rtk";
  try {
    const res = await ctx.invoke("shell_run_command", {
      command: probeCommand(ctx.os?.platform, names, canary),
      cwd: null,
      timeoutSecs: VERIFY_TIMEOUT_SECS,
    });
    const found = parseProbe(res?.stdout ?? "", names, canary);
    if (!found) {
      ctx.logger?.warn?.(
        "PATH probe came back without its canary, so this shell did not read the whole list; routing the full default set instead.",
      );
    }
    return found;
  } catch (err) {
    ctx.logger?.info?.("PATH probe failed; routing the full default list", err);
    return null;
  }
}

/** Surface a rejected config file. It only fires on a malformed or hostile
 *  `.tedi/rtk.json`, so a toast is proportionate - silently disabling would
 *  leave the user wondering why RTK stopped. */
function reportRejected(message) {
  ctx?.logger?.error?.(message);
  try {
    ctx?.ui?.toast?.(message, { variant: "error" });
  } catch {
    // Toast permission missing; the log line stands on its own.
  }
}

/** Read `<root>/.tedi/rtk.json`. A missing, unreadable, or invalid file falls
 *  back to the default, so RTK keeps working with no config. */
async function loadConfig(root) {
  // `wrapBase`, not `DEFAULT_WRAP`: a project with no config file still only
  // routes the tools the probe found on this machine.
  const fallback = makeConfig(true, "rtk", wrapBase);
  if (!root) return fallback;
  const path = `${root.replace(/[\\/]+$/, "")}/${CONFIG_REL_PATH}`;
  try {
    const res = await ctx.invoke("fs_read_file", { path });
    if (!res || res.kind !== "text") return fallback;
    return normalizeConfig(JSON.parse(res.content), reportRejected, wrapBase);
  } catch {
    return fallback;
  }
}

/** Reload config for `root` unless it is already the loaded one. */
async function refreshConfig(root) {
  if (root === loadedRoot) return;
  loadedRoot = root;
  const seq = ++refreshSeq;
  const next = await loadConfig(root);
  // A later switch started while this read was in flight - it owns `config`.
  if (seq === refreshSeq) config = next;
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
  const available = await probeAvailable(DEFAULT_WRAP);
  if (available) wrapBase = DEFAULT_WRAP.filter((c) => available.has(c));
  ctx.logger?.info?.(
    `RTK ${version} detected; routing ${wrapBase.length}/${DEFAULT_WRAP.length} tools (${wrapBase.join(", ")})`,
  );

  // Load the active workspace's config before registering, so the first command
  // already runs under the project's settings. Then track workspace switches:
  // onContextChange fires once immediately on subscribe (a no-op here since the
  // root is unchanged) and again on every later switch.
  await refreshConfig(ctx.app.getContext().workspaceCwd ?? null);
  disposeContext = ctx.app.onContextChange((c) => {
    void refreshConfig(c.workspaceCwd ?? null);
  });

  try {
    disposeTransformer = ctx.shell.registerCommandTransformer((command) =>
      transform(config, command),
    );
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
      `RTK ${version} detected. ${wrapBase.length} of your installed dev tools are routed through RTK; configure it per project in .tedi/rtk.json.`,
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
  wrapBase = DEFAULT_WRAP;
  loadedRoot = null;
  ctx = null;
}
