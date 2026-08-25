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

/**
 * The popover renderer is unforgiving about width and the first draft ignored
 * it: `label` gets a fixed `w-14` column, and `value` and `note` are both
 * `shrink-0` on a `leading-none` row. So a label longer than about eight
 * characters wraps onto two lines, and a long note does not wrap at all - it
 * runs straight off the edge and is clipped. The 47-name routed list did
 * exactly that.
 *
 * Hence: short labels, the count as a single `19 / 47` value instead of a
 * number plus a note repeating it, and a length-budgeted preview of the list
 * rather than the whole thing. The full list stays available through the
 * `rtk_status` tool, which has no width to respect.
 */
const PREVIEW_BUDGET = 44;

/** As many names as fit in `PREVIEW_BUDGET`, then `+N`. Never returns a string
 *  that would overflow the row, however many tools are routed. */
export function previewList(routed, budget = PREVIEW_BUDGET) {
  const shown = [];
  let width = 0;
  for (const name of routed) {
    const next = width + name.length + (shown.length ? 1 : 0);
    // Leave room for the "+N" that will follow if anything is left over.
    if (next > budget - 5 && shown.length) break;
    shown.push(name);
    width = next;
  }
  const rest = routed.length - shown.length;
  return rest > 0 ? `${shown.join(" ")} +${rest}` : shown.join(" ");
}

/** Text for both surfaces, from one snapshot. */
export function describe({ version, config, probeNarrowed, total }) {
  const routed = [...config.wrap].sort();
  return {
    routed,
    // `19 / 47` reads as one fact. The old row put `19` in the value and then
    // "19 of 38 known tools…" in the note, printing the same number twice.
    count: `${routed.length} / ${total}`,
    scope: probeNarrowed ? "found on PATH" : "PATH not probed",
    preview: previewList(routed),
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
  const { count, scope, preview, label, tooltip } = describe(snapshot);
  const on = snapshot.config.enabled;
  try {
    ctx.statusBar.setItem({
      id: STATUS_ITEM_ID,
      icon: "lucide:Filter",
      kind: "status",
      tone: on ? "success" : "default",
      label,
      tooltip,
      detail: {
        title: `RTK ${snapshot.version}`,
        // Every label here is <= 7 characters so it fits the fixed `w-14`
        // column on one line, and every note is short enough not to be clipped.
        rows: on
          ? [
              { label: "Routed", value: count, note: scope },
              { label: "Prefix", value: snapshot.config.command },
              { label: "Applies", note: "automatically, to AI commands" },
              { label: "", note: preview },
            ]
          : [
              { label: "Routed", value: `0 / ${count.split(" / ")[1]}` },
              { label: "Off", note: "disabled in .tedi/rtk.json" },
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
