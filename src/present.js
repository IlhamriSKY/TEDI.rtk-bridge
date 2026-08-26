// RTK Bridge — telling the agent that RTK is on.
//
// The bridge used to be completely invisible. Asking TEDI's own AI "can you
// access rtk?" sent it grepping the repo, listing directories and reading two
// READMEs before it could answer, because nothing in its context said RTK was
// installed, active, or already rewriting its shell commands.
//
// What fixes that is an AI tool whose DESCRIPTION carries the fact. A
// contributed tool's description sits in the model's tool list on every turn,
// so the agent knows RTK is handling this without calling anything; calling it
// just gets the exact list.
//
// There was a status-bar badge saying the same thing to the user. It is gone as
// of 0.4.4: the bar is scarce and shared with every other extension, and a
// count that only changes when the project's config changes does not earn a
// permanent seat there. Nothing else about the bridge changed - commands are
// still routed, and `rtk_status` still answers.
//
// Pure: no `ctx` calls at all, so `describe` is testable on its own.

/** Text for the AI surface, from one snapshot. */
export function describe({ config, probeNarrowed, total }) {
  const routed = [...config.wrap].sort();
  return {
    routed,
    // `19 / 47` reads as one fact rather than a number plus a qualifier.
    count: `${routed.length} / ${total}`,
    scope: probeNarrowed ? "found on PATH" : "PATH not probed",
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
