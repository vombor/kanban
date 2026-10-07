// ATTENTION.md (`data/<ws>/ATTENTION.md`): what needs a human or the orchestrator, rewritten by the watchdog every
// tick. The file format, the item lines and the orchestrator's own section are the legacy kit's: the orchestrator
// reads and edits this file, and its memory and prompts describe these lines.
//
// Ported from archive/devteam-kit:services/review-watch.mjs@6da71597 (finishTick, userItemIds, attentionList,
// handedOver) and kit main f859cb6 (planHeldIds).

/** The orchestrator's own section; the watchdog keeps it as it is (the orchestrator removes it itself). */
const ORCHESTRATOR_SECTION = /^## Orchestrator: needs the user[\s\S]*/mu;
const ORCHESTRATOR_SECTION_BODY = /^## Orchestrator: needs the user\n([\s\S]*?)(?=^## |(?![\s\S]))/mu;
const CARD_ID = /\*\*([0-9a-f]{5})\b/gu;
const PLAN_HELD_STEP = /^- \[(wait\b[^\]]*|watch|user)\]/u;
const PLAN_OPEN_STEP = /^- \[ \]/mu;
const PIPELINE_IDLE_ITEM = /^- \*\*pipeline idle\*\*: .*?: (.+)$/u;
const ESCALATED_ITEM = /^- \*\*([0-9a-f]{5})\*\* \(\w+\): escalated /u;

export const PID_PRESSURE_ITEM_MARKER = "**PID pressure**";
export const PIPELINE_IDLE_ITEM_MARKER = "**pipeline idle**";

/**
 * Card ids in open (not struck-through) bullets of "## Orchestrator: needs the user": the orchestrator handed them to
 * the human, so a stall on them doesn't wake it again (096bd 10/06: woken at 05:02Z for a card it had handed over).
 */
export function readUserItemIds(attentionText: string): Set<string> {
	const section = ORCHESTRATOR_SECTION_BODY.exec(attentionText)?.[1] ?? "";
	const ids = new Set<string>();
	for (const bullet of section.split(/^(?=- )/mu)) {
		if (/^- ~~/u.test(bullet)) {
			continue;
		}
		for (const match of bullet.matchAll(CARD_ID)) {
			ids.add(match[1] ?? "");
		}
	}
	ids.delete("");
	return ids;
}

/**
 * Card ids named in the orchestrator plan's held steps ("- [wait: …]", "- [watch]", "- [user]"): parked on purpose, so
 * they don't count for "pipeline idle" (4189a 10/07 01:23Z).
 */
export function readPlanHeldIds(planText: string): Set<string> {
	const ids = new Set<string>();
	for (const line of planText.split("\n")) {
		if (PLAN_HELD_STEP.test(line)) {
			for (const match of line.matchAll(/\b([0-9a-f]{5})\b/gu)) {
				ids.add(match[1] ?? "");
			}
		}
	}
	ids.delete("");
	return ids;
}

/** The plan has an open step ("- [ ] …") that waits for the board to go quiet. "- [user] …" steps never wake anyone. */
export function planHasOpenSteps(planText: string): boolean {
	return PLAN_OPEN_STEP.test(planText);
}

/** The newest "## TRIAGE <id>: <verdict> (" section's verdict in the QA log, or null. */
export function readTriageVerdict(qaLogText: string, taskId: string): string | null {
	const section = qaLogText
		.split(/^(?=## )/mu)
		.filter((entry) => entry.startsWith(`## TRIAGE ${taskId}:`))
		.at(-1);
	return section ? (/^## TRIAGE \w+: ([^(]+)/u.exec(section)?.[1]?.trim() ?? null) : null;
}

/**
 * An item the orchestrator already handed to the user: an escalation that is an open user item, or "pipeline idle"
 * when every waiting card is an open user item or held by the plan (c9e97 10/06; 03a5a/7b9ac/8fd60 10/06).
 */
export function isHandedOver(
	item: string,
	userItemIds: ReadonlySet<string>,
	planHeldIds: ReadonlySet<string>,
): boolean {
	const idle = PIPELINE_IDLE_ITEM.exec(item);
	if (idle) {
		return (idle[1] ?? "").split(", ").every((id) => userItemIds.has(id) || planHeldIds.has(id));
	}
	const escalated = ESCALATED_ITEM.exec(item);
	return Boolean(escalated && userItemIds.has(escalated[1] ?? ""));
}

/**
 * The next ATTENTION.md: this tick's items under "# Needs a human decision (<time>)", then the orchestrator's own
 * section as it was. Empty string = no file. `changed` ignores the timestamp, so an unchanged list is not rewritten
 * every tick.
 */
export function renderAttention(
	previous: string,
	items: readonly string[],
	now: Date,
): { text: string; changed: boolean } {
	const orchestrator = ORCHESTRATOR_SECTION.exec(previous)?.[0]?.trim() ?? "";
	const auto = items.length > 0 ? `# Needs a human decision (${now.toISOString()})\n\n${items.join("\n")}\n` : "";
	const text = [auto, orchestrator && `${orchestrator}\n`].filter(Boolean).join("\n");
	const strip = (value: string) => value.replace(/\(.*?Z\)/u, "");
	return { text, changed: strip(text) !== strip(previous) };
}
