// TEDI RTK Bridge - detects RTK (Rust Token Killer) on the user's PATH and
// surfaces its status + token-savings in the TEDI status bar.
//
// Architecture:
//   - TEDI core reads `aiShellPrefix` from preferences and prepends it to
//     every shell command run by the built-in AI agent (`bash_run`,
//     `bash_background`). See src/modules/ai/tools/shell.ts.
//   - This extension does NOT write to that preference (extension settings
//     are auto-namespaced as `ext:<id>:<key>` and cannot overwrite core
//     preferences - intentional security boundary). Instead, it:
//        1. Verifies RTK is installed via `rtk --version` (cross-OS).
//        2. Polls `rtk gain` periodically for token-savings.
//        3. Surfaces both in a status-bar item.
//        4. Toasts the user once on first install / first detection so they
//           know to set `rtk ` as the AI shell prefix in Settings → Agents.
//   - RTK itself is installed manually by the user. See the extension
//     README for per-OS install commands.

const VERSION_POLL_INTERVAL_MS = 30_000;
const GAIN_POLL_INTERVAL_MS = 60_000;
const VERIFY_TIMEOUT_SECS = 5;

let ctx = null;
let active = false;

let versionTimer = null;
let gainTimer = null;
let onboardingPending = false;

/** Latched on first successful detect, persists across re-activations via
 *  `ctx.storage`. Drives the "show onboarding toast once" rule. */
let hasShownOnboarding = false;

/** Cached value of the `showSavings` setting (contributes.settings entry
 *  in manifest.json). When false, `probeGain` short-circuits and the
 *  tooltip omits the savings line. Re-read on every probeVersion tick so
 *  toggling it from Settings → Extensions takes effect within 30s. */
let showSavings = true;

/** Most recent `rtk --version` output (raw string). null = not installed. */
let lastVersion = null;
/** Most recent `rtk gain` numeric summary (tokens saved). null = unknown. */
let lastSavings = null;

// `rtk --version` / `rtk gain` work identically on all 3 OSes because
// Tauri's `shell_run_command` wraps in `pwsh -NoProfile -Command` on
// Windows and `$SHELL -lc` on Unix - both inherit PATH and resolve `rtk`
// the same way. No per-OS branching needed for the command string.
const PROBE_VERSION_CMD = "rtk --version";
const PROBE_GAIN_CMD = "rtk gain";

function parseSavings(stdout) {
  if (typeof stdout !== "string") return null;
  // Look for the largest token count in the output. Matches patterns like
  // "saved 12,345 tokens", "12.3k tokens", "Total: 9876". Tolerant of
  // future RTK formatting changes.
  const matches = stdout.matchAll(/(\d[\d,.]*\s*[kKmM]?)\s*tokens?/g);
  let best = null;
  for (const m of matches) {
    const raw = m[1].replace(/,/g, "");
    let num = parseFloat(raw);
    if (!Number.isFinite(num)) continue;
    if (/[kK]/.test(m[1])) num *= 1_000;
    if (/[mM]/.test(m[1])) num *= 1_000_000;
    if (best === null || num > best) best = num;
  }
  return best;
}

function formatSavings(n) {
  if (n === null) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function safeStatusBarSet(item) {
  try {
    ctx?.statusBar?.setItem?.(item);
  } catch (err) {
    ctx?.logger?.warn?.("statusBar.setItem failed", err);
  }
}

function safeStatusBarRemove(id) {
  try {
    ctx?.statusBar?.removeItem?.(id);
  } catch (err) {
    ctx?.logger?.warn?.("statusBar.removeItem failed", err);
  }
}

function paintStatus() {
  if (!active) return;
  if (lastVersion === null) {
    safeStatusBarSet({
      id: "rtk",
      icon: "rtk.svg",
      tooltip: "RTK not detected on PATH. Install RTK and reload TEDI.",
      tone: "warning",
    });
    return;
  }
  const savingsLine =
    showSavings && lastSavings !== null ? ` · saved ${formatSavings(lastSavings)} tokens` : "";
  safeStatusBarSet({
    id: "rtk",
    icon: "rtk.svg",
    tooltip: `RTK ${lastVersion}${savingsLine}\nSet 'rtk ' as the AI shell prefix in Settings → Agents to route AI shell calls through RTK.`,
    tone: "success",
  });
}

async function refreshShowSavings() {
  try {
    const v = await ctx.settings.get("showSavings");
    // contributes.settings default is `true`, but the value is undefined
    // until the user actually flips the toggle. Treat undefined as true.
    showSavings = v === false ? false : true;
  } catch (err) {
    ctx.logger?.warn?.("settings.get showSavings failed", err);
    showSavings = true;
  }
}

async function probeVersion() {
  if (!active) return;
  // Re-read showSavings each tick so toggling the Setting takes effect
  // without an extension reload.
  await refreshShowSavings();
  try {
    const result = await ctx.invoke("shell_run_command", {
      command: PROBE_VERSION_CMD,
      cwd: null,
      timeoutSecs: VERIFY_TIMEOUT_SECS,
    });
    const stdout = String(result?.stdout ?? "").trim();
    const exit = result?.exit_code;
    if (exit === 0 && stdout) {
      // Take the first line - some RTK builds may add extra lines.
      const firstLine = stdout.split(/\r?\n/)[0].trim();
      // Strip a leading "rtk " if present, leaving just the version.
      const v = firstLine.replace(/^rtk\s+/i, "");
      const changed = lastVersion !== v;
      lastVersion = v;
      paintStatus();
      if (changed && !hasShownOnboarding) {
        showOnboardingToast();
      }
    } else {
      // Non-zero exit or empty stdout - treat as not installed.
      if (lastVersion !== null) {
        ctx.logger.info("rtk --version no longer succeeds, dropping cached version");
      }
      lastVersion = null;
      lastSavings = null;
      paintStatus();
    }
  } catch (err) {
    // ENOENT / command not found arrives here on most platforms. Treat as
    // not installed without spamming the user.
    if (lastVersion !== null) {
      ctx.logger.info("rtk probe failed; clearing cached version", err);
    }
    lastVersion = null;
    lastSavings = null;
    paintStatus();
  }
}

async function probeGain() {
  if (!active || lastVersion === null || !showSavings) return;
  try {
    const result = await ctx.invoke("shell_run_command", {
      command: PROBE_GAIN_CMD,
      cwd: null,
      timeoutSecs: VERIFY_TIMEOUT_SECS,
    });
    if (result?.exit_code === 0) {
      const parsed = parseSavings(String(result?.stdout ?? ""));
      if (parsed !== null) {
        lastSavings = parsed;
        paintStatus();
      }
    }
  } catch (err) {
    ctx.logger.warn("rtk gain probe failed", err);
  }
}

function showOnboardingToast() {
  if (onboardingPending) return;
  onboardingPending = true;
  try {
    ctx.ui.toast(
      `RTK ${lastVersion} detected. Open Settings → Agents and set 'rtk ' (with trailing space) as the AI shell prefix to enable token savings.`,
      { variant: "info" },
    );
  } catch (err) {
    ctx.logger?.warn?.("toast failed", err);
  }
  hasShownOnboarding = true;
  void ctx.storage.set("onboarding_shown", true).catch(() => {});
  // Allow re-trigger on next major version change (handled by the
  // `changed` check in probeVersion).
  onboardingPending = false;
}

function clearTimers() {
  if (versionTimer !== null) {
    clearInterval(versionTimer);
    versionTimer = null;
  }
  if (gainTimer !== null) {
    clearInterval(gainTimer);
    gainTimer = null;
  }
}

async function teardown() {
  active = false;
  clearTimers();
  lastVersion = null;
  lastSavings = null;
  safeStatusBarRemove("rtk");
  ctx = null;
}

export async function activate(context) {
  ctx = context;
  active = true;

  try {
    const stored = await ctx.storage.get("onboarding_shown");
    hasShownOnboarding = stored === true;
  } catch {
    hasShownOnboarding = false;
  }

  await refreshShowSavings();

  // Paint a "checking" state immediately so the user has visual feedback
  // before the first probe completes.
  safeStatusBarSet({
    id: "rtk",
    icon: "rtk.svg",
    tooltip: "RTK: checking installation…",
    tone: "default",
  });

  // Kick the first probes immediately, then poll on intervals. Stagger
  // gain by ~1s after version so the first gain only runs once we know
  // RTK is installed.
  await probeVersion();
  setTimeout(() => {
    if (active) void probeGain();
  }, 1_000);

  versionTimer = setInterval(() => {
    void probeVersion();
  }, VERSION_POLL_INTERVAL_MS);
  gainTimer = setInterval(() => {
    void probeGain();
  }, GAIN_POLL_INTERVAL_MS);
}

export async function deactivate() {
  await teardown();
}
