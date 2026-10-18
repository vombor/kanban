import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { renameDurably, writeFileSynced } from "../fs/durable-file";
import { lockedFileSystem } from "../fs/locked-file-system";
import { readKnowledgeFile } from "../knowledge/content-store";
import { getIntegrationReportPaths } from "../state/kanban-home";
import { type IntegrationReport, integrationReportSchema } from "../trpc/integration-contract";

const schema = z.object({ version: z.literal(1), reports: z.array(integrationReportSchema).max(100) }).strict();
export function createIntegrationReportStore(homePath?: string) {
	const path = (workspaceId: string) => getIntegrationReportPaths(workspaceId, homePath).manifest;
	const read = async (workspaceId: string) => {
		let text: string;
		try {
			text = await readKnowledgeFile(path(workspaceId), 4194304);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
				return schema.parse({ version: 1, reports: [] });
			throw new Error("Retained integration reports unavailable; not reset");
		}
		return schema.parse(JSON.parse(text));
	};
	return {
		read,
		update: async (workspaceId: string, operation: (reports: IntegrationReport[]) => IntegrationReport[]) =>
			lockedFileSystem.withLock({ path: path(workspaceId) }, async () => {
				const state = await read(workspaceId),
					next = schema.parse({ version: 1, reports: operation(state.reports) }),
					text = JSON.stringify(next);
				if (Buffer.byteLength(text) > 4194304) throw new Error("Integration retention ceiling; no history evicted");
				await mkdir(dirname(path(workspaceId)), { recursive: true, mode: 0o700 });
				const tmp = `${path(workspaceId)}.${randomUUID()}.tmp`;
				try {
					await writeFileSynced(tmp, text, { mode: 0o600, flag: "wx" });
					await renameDurably(tmp, path(workspaceId));
				} finally {
					await rm(tmp, { force: true });
				}
				return next;
			}),
	};
}
