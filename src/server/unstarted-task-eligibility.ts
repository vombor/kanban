import { lstat, readFile } from "node:fs/promises";
import {
	type RuntimeBoardData,
	type RuntimeTaskSessionSummary,
	runtimeTaskHistoryEntrySchema,
} from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { getTaskHistoryLogPath } from "../state/kanban-home";

/** Missing history is distinct from unreadable history; corrupted records cannot prove that a task never ran. */
export async function unstartedTaskEligibility(input: {
	workspaceId: string;
	board: RuntimeBoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	pipelineTaskIds: readonly string[];
	home?: string;
}) {
	let history: string[] = [];
	try {
		const path = getTaskHistoryLogPath(input.workspaceId, input.home),
			info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024)
			throw new Error("Unusable task history");
		history = (await readFile(path, "utf8"))
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => runtimeTaskHistoryEntrySchema.parse(JSON.parse(line)).taskId);
	} catch (error) {
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
			throw new Error("Task eligibility needs readable own task history; no historical task was adopted.");
	}
	const historical = new Set([...history, ...Object.keys(input.sessions), ...input.pipelineTaskIds]);
	return {
		known: new Set([...historical, ...input.board.columns.flatMap((column) => column.cards.map((card) => card.id))]),
		unstarted: new Set(
			input.board.columns
				.filter((column) => column.id === "backlog")
				.flatMap((column) =>
					column.cards
						.filter((card) => resolveCardRole(card) === "dev" && !historical.has(card.id))
						.map((card) => card.id),
				),
		),
	};
}
