// The pipeline's decision log: one JSON line per decision in `data/<workspaceId>/pipeline-decisions.jsonl`.
//
// Every routing answer the pipeline gets from a kit is written here with what it was asked about (the card's
// effective agent and where it came from, the role, the model), the kit and landing mode in force, whether the
// workspace is in shadow, and what the pipeline did with it. In shadow (`workspaces.<id>.pipeline.shadow`) this
// log is the only output: the cutover diff (P5-1) compares it with what the legacy kit did. Ported from
// archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (AUTOLAND_DRY_RUN: decide, log "[dry-run]", act on
// nothing), as data instead of log text.
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { LandingMode } from "../config/pipeline-config";
import type { RuntimeAgentId, RuntimeTaskRole } from "../core/api-contract";
import type { EffectiveAgentSource, EffectiveModel } from "../core/effective-agent";
import { getPipelineDecisionLogPath } from "../state/kanban-home";

/** Rotated to `<log>.1` past this size, so a long shadow period can't fill the disk. */
const DECISION_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * `land`: the Done workflow's landing step (src/server/task-landing-gate.ts), written by the server. `qa_gate`: the
 * kit's QA answer for a dev card; `qa_start` / `qa_ingest` / `qa_pass`: the QA gate starting and ingesting QA cards and acting on a PASS.
 */
export type PipelineStage =
	| "worker"
	| "snapshot"
	| "checks"
	| "qa_gate"
	| "qa_start"
	| "qa_ingest"
	| "qa_pass"
	| "land";

/**
 * What the pipeline did with a decision. `none`: nothing to do. `shadow`: it would act, but the workspace is in
 * shadow. `not_implemented`: it would act, but that stage isn't built yet (the pipeline skeleton only decides).
 */
export type PipelineDecisionOutcome = "none" | "shadow" | "not_implemented" | "acted";

export interface PipelineDecisionRecord {
	at: string;
	workspaceId: string;
	taskId: string | null;
	stage: PipelineStage;
	kit: string;
	landingMode: LandingMode;
	shadow: boolean;
	effectiveAgent: { agentId: RuntimeAgentId; source: EffectiveAgentSource } | null;
	model: EffectiveModel | null;
	role: RuntimeTaskRole | null;
	/** The kit's answer (a RoutingPolicy return value), or null for records that aren't kit answers. */
	answer: unknown;
	outcome: PipelineDecisionOutcome;
	note: string;
}

export interface PipelineDecisionLog {
	append: (records: readonly PipelineDecisionRecord[]) => Promise<void>;
}

export interface CreatePipelineDecisionLogOptions {
	getLogPath?: (workspaceId: string) => string;
	maxBytes?: number;
}

/** Appends JSON lines to one file per workspace, in order, rotating a file to `<log>.1` past `maxBytes`. */
export interface WorkspaceJsonLinesLog<T extends { workspaceId: string }> {
	append: (records: readonly T[]) => Promise<void>;
}

export function createWorkspaceJsonLinesLog<T extends { workspaceId: string }>(options: {
	getLogPath: (workspaceId: string) => string;
	maxBytes?: number;
}): WorkspaceJsonLinesLog<T> {
	const { getLogPath } = options;
	const maxBytes = options.maxBytes ?? DECISION_LOG_MAX_BYTES;
	// One write chain per file keeps the lines in decision order.
	const chains = new Map<string, Promise<void>>();

	const write = async (path: string, text: string): Promise<void> => {
		await mkdir(dirname(path), { recursive: true });
		const size = await stat(path).then(
			(stats) => stats.size,
			() => 0,
		);
		if (size > 0 && size + text.length > maxBytes) {
			await rename(path, `${path}.1`);
		}
		await appendFile(path, text, "utf8");
	};

	return {
		append: async (records) => {
			const byPath = new Map<string, string>();
			for (const record of records) {
				const path = getLogPath(record.workspaceId);
				byPath.set(path, `${byPath.get(path) ?? ""}${JSON.stringify(record)}\n`);
			}
			await Promise.all(
				[...byPath].map(async ([path, text]) => {
					const next = (chains.get(path) ?? Promise.resolve()).then(() => write(path, text));
					const settled = next.catch(() => {});
					chains.set(path, settled);
					try {
						await next;
					} finally {
						if (chains.get(path) === settled) {
							chains.delete(path);
						}
					}
				}),
			);
		},
	};
}

export function createPipelineDecisionLog(options: CreatePipelineDecisionLogOptions = {}): PipelineDecisionLog {
	return createWorkspaceJsonLinesLog<PipelineDecisionRecord>({
		getLogPath: options.getLogPath ?? ((workspaceId: string) => getPipelineDecisionLogPath(workspaceId)),
		maxBytes: options.maxBytes,
	});
}
