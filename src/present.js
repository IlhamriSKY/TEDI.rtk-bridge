// RTK Bridge — telling the user, and the agent, that RTK is on.
//
// The bridge used to be completely invisible. Asking TEDI's own AI "can you
// access rtk?" sent it grepping the repo, listing directories and reading two
// READMEs before it could answer, because nothing in its context said RTK was
// installed, active, or already rewriting its shell commands. Two surfaces fix
// that, and both are built from the same snapshot so they can never disagree:
//
//   - a status-bar item, so the user can see at a glance that commands are
//     being routed and which ones;
//   - an AI tool whose DESCRIPTION carries the fact. A contributed tool's
//     description is in the model's tool list on every turn, so the agent knows
//     RTK is handling this without calling anything; calling it just gets the
//     exact list.
//
// Pure apart from the two `ctx` calls at the bottom, so `describe` is testable
// on its own.

/** Text for both surfaces, from one snapshot. */
export function describe({ version, config, probeNarrowed, total }) {
  const routed = [...config.wrap].sort();
  const source = probeNarrowed
    ? `${routed.length} of ${total} known tools - the rest are not on PATH`
    : `${routed.length} tools - PATH could not be probed, so none were ruled out`;
  return {
    routed,
    source,
    label: String(routed.length),
    tooltip: config.enabled
      ? `RTK ${version} is routing ${routed.length} commands`
      : `RTK ${version} detected, but wrapping is off for this project`,
  };
}

/**
 * The description the model reads every turn. Written as a statement of fact
 * rather than an instruction, because it is answering the question the agent
 * would otherwise burn five tool calls on: is RTK here, and do I have to do
 * anything about it?
 */
export function aiToolDescription({ routed, prefix }) {
  const head = routed.slice(0, 12).join(", ");
  return [
    `RTK (Rust Token Killer) is ACTIVE in this TEDI. Shell commands you run whose`,
    `first word is one of ${routed.length} routed tools (${head}${routed.length > 12 ? ", …" : ""})`,
    `are automatically prefixed with \`${prefix}\` before they execute, which compresses`,
    `the output before it reaches you. Do NOT type \`${prefix}\` yourself - it is already`,
    `applied, and a command that already starts with it is left alone. Everything else,`,
    `including shell builtins and PowerShell cmdlets, runs exactly as you wrote it.`,
    `Call this tool to see the exact routed list and where the configuration came from.`,
  ].join(" ");
}

export const AI_TOOL_NAME = "rtk_status";
export const STATUS_ITEM_ID = "rtk";

/** Push the status-bar item. Safe to call repeatedly; the host keys on `id`. */
export function renderStatusItem(ctx, snapshot) {
  const { routed, source, label, tooltip } = describe(snapshot);
  try {
    ctx.statusBar.setItem({
      id: STATUS_ITEM_ID,
      icon: "lucide:Filter",
      kind: "status",
      tone: snapshot.config.enabled ? "success" : "default",
      label,
      tooltip,
      detail: {
        title: `RTK ${snapshot.version}`,
        rows: [
          { label: "Routed", value: label, note: source },
          { label: "Prefix", value: snapshot.config.command },
          {
            label: snapshot.config.enabled ? "AI shell commands" : "Wrapping",
            note: snapshot.config.enabled
              ? "routed through RTK automatically"
              : "off for this project (.tedi/rtk.json)",
          },
          { label: "", note: routed.join(" ") },
        ],
      },
    });
  } catch (err) {
    // `warn`, not `info`: `info` is dropped in release builds, so a swallowed
    // permission error here looks exactly like a badge that silently never
    // appears, with nothing in the console to say why.
    ctx.logger?.warn?.("status item could not be published", err);
  }
}

export function removeStatusItem(ctx) {
  try {
    ctx.statusBar.removeItem(STATUS_ITEM_ID);
  } catch {
    // Ungated, but the host may already have cleared it on deactivate.
  }
}
