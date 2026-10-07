// The workspace's QA log (`data/<workspaceId>/qa-log.md`): an append-only markdown file of check results (and,
// from the QA gate on, verdicts) that QA agents, the orchestrator and people read.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { getPipelineQaLogPath } from "../state/kanban-home";

export type AppendQaLog = (workspaceId: string, text: string) => Promise<void>;

export function createQaLogAppender(getPath: (workspaceId: string) => string = getPipelineQaLogPath): AppendQaLog {
	// One write chain per file keeps sections whole and in order.
	const chains = new Map<string, Promise<void>>();
	return async (workspaceId, text) => {
		const path = getPath(workspaceId);
		const next = (chains.get(path) ?? Promise.resolve()).then(async () => {
			await mkdir(dirname(path), { recursive: true });
			await appendFile(path, text, "utf8");
		});
		const settled = next.catch(() => {});
		chains.set(path, settled);
		try {
			await next;
		} finally {
			if (chains.get(path) === settled) {
				chains.delete(path);
			}
		}
	};
}
