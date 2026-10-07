import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeClientMocks = vi.hoisted(() => ({
	createRuntimeTrpcClient: vi.fn((workspaceId: string | null) => ({ workspaceId })),
	notifyRuntimeWorkspaceStateUpdated: vi.fn(async () => undefined),
}));

// Never reach a real Kanban server from a test.
vi.mock("../../../src/commands/runtime-trpc-client", () => runtimeClientMocks);

import { registerModelsCommand } from "../../../src/commands/models";
import {
	getKanbanGlobalConfigPath,
	getKanbanModelsDataPath,
	resetKanbanHomeForTests,
} from "../../../src/state/kanban-home";
import { loadWorkspaceBoardById, loadWorkspaceContext, mutateWorkspaceState } from "../../../src/state/workspace-state";
import { createGitTestEnv } from "../../utilities/git-env";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createBoard, createCard, findCardInBoard } from "../../utilities/workspace-state-store";

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runKanban(args: string[]): Promise<RunResult> {
	const program = new Command();
	program.exitOverride();
	registerModelsCommand(program);
	let stdout = "";
	let stderr = "";
	const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdout += String(chunk);
		return true;
	});
	const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderr += String(chunk);
		return true;
	});
	process.exitCode = undefined;
	try {
		await program.parseAsync(["node", "kanban", ...args]);
	} finally {
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	}
	const exitCode = Number(process.exitCode ?? 0);
	process.exitCode = undefined;
	return { stdout, stderr, exitCode };
}

function writeConfig(clineDataDir: string, extra: Record<string, unknown> = {}): void {
	const configPath = getKanbanGlobalConfigPath();
	mkdirSync(join(configPath, ".."), { recursive: true });
	writeFileSync(
		configPath,
		JSON.stringify({
			models: {
				providers: {
					default: "bedrock",
					fallback: { "moonshotai.kimi-k3": "lemonade" },
					deprecated: { "openai-native": "Mantle" },
				},
				bedrockRegion: "us-east-2",
			},
			agents: { cline: { dataDir: clineDataDir }, codex: { home: join(clineDataDir, "codex") } },
			...extra,
		}),
	);
}

function writeClineProviders(clineDataDir: string, providers: Record<string, unknown>): void {
	mkdirSync(join(clineDataDir, "settings"), { recursive: true });
	writeFileSync(join(clineDataDir, "settings", "providers.json"), JSON.stringify(providers), { mode: 0o600 });
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("kanban models", () => {
	const savedApiKey = process.env.BEDROCK_API_KEY;

	beforeEach(() => {
		delete process.env.BEDROCK_API_KEY;
		runtimeClientMocks.notifyRuntimeWorkspaceStateUpdated.mockClear();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (savedApiKey === undefined) {
			delete process.env.BEDROCK_API_KEY;
		} else {
			process.env.BEDROCK_API_KEY = savedApiKey;
		}
		resetKanbanHomeForTests();
	});

	it("providers --for prints the provider from models.providers", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			writeConfig(join(userHomePath, "cline-data"));
			await expect(runKanban(["models", "providers", "--for", "moonshotai.kimi-k3"])).resolves.toMatchObject({
				stdout: "lemonade\n",
				exitCode: 0,
			});
			await expect(runKanban(["models", "providers", "--for", "us.openai.gpt-6.1-sol"])).resolves.toMatchObject({
				stdout: "bedrock\n",
			});
		});
	});

	it("providers reports Cline's settings from agents.cline.dataDir", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const clineDataDir = join(userHomePath, "cline-data");
			writeConfig(clineDataDir);
			writeClineProviders(clineDataDir, {
				lastUsedProvider: "bedrock",
				providers: { "openai-native": { settings: { provider: "openai-native", apiKey: "fake-key" } } },
			});
			const result = await runKanban(["models", "providers"]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Default provider: bedrock");
			expect(result.stdout).toContain("Fallback: moonshotai.kimi-k3 -> lemonade");
			expect(result.stdout).toContain("DEPRECATED providers.openai-native");
			expect(result.stdout).toContain(join(clineDataDir, "settings", "providers.json"));
			expect(result.stdout).not.toContain("fake-key");
		});
	});

	it("probe uses the configured region, the us.* profile, and caches profiles in the Kanban home", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const clineDataDir = join(userHomePath, "cline-data");
			writeConfig(clineDataDir);
			writeClineProviders(clineDataDir, { providers: { bedrock: { settings: { apiKey: "file-key" } } } });
			const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
				url.includes("/inference-profiles")
					? jsonResponse({ inferenceProfileSummaries: [{ inferenceProfileId: "us.zai.glm-5" }] })
					: url.includes("us.zai.glm-5")
						? jsonResponse({
								output: { message: { content: [{ toolUse: { input: { path: "package.json" } } }] } },
							})
						: jsonResponse({ message: "Service unavailable" }, 503),
			);
			vi.stubGlobal("fetch", fetchMock);

			const result = await runKanban(["models", "probe", "zai.glm-5", "deepseek.v3.2", "xai.grok-4"]);
			expect(result.exitCode).toBe(1);
			expect(result.stdout.trim().split("\n")).toEqual([
				expect.stringMatching(/^deepseek\.v3\.2 \| 503 \| Service unavailable \| \d+$/u),
				expect.stringMatching(/^us\.zai\.glm-5 \| 200 \| TOOL \{"path":"package\.json"\} \| \d+$/u),
			]);
			expect(result.stderr).toContain("skipped xai.grok-4");
			expect(fetchMock.mock.calls.some(([url]) => url.includes("grok"))).toBe(false);
			expect(fetchMock.mock.calls.every(([url]) => url.includes("us-east-2"))).toBe(true);
			expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined)?.authorization).toBe(
				"Bearer file-key",
			);
			const cachePath = join(getKanbanModelsDataPath(), "bedrock-profiles.json");
			expect(JSON.parse(readFileSync(cachePath, "utf8")).profiles).toEqual(["us.zai.glm-5"]);

			const ok = await runKanban(["models", "probe", "zai.glm-5", "--json"]);
			expect(ok.exitCode).toBe(0);
			expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, region: "us-east-2" });
			const list = await runKanban(["models", "probe", "--list"]);
			expect(list.stdout).toBe("us.zai.glm-5\n");
			// The profile list was fetched once and then read from the cache.
			expect(fetchMock.mock.calls.filter(([url]) => url.includes("/inference-profiles"))).toHaveLength(1);
		});
	});

	it("probe without a key, or without model ids, fails with a message", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			writeConfig(join(userHomePath, "cline-data"));
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			await expect(runKanban(["models", "probe", "zai.glm-5"])).resolves.toMatchObject({
				exitCode: 1,
				stderr: expect.stringContaining("No Bedrock API key"),
			});
			process.env.BEDROCK_API_KEY = "env-key";
			fetchMock.mockResolvedValue(jsonResponse({ inferenceProfileSummaries: [] }));
			await expect(runKanban(["models", "probe"])).resolves.toMatchObject({
				exitCode: 1,
				stderr: expect.stringContaining("pass one or more model ids"),
			});
		});
	});

	it("providers --migrate-cards is a dry run until --apply, then moves only the provider", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			writeConfig(join(userHomePath, "cline-data"));
			const repoPath = join(userHomePath, "repo");
			mkdirSync(repoPath);
			execFileSync("git", ["init", "-q"], { cwd: repoPath, env: createGitTestEnv() });
			const context = await loadWorkspaceContext(repoPath);
			await mutateWorkspaceState(repoPath, () => ({
				board: createBoard({
					backlog: [
						createCard({
							id: "b1",
							agentSettings: { providerId: "openai-native", modelId: "moonshotai.kimi-k3" },
						}),
					],
					review: [createCard({ id: "r1", agentSettings: { providerId: "bedrock", modelId: "zai.glm-5" } })],
				}),
				value: null,
			}));

			const dryRun = await runKanban(["models", "providers", "--migrate-cards", "--workspace", context.workspaceId]);
			expect(dryRun.stdout).toContain(
				`would ${context.workspaceId}/b1 (backlog): openai-native/moonshotai.kimi-k3 -> lemonade/moonshotai.kimi-k3`,
			);
			expect(
				findCardInBoard(await loadWorkspaceBoardById(context.workspaceId), "b1")?.card.agentSettings?.providerId,
			).toBe("openai-native");
			expect(runtimeClientMocks.notifyRuntimeWorkspaceStateUpdated).not.toHaveBeenCalled();

			const applied = await runKanban(["models", "providers", "--migrate-cards", "--apply"]);
			expect(applied.exitCode).toBe(0);
			expect(applied.stdout).toContain(`moved ${context.workspaceId}/b1`);
			const board = await loadWorkspaceBoardById(context.workspaceId);
			expect(findCardInBoard(board, "b1")?.card.agentSettings).toEqual({
				providerId: "lemonade",
				modelId: "moonshotai.kimi-k3",
			});
			expect(findCardInBoard(board, "r1")?.card.agentSettings?.providerId).toBe("bedrock");
			expect(runtimeClientMocks.createRuntimeTrpcClient).toHaveBeenCalledWith(context.workspaceId);
			expect(runtimeClientMocks.notifyRuntimeWorkspaceStateUpdated).toHaveBeenCalledTimes(1);

			const again = await runKanban(["models", "providers", "--migrate-cards", "--apply"]);
			expect(again.stdout).toContain("No open cards on a deprecated provider.");
			expect(runtimeClientMocks.notifyRuntimeWorkspaceStateUpdated).toHaveBeenCalledTimes(1);
			expect(existsSync(join(userHomePath, "cline-data", "settings"))).toBe(false);
		});
	});
});
