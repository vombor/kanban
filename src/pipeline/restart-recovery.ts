// Restart recovery: which cards a Kanban (or container) restart left without a running agent, and the restart
// manifest `kanban restart prepare` writes before a planned restart.
//
// After a restart Kanban still shows those cards In Progress or Review with a "running" summary, but their PTY died
// with the old server, so a nudge goes nowhere and the stop checks would read the silence as agent failure: false
// escalations, false FAIL rounds, QA of a half-done snapshot (096bd/8e891/c9e97, 10/06). The server knows when it
// started, so there is no /proc scan: a session that started before this server and has no process now is an
// orphan, unless its turn had already ended (finished work waits for QA as usual).
//
// Ported from archive/devteam-kit:lib/restart-recovery.mjs@6da71597 (planRecovery, manifest, recover-now lines) and
// archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (checkRestart, recoverOrphans): orphans are marked so
// nothing penalizes them, dev cards are resumed one at a time on the same model, QA cards are recreated for the same
// snapshot (by the QA gate, P4-3), calibration cards are left to their runner. 1a7a32a: a Cline CLI session idle after
// a final reply is finished work, not an orphan (cline 3.x never marks a session completed).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import type { RuntimeBoardCard, RuntimeTaskRole } from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRestartManifestPath, getRestartRecoverRequestPath, getServerStartRecordPath } from "../state/kanban-home";
import type { PipelineSessionView } from "./engine";

const restartManifestCardSchema = z
	.object({
		id: z.string(),
		column: z.string(),
		model: z.string().nullable().optional(),
		wipTag: z.string().nullable().optional(),
		kind: z.string().optional(),
	})
	.passthrough();

export const restartManifestSchema = z
	.object({
		at: z.string(),
		kanbanStart: z.string().nullable().optional(),
		cards: z.array(restartManifestCardSchema),
	})
	.passthrough();
export type RestartManifest = z.infer<typeof restartManifestSchema>;
export type RestartManifestCard = z.infer<typeof restartManifestCardSchema>;

export interface RestartOrphan {
	taskId: string;
	role: RuntimeTaskRole;
	column: "in_progress" | "review";
	reason: string;
	/** From the manifest: the WIP tag `kanban restart prepare` made for this restart. */
	wipTag: string | null;
}

export interface RestartRecoveryPlan {
	serverStartedAt: number;
	/** The manifest's time, when one older than this server start was used. */
	manifestAt: string | null;
	orphans: RestartOrphan[];
	skipped: Array<{ taskId: string; why: string }>;
}

export interface PlanRestartRecoveryInput {
	cards: Array<{ card: RuntimeBoardCard; column: string }>;
	sessions: ReadonlyMap<string, PipelineSessionView>;
	serverStartedAt: number;
	/** The start of the server before this one, or null when unknown (no start record). */
	previousServerStartedAt: number | null;
	manifest: RestartManifest | null;
	/** Whether the card's (effective) agent's turn had ended before the restart, read from its session files. */
	turnEnded: (card: RuntimeBoardCard) => boolean;
}

const BLOCKED_TITLE = /^BLOCKED: /;

/** How old a manifest whose writer has no start record in this home (a home move) may be when this server starts. */
export const MANIFEST_FROM_OTHER_HOME_MAX_AGE_MS = 24 * 3_600_000;

/**
 * A manifest is for the very next server start only: written before `serverStartedAt` by the server that ran just
 * before this one. Normally that server's start (`kanbanStart`) equals `previousServerStartedAt`, from the start
 * record this server replaced. After a home move the writer's start record stayed in the old home (`run/` is not
 * part of the move), so this home has no record (null) or only one older than the writer: no server started on this
 * home after the writer, and the manifest counts if it is recent (MANIFEST_FROM_OTHER_HOME_MAX_AGE_MS; a home move
 * happens in a restart window). Anything else is stale (a manifest no start used, from weeks ago, one written without
 * a known server, or one a later server on this home already had) and is never replayed; recovery deletes it.
 */
export function isManifestForStart(
	manifest: RestartManifest | null,
	serverStartedAt: number,
	previousServerStartedAt: number | null,
): manifest is RestartManifest {
	if (!manifest?.kanbanStart) {
		return false;
	}
	const at = Date.parse(manifest.at);
	const writerStartedAt = Date.parse(manifest.kanbanStart);
	if (!(at < serverStartedAt) || !(writerStartedAt <= at)) {
		return false;
	}
	if (previousServerStartedAt === writerStartedAt) {
		return true;
	}
	const writerFromOtherHome = previousServerStartedAt === null || previousServerStartedAt < writerStartedAt;
	return writerFromOtherHome && serverStartedAt - at <= MANIFEST_FROM_OTHER_HOME_MAX_AGE_MS;
}
const ORPHAN_STATES = new Set(["running", "interrupted"]);

export function planRestartRecovery(input: PlanRestartRecoveryInput): RestartRecoveryPlan {
	const { serverStartedAt } = input;
	const manifestUsable = isManifestForStart(input.manifest, serverStartedAt, input.previousServerStartedAt)
		? input.manifest
		: null;
	const manifestCards = new Map((manifestUsable?.cards ?? []).map((entry) => [entry.id, entry]));
	const plan: RestartRecoveryPlan = {
		serverStartedAt,
		manifestAt: manifestUsable?.at ?? null,
		orphans: [],
		skipped: [],
	};
	for (const { card, column } of input.cards) {
		if (column !== "in_progress" && column !== "review") {
			continue;
		}
		const role = resolveCardRole(card);
		const listed = manifestCards.get(card.id);
		const session = input.sessions.get(card.id) ?? null;
		if (BLOCKED_TITLE.test(card.title ?? "")) {
			plan.skipped.push({ taskId: card.id, why: "BLOCKED (escalated)" });
			continue;
		}
		if (role === "calibration" || role === "triage") {
			plan.skipped.push({ taskId: card.id, why: `role ${role}: left to its own runner` });
			continue;
		}
		if (session?.live) {
			continue; // it has a process in this server
		}
		if (session?.startedAt && session.startedAt >= serverStartedAt) {
			continue; // started by this server and ended normally
		}
		const orphan = (reason: string) =>
			plan.orphans.push({ taskId: card.id, role, column, reason, wipTag: listed?.wipTag ?? null });
		// A listed card whose session started after the manifest was written has been resumed since.
		if (listed && !(session?.startedAt && session.startedAt > Date.parse(manifestUsable?.at ?? ""))) {
			orphan(`in the restart manifest of ${manifestUsable?.at}`);
			continue;
		}
		if (!session) {
			// Summaries reach sessions.json only with a board save that carries them (the browser's), so an In Progress
			// card can have none on disk (277f8, 10/07). In Progress without a process is an agent stopped mid-work.
			if (column === "in_progress") {
				orphan("In Progress with no session summary and no process now");
			} else {
				plan.skipped.push({ taskId: card.id, why: "no session summary" });
			}
			continue;
		}
		if (!ORPHAN_STATES.has(session.state)) {
			plan.skipped.push({ taskId: card.id, why: `session ${session.state} before the restart: finished work` });
			continue;
		}
		if (input.turnEnded(card)) {
			plan.skipped.push({ taskId: card.id, why: "its turn had ended before the restart: finished work" });
			continue;
		}
		const started = session.startedAt ? new Date(session.startedAt).toISOString() : "?";
		orphan(
			`session ${session.state} since ${started}, before Kanban started (${new Date(serverStartedAt).toISOString()}); no process now`,
		);
	}
	return plan;
}

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

const serverStartRecordSchema = z.object({ pid: z.number(), startedAt: z.number() }).passthrough();

/** The running server records when it started, so `kanban restart prepare` can put it in the manifest. */
export async function writeServerStartRecord(record: { pid: number; startedAt: number }): Promise<void> {
	const path = getServerStartRecordPath();
	await mkdir(dirname(path), { recursive: true });
	await lockedFileSystem.writeJsonFileAtomic(path, record);
}

/** The start record as the last server left it (read by a starting server before it writes its own), or null. */
export async function readServerStartRecord(): Promise<{ pid: number; startedAt: number } | null> {
	const parsed = serverStartRecordSchema.safeParse(await readJson(getServerStartRecordPath()));
	return parsed.success ? { pid: parsed.data.pid, startedAt: parsed.data.startedAt } : null;
}

/** The start time of the server that wrote the record, if that process is still running; else null. */
export async function readRunningServerStart(isAlive: (pid: number) => boolean): Promise<number | null> {
	const parsed = serverStartRecordSchema.safeParse(await readJson(getServerStartRecordPath()));
	return parsed.success && isAlive(parsed.data.pid) ? parsed.data.startedAt : null;
}

/** The workspace's restart manifest, or null when there is none (or it doesn't parse). */
export async function readRestartManifest(workspaceId: string): Promise<RestartManifest | null> {
	const parsed = restartManifestSchema.safeParse(await readJson(getRestartManifestPath(workspaceId)));
	return parsed.success ? parsed.data : null;
}

export async function writeRestartManifest(workspaceId: string, manifest: RestartManifest): Promise<string> {
	const path = getRestartManifestPath(workspaceId);
	await mkdir(dirname(path), { recursive: true });
	await lockedFileSystem.writeJsonFileAtomic(path, manifest);
	return path;
}

export async function removeRestartManifest(workspaceId: string): Promise<void> {
	await rm(getRestartManifestPath(workspaceId), { force: true });
}

// One "<iso> <workspaceId>" line per `kanban restart recover` request; a line without a workspace asks for all.
function requestLineWorkspace(line: string): string | null {
	return line.trim().split(/\s+/)[1] ?? null;
}

async function readRequestLines(path: string): Promise<string[] | null> {
	try {
		return (await readFile(path, "utf8")).split("\n").filter((line) => line.trim());
	} catch {
		return null;
	}
}

/** Asks the pipeline worker to check `workspaceId` (or every workspace, null) for orphans on its next evaluation. */
export async function requestRestartRecovery(workspaceId: string | null, now: Date = new Date()): Promise<string> {
	const path = getRestartRecoverRequestPath();
	await mkdir(dirname(path), { recursive: true });
	await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const lines = (await readRequestLines(path)) ?? [];
		lines.push(`${now.toISOString()}${workspaceId ? ` ${workspaceId}` : ""}`);
		await writeFile(path, `${lines.join("\n")}\n`, "utf8");
	});
	return path;
}

/** True when a check of `workspaceId` was asked for; drops that workspace's lines (and the file once empty). */
export async function consumeRestartRecoveryRequest(workspaceId: string): Promise<boolean> {
	const path = getRestartRecoverRequestPath();
	if ((await readRequestLines(path)) === null) {
		return false;
	}
	return await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const lines = await readRequestLines(path);
		if (!lines) {
			return false;
		}
		const asked = lines.some((line) => {
			const target = requestLineWorkspace(line);
			return target === null || target === workspaceId;
		});
		if (!asked) {
			return false;
		}
		// As in the legacy kit, a line without a workspace is dropped by the first workspace that sees it, so
		// `kanban restart recover` without --workspace writes one line per workspace.
		const left = lines.filter((line) => {
			const target = requestLineWorkspace(line);
			return target !== null && target !== workspaceId;
		});
		if (left.length > 0) {
			await writeFile(path, `${left.join("\n")}\n`, "utf8");
		} else {
			await rm(path, { force: true });
		}
		return true;
	});
}
