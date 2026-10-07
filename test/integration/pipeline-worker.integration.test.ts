// The pipeline worker as a real child process: the host forks `src/cli.ts pipeline worker` (under the tsx loader),
// the worker reads config.json from the same Kanban home, evaluates a snapshot, writes its decision log and state
// file, and exits when the host closes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
	createPipelineWorkerHost,
	forkPipelineWorkerProcess,
	type PipelineWorkerChild,
} from "../../src/pipeline/worker-host";
import type { PipelineWorkerMessage } from "../../src/pipeline/worker-protocol";
import {
	getKanbanGlobalConfigPath,
	getPipelineDecisionLogPath,
	getPipelineStatePath,
} from "../../src/state/kanban-home";
import { withTemporaryKanbanHome } from "../utilities/kanban-home";
import { createSnapshot } from "../utilities/pipeline-worker";
import { createBoard, createCard } from "../utilities/workspace-state-store";

const requireFromHere = createRequire(import.meta.url);

function waitFor<T>(predicate: () => T | undefined, timeoutMs: number): Promise<T> {
	return new Promise((resolvePromise, reject) => {
		const startedAt = Date.now();
		const timer = setInterval(() => {
			const value = predicate();
			if (value !== undefined) {
				clearInterval(timer);
				resolvePromise(value);
			} else if (Date.now() - startedAt > timeoutMs) {
				clearInterval(timer);
				reject(new Error("timed out"));
			}
		}, 50);
	});
}

describe("pipeline worker process", () => {
	it("runs as a child of the host, logs its decisions and exits when the host closes", async () => {
		await withTemporaryKanbanHome(async () => {
			const configPath = getKanbanGlobalConfigPath();
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(
				configPath,
				JSON.stringify({ workspaces: { foo: { landing: { mode: "qa" }, pipeline: { shadow: true } } } }),
			);
			const messages: PipelineWorkerMessage[] = [];
			const logs: string[] = [];
			let child: PipelineWorkerChild | null = null;
			let exitCode: number | null | undefined;
			const host = createPipelineWorkerHost({
				listWorkspaces: () => [{ workspaceId: "foo", workspacePath: "/nonexistent/foo" }],
				buildSnapshot: async (workspaceId) =>
					createSnapshot({
						workspaceId,
						// No worktree behind it, so no card has work: only the "watching" record is written.
						board: createBoard({ review: [createCard({ id: "dev-1" })] }),
						selectedAgentId: "claude",
					}),
				spawnWorker: () => {
					const tsx = pathToFileURL(requireFromHere.resolve("tsx")).href;
					child = forkPipelineWorkerProcess(resolve(process.cwd(), "src/cli.ts"), ["--import", tsx]);
					child.onExit((code) => {
						exitCode = code;
					});
					return child;
				},
				onWorkerMessage: (message) => messages.push(message),
				log: (message) => logs.push(message),
			});
			try {
				host.start();
				await waitFor(
					() => messages.find((message) => message.type === "evaluated" && message.workspaceId === "foo"),
					30_000,
				);

				const decisionLog = readFileSync(getPipelineDecisionLogPath("foo"), "utf8").trim().split("\n");
				expect(decisionLog).toHaveLength(1);
				expect(JSON.parse(decisionLog[0] ?? "{}")).toMatchObject({
					stage: "worker",
					workspaceId: "foo",
					shadow: true,
					kit: "default",
				});
				expect(existsSync(getPipelineStatePath("foo"))).toBe(true);
				expect(logs).toEqual([]);
			} finally {
				await host.close();
			}
			await waitFor(() => exitCode, 10_000);
			expect(exitCode).toBe(0);
		});
	}, 60_000);
});
