// Upgrade existing installations without probing a provider whose persisted QA history already reports a quota hold.
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { getKanbanDataPath, getPipelineStatePath } from "../state/kanban-home";
import { pipelineWorkspaceStateSchema } from "./pipeline-state";
import { readQaAgentErrors } from "./qa-agent-error";
import { readQaGateEntry } from "./qa-gate";
import { USAGE_LIMIT_MARGIN_MS } from "./recovery-detect";

export async function readLegacyProviderUsageHolds(): Promise<Record<string, number>> {
	let entries: Dirent[];
	try {
		entries = await readdir(getKanbanDataPath(), { withFileTypes: true });
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	const holds: Record<string, number> = {};
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		let text: string;
		try {
			text = await readFile(getPipelineStatePath(entry.name), "utf8");
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			continue;
		} // Normal state recovery owns damaged legacy files.
		const parsed = pipelineWorkspaceStateSchema.safeParse(raw);
		if (!parsed.success) continue;
		const state = parsed.data;
		for (const card of Object.values(state.cards)) {
			for (const error of readQaAgentErrors(card)) {
				if (error.kind !== "usage_limit" || error.resetAt === undefined || !Number.isFinite(error.resetAt))
					continue;
				const qa = readQaGateEntry(state.cards[error.qaTaskId]);
				if (!qa) continue;
				const provider = qa.model?.provider ?? `agent:${qa.agentId}`;
				holds[provider] = Math.max(holds[provider] ?? 0, error.resetAt + USAGE_LIMIT_MARGIN_MS);
			}
		}
	}
	return holds;
}
