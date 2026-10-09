import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerBenchCommand } from "../../../../src/commands/bench";
import { readRunoffs } from "../../../../src/kits/team/runoffs/runoffs-store";
import { getKanbanGlobalConfigPath, getWatchdogWorkspacePaths } from "../../../../src/state/kanban-home";
import type * as WorkspaceStateModule from "../../../../src/state/workspace-state";
import { withTemporaryKanbanHome } from "../../../utilities/kanban-home";
import {
	createBoard,
	createWorkspaceStateStore,
	type WorkspaceStateStore,
} from "../../../utilities/workspace-state-store";

// `kanban bench runoff create` drives the real `createTask` against an in-memory board (the runtime is only told the
// board changed), so the test sees the cards the command writes and when runoffs.json gets the group.
const harness = vi.hoisted(() => ({
	store: null as null | WorkspaceStateStore,
	/** Card ids runoffs.json listed when each card was written. */
	recordedAtCreate: [] as string[][],
	runoffsPath: "",
	/** The card ids runoffs.json lists now (set by the test: mock factories can't use the file's imports). */
	readRecordedCards: (): string[] => [],
}));

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: () => ({
		projects: { add: { mutate: async () => ({ ok: true, project: { id: "ws-1" } }) } },
		workspace: { notifyStateUpdated: { mutate: async () => ({ ok: true }) } },
	}),
	httpBatchLink: () => null,
}));

vi.mock("../../../../src/state/workspace-state", async (importOriginal) => {
	const original = await importOriginal<typeof WorkspaceStateModule>();
	return {
		...original,
		listWorkspaceIndexEntries: vi.fn(async () => [{ workspaceId: "ws-1", repoPath: "/repo" }]),
		loadWorkspaceContext: vi.fn(async () => ({ repoPath: "/repo", workspaceId: "ws-1" })),
		loadWorkspaceBoardById: vi.fn(async () => (harness.store as WorkspaceStateStore).stored.board),
		mutateWorkspaceState: vi.fn(async (...args: Parameters<WorkspaceStateStore["mutateWorkspaceState"]>) => {
			harness.recordedAtCreate.push(harness.readRecordedCards());
			return await (harness.store as WorkspaceStateStore).mutateWorkspaceState(...args);
		}),
	};
});

function writeConfig(config: Record<string, unknown>): void {
	const path = getKanbanGlobalConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config));
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
	const program = new Command();
	program.exitOverride();
	registerBenchCommand(program);
	let stdout = "";
	let stderr = "";
	const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdout += String(chunk);
		return true;
	});
	const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderr += String(chunk);
		return true;
	});
	const previous = process.exitCode;
	process.exitCode = undefined;
	try {
		await program.parseAsync(["node", "kanban", "bench", ...args]);
		return { stdout, stderr, exitCode: process.exitCode };
	} finally {
		out.mockRestore();
		err.mockRestore();
		process.exitCode = previous;
	}
}

const CREATE = [
	"runoff",
	"create",
	"coupons",
	"--project",
	"ws-1",
	"--prompt",
	"Build coupons",
	"--title",
	"Coupons",
	"--model",
	"cline:bedrock/us.moonshotai.kimi-k3",
	"--model",
	"codex:gpt-6.1",
	"--base",
	"main",
	"--json",
];

describe("kanban bench runoff create", () => {
	beforeEach(() => {
		harness.readRecordedCards = () =>
			(
				JSON.parse(readFileSync(harness.runoffsPath, "utf8")) as { runoffs: Array<{ cards: string[] }> }
			).runoffs.flatMap((runoff) => runoff.cards);
	});
	afterEach(() => {
		harness.recordedAtCreate = [];
	});

	it("records the group in runoffs.json before it creates the cards, one per model on the same prompt and base", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig({
				workspaces: {
					"ws-1": { kit: { name: "team" }, models: { allowProvisional: true }, landing: { mode: "qa" } },
				},
			});
			harness.store = createWorkspaceStateStore({ board: createBoard({}), sessions: {}, revision: 1 });
			harness.runoffsPath = getWatchdogWorkspacePaths("ws-1").runoffs;

			const result = await run(CREATE);

			// The user's own runoff on a combination the vetted model registry doesn't know: a warning, not a refusal.
			expect(result.stderr).toContain("codex + gpt-6.1 is not vetted for dev work");
			expect(result.stderr).not.toContain("kimi-k3");
			expect(result.exitCode).toBe(0);
			const [runoff] = (await readRunoffs(harness.runoffsPath)).runoffs;
			expect(runoff).toMatchObject({ name: "coupons", base: "main", prompt: "inline", decided: null });
			const backlog = harness.store.stored.board.columns.find((column) => column.id === "backlog")?.cards ?? [];
			expect(backlog).toHaveLength(2);
			// Backlog shows the newest first; take them in the runoff's order.
			const cards = (runoff?.cards ?? []).flatMap((id) => backlog.filter((card) => card.id === id));
			expect(cards).toHaveLength(2);
			expect(cards.map((card) => [card.title, card.prompt, card.baseRef, card.agentId, card.agentSettings])).toEqual(
				[
					[
						"Coupons [runoff coupons: kimi-k3]",
						"Build coupons",
						"main",
						"cline",
						{ providerId: "bedrock", modelId: "us.moonshotai.kimi-k3" },
					],
					["Coupons [runoff coupons: gpt-6.1]", "Build coupons", "main", "codex", { modelId: "gpt-6.1" }],
				],
			);
			expect(runoff?.models).toEqual({
				[cards[0]?.id ?? ""]: "bedrock/us.moonshotai.kimi-k3",
				[cards[1]?.id ?? ""]: "gpt-6.1",
			});
			// Each card was written with the whole group already in runoffs.json.
			expect(harness.recordedAtCreate).toEqual([runoff?.cards, runoff?.cards]);

			// The same name again is refused, and nothing more is created.
			const again = await run(CREATE);
			expect(again.exitCode).toBe(2);
			expect(again.stderr).toContain('already has a runoff named "coupons"');
			expect(JSON.parse(readFileSync(harness.runoffsPath, "utf8")).runoffs).toHaveLength(1);
		});
	});

	it("refuses an agent session's runoff on a combination the vetted model registry doesn't allow", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig({
				workspaces: {
					"ws-1": { kit: { name: "team" }, models: { allowProvisional: true }, landing: { mode: "qa" } },
				},
			});
			harness.store = createWorkspaceStateStore({ board: createBoard({}), sessions: {}, revision: 1 });
			harness.runoffsPath = getWatchdogWorkspacePaths("ws-1").runoffs;
			process.env.KANBAN_SESSION_CREDENTIAL = "orchestrator-credential";
			try {
				const result = await run(CREATE);
				expect(result.exitCode).toBe(2);
				expect(result.stderr).toMatch(
					/ws-1 routes only to combinations the vetted model registry allows: codex \+ gpt-6\.1/u,
				);
				expect(harness.store.stored.board.columns.flatMap((column) => column.cards)).toEqual([]);
			} finally {
				delete process.env.KANBAN_SESSION_CREDENTIAL;
			}
		});
	});

	it("refuses a workspace whose kit doesn't run the runoffs feature (each card would land on its own)", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig({ workspaces: { "ws-1": { landing: { mode: "qa" } } } });
			harness.store = createWorkspaceStateStore({ board: createBoard({}), sessions: {}, revision: 1 });

			const result = await run(CREATE);

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain('runs kit "default", which doesn\'t list the "runoffs" feature');
			expect(harness.store.stored.board.columns.flatMap((column) => column.cards)).toEqual([]);
		});
	});
});
