// The "Kanban restarted" wake: once per server start, every workspace that has an orchestrator gets one wake item
// that says when Kanban started, whether the previous server stopped cleanly, and what restart recovery did for that
// workspace, so nobody has to type "pod restarted" into each sidebar after a pod restart.
//
// The facts are the ones recovery already wrote, never re-derived here: the restart manifest it planned with (the
// previous server's `shutdown` write at a clean stop, a `kanban restart prepare` one before a planned restart, only a
// `periodic` one or none after a crash) and its `restart` records in the workspace's pipeline-decisions.jsonl. Which
// cards lost their agent is restart recovery's (lostToRestart); this module only reports its outcomes. The watchdog
// (watchdog.ts) decides when the item is due (after recovery's pass, or `watchdog.stall.restartGraceMin` at the
// latest), routes it like every other wake item, and records it as sent per workspace and server start
// (`restartWake` in watchdog-state.json), so a worker restart within the same server start sends nothing again.
import { readFile } from "node:fs/promises";

import { type ContainerImageBuild, describeImageBuild, isSameImageBuild } from "../../update/container-image";
import type { PipelineDecisionRecord } from "../decision-log";
import { isManifestForStart, type RestartManifest, type RestartManifestUpdate } from "../restart-recovery";

/** Every restart wake item carries it, so the watchdog can tell whether a wake delivered it. */
export const RESTART_WAKE_ITEM_MARKER = "Kanban restarted";

/** With the workspace's wakes off the item is listed in its ATTENTION.md for this long after the start was seen. */
export const RESTART_WAKE_ATTENTION_KEEP_MS = 24 * 60 * 60_000;

/** How the server before this one stopped, as its restart manifest tells. */
export interface RestartStop {
	/** clean: its shutdown write; planned: `kanban restart prepare`; unclean: no stop record (a crash, an OOM kill). */
	kind: "clean" | "planned" | "unclean";
	/** The manifest's time: the stop (clean/planned), or the last periodic write before an unclean stop. */
	at: string | null;
	/** A planned stop by `kanban restart update`: the build it ran and the `:latest` it asked for. */
	update?: RestartManifestUpdate | null;
}

/** The previous stop, from the manifest found at this start (only one written for this start counts). */
export function describePreviousStop(
	manifest: RestartManifest | null,
	serverStartedAt: number,
	previousServerStartedAt: number | null,
): RestartStop {
	if (!isManifestForStart(manifest, serverStartedAt, previousServerStartedAt)) {
		return { kind: "unclean", at: null };
	}
	if (manifest.source === "shutdown") {
		return { kind: "clean", at: manifest.at };
	}
	if (manifest.source === "periodic") {
		return { kind: "unclean", at: manifest.at };
	}
	return { kind: "planned", at: manifest.at, ...(manifest.update ? { update: manifest.update } : {}) };
}

/** What restart recovery did for one workspace's cards, from its `restart` records of this server start. */
export interface RestartRecoverySummary {
	orphans: number;
	resumed: string[];
	/** Orphans recovery tried to resume and didn't (capacity, a failed start), with its note. */
	notResumed: Array<{ taskId: string; note: string }>;
	/** Orphans whose resume has not happened yet (queued, or waiting for PID pressure). */
	pending: string[];
	/** Dead QA cards handed to the QA gate, which supersedes them and queues a new QA card. */
	qaReplaced: string[];
	/** What recovery would have done where it only reports (`pipeline.recovery.mode: report`, shadow). */
	reportOnly: string[];
}

function isRestartRecord(value: unknown): value is PipelineDecisionRecord {
	return Boolean(
		value &&
			typeof value === "object" &&
			(value as { stage?: unknown }).stage === "restart" &&
			typeof (value as { at?: unknown }).at === "string" &&
			typeof (value as { note?: unknown }).note === "string",
	);
}

/** The workspace's `restart` records written since this server started (a missing or partly bad log reads as less). */
export async function readRestartRecords(path: string, serverStartedAt: number): Promise<PipelineDecisionRecord[]> {
	const text = await readFile(path, "utf8").catch(() => "");
	const records: PipelineDecisionRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.includes('"restart"')) {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRestartRecord(parsed) && Date.parse(parsed.at) >= serverStartedAt) {
				records.push(parsed);
			}
		} catch {
			// a torn line
		}
	}
	return records;
}

function answerKind(record: PipelineDecisionRecord): string | null {
	const answer = record.answer as { kind?: unknown } | null;
	return answer && typeof answer.kind === "string" ? answer.kind : null;
}

/**
 * Each card's last restart record decides (recovery-stage.ts): the plan's "orphaned (…)" record, then the resume's
 * own record ("resumed on …", a failure, or `none` when it was no longer needed or waits for PID pressure).
 */
export function summarizeRestartRecords(records: readonly PipelineDecisionRecord[]): RestartRecoverySummary {
	const summary: RestartRecoverySummary = {
		orphans: 0,
		resumed: [],
		notResumed: [],
		pending: [],
		qaReplaced: [],
		reportOnly: [],
	};
	const last = new Map<string, PipelineDecisionRecord>();
	const orphans = new Set<string>();
	for (const record of records) {
		if (!record.taskId) {
			continue;
		}
		if (record.note.startsWith("orphaned")) {
			orphans.add(record.taskId);
		}
		last.set(record.taskId, record);
	}
	summary.orphans = orphans.size;
	for (const [taskId, record] of last) {
		const kind = answerKind(record);
		if (record.outcome === "report" || record.outcome === "shadow") {
			summary.reportOnly.push(`${kind === "recreate_qa" ? "replace QA card" : "resume"} ${taskId}`);
		} else if (kind === "recreate_qa") {
			if (record.outcome === "acted") {
				summary.qaReplaced.push(taskId);
			}
		} else if (record.outcome === "failed") {
			summary.notResumed.push({ taskId, note: record.note });
		} else if (record.outcome === "acted") {
			(record.note.startsWith("orphaned") ? summary.pending : summary.resumed).push(taskId);
		} else if (record.note.startsWith("PID pressure")) {
			summary.pending.push(taskId);
		}
	}
	return summary;
}

/** Where the restart wake goes, for the line about the orchestrator's own conversation. */
export type RestartWakeSession =
	/** A headless run (a running one's queue, or a new run): never the sidebar's conversation. */
	| "headless"
	/**
	 * A live sidebar session the watchdog didn't start for the wake (the browser's or the user's start, for one).
	 * Kanban can't tell whether it continued the earlier conversation (issue #38: a browser-started Claude sidebar
	 * did), so the wake says nothing about its memory.
	 */
	| "unknown_live"
	/** A live sidebar session that continues the conversation from before the restart. */
	| "continued_live"
	/** The sidebar is started for the wake and continues its earlier conversation (agentContinuesConversationOnResume). */
	| "start_continued"
	/** The sidebar is started for the wake as a fresh conversation. */
	| "start_fresh";

export interface RestartWakeItemInput {
	serverStartedAt: number;
	stop: RestartStop;
	/** This server's image build (the image's env), null when unknown; read for an update restart. */
	runningBuild?: ContainerImageBuild | null;
	/** Why restart recovery doesn't run for the workspace, or null when it does. */
	recoveryNotRunning: string | null;
	/** Recovery's pass has run in this worker life (its records are then complete, or still coming for resumes). */
	passRan: boolean;
	summary: RestartRecoverySummary;
	/** Null with the workspace's wakes off (the item goes to ATTENTION.md). */
	session: RestartWakeSession | null;
}

/** "2026-10-11 17:14:05Z": no ISO "T", so wakeKey() keeps it and each start's item has its own cooldown key. */
function formatTime(at: number | string): string {
	return new Date(at).toISOString().replace("T", " ").slice(0, 19).concat("Z");
}

/**
 * An update restart's line: "updated from <old> to <new>" by the build this server runs, or, when it still runs the old
 * build, that the container came back without pulling (the unit's Pull=newer is the only thing that pulls).
 */
function formatUpdate(
	update: RestartManifestUpdate,
	at: string | null,
	runningBuild: ContainerImageBuild | null,
): string {
	const when = `kanban restart update at ${formatTime(at ?? 0)}`;
	const from = describeImageBuild(update.from);
	if (runningBuild && update.from && isSameImageBuild(runningBuild, update.from)) {
		return `the restart was an update (${when}), but this server still runs ${from}: the container started without the newer image (${describeImageBuild(update.to)}), so check the Quadlet unit's Pull=newer`;
	}
	const to = runningBuild
		? describeImageBuild(runningBuild)
		: `${describeImageBuild(update.to)} (the registry's :latest then)`;
	return `the restart was an update (${when}): updated from ${from} to ${to}`;
}

function formatStop(stop: RestartStop, runningBuild: ContainerImageBuild | null): string {
	switch (stop.kind) {
		case "clean":
			return `the previous server stopped cleanly (shutdown at ${formatTime(stop.at ?? 0)})`;
		case "planned":
			if (stop.update) {
				return formatUpdate(stop.update, stop.at, runningBuild);
			}
			return `the restart was planned (kanban restart prepare at ${formatTime(stop.at ?? 0)})`;
		case "unclean":
			return `the previous server did not stop cleanly (no shutdown record${stop.at ? `; its last restart manifest is of ${formatTime(stop.at)}` : ""})`;
	}
}

function shorten(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatRecovery(input: RestartWakeItemInput): string {
	if (input.recoveryNotRunning) {
		return `restart recovery doesn't run for this workspace (${input.recoveryNotRunning}), so check its In Progress and Review cards yourself`;
	}
	if (!input.passRan) {
		return "restart recovery has not reported for this workspace yet";
	}
	const { summary } = input;
	const parts: string[] = [];
	if (summary.resumed.length > 0) {
		parts.push(`resumed ${summary.resumed.join(", ")}`);
	}
	if (summary.notResumed.length > 0) {
		parts.push(
			`NOT resumed: ${summary.notResumed.map((entry) => `${entry.taskId} (${shorten(entry.note, 120)})`).join("; ")}`,
		);
	}
	if (summary.pending.length > 0) {
		parts.push(`still resuming ${summary.pending.join(", ")}`);
	}
	if (summary.qaReplaced.length > 0) {
		parts.push(`dead QA card(s) ${summary.qaReplaced.join(", ")} handed to the QA gate for a new QA card`);
	}
	if (summary.reportOnly.length > 0) {
		parts.push(`recovery only reports here, nothing was done; it would ${summary.reportOnly.join(", ")}`);
	}
	if (parts.length === 0) {
		return "restart recovery found no card that lost its agent";
	}
	return `restart recovery: ${summary.orphans} card(s) lost their agent; ${parts.join("; ")}`;
}

function formatSession(session: RestartWakeSession | null): string | null {
	switch (session) {
		case "headless":
			return "this is a headless run, without the sidebar's conversation";
		case "start_fresh":
			return "this orchestrator session is fresh: it has no memory of the conversation before the restart";
		case "continued_live":
		case "start_continued":
			return "this session continues your conversation from before the restart";
		case "unknown_live":
		case null:
			return null;
	}
}

/** One line, like the other wake items. */
export function buildRestartWakeItem(input: RestartWakeItemInput): string {
	const session = formatSession(input.session);
	return `- ${RESTART_WAKE_ITEM_MARKER} at ${formatTime(input.serverStartedAt)}; ${formatStop(input.stop, input.runningBuild ?? null)}; ${formatRecovery(input)}${session ? `; ${session}` : ""}. Check the board, finish the recovery that didn't happen automatically (kanban task resume <id>), and tell the user what the restart did`;
}

export function isRestartWakeItem(item: string): boolean {
	return item.includes(RESTART_WAKE_ITEM_MARKER);
}
