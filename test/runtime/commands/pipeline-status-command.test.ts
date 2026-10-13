// `kanban pipeline status`: each landing-qa workspace's card stages come from the running server as they are.
import { TRPCClientError } from "@trpc/client";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimePipelineCardStage } from "../../../src/core/api-contract";

const mocks = vi.hoisted(() => ({
	cardStages: vi.fn(),
	createdFor: [] as string[],
	config: {} as unknown,
}));

vi.mock("../../../src/commands/runtime-trpc-client.js", () => ({
	createRuntimeTrpcClient: (workspaceId: string) => {
		mocks.createdFor.push(workspaceId);
		return { pipeline: { cardStages: { query: () => mocks.cardStages(workspaceId) } } };
	},
}));
vi.mock("../../../src/config/pipeline-config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/config/pipeline-config")>();
	return {
		...actual,
		readPipelineConfig: async () => ({ ...actual.parsePipelineConfig(mocks.config), configPath: "/tmp/config.json" }),
	};
});
vi.mock("../../../src/state/workspace-state.js", () => ({
	listWorkspaceIndexEntries: async () => [{ workspaceId: "foo" }, { workspaceId: "notes" }],
	loadWorkspaceBoardById: vi.fn(),
}));

import { registerPipelineCommand } from "../../../src/commands/pipeline";

const STAGE: RuntimePipelineCardStage = {
	taskId: "8c28e",
	kind: "checks_running",
	label: "Checks running (test)",
	next: "QA next",
	qaTaskId: null,
	deadline: Date.parse("2026-10-11T07:03:00.000Z"),
	detail: "QA starts without the checks at 07:03",
	detailTimes: [],
	inFlight: true,
};

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
	const program = new Command();
	program.exitOverride();
	registerPipelineCommand(program);
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
	process.exitCode = undefined;
	try {
		await program.parseAsync(["node", "kanban", ...args]);
	} finally {
		out.mockRestore();
		err.mockRestore();
	}
	const exitCode = typeof process.exitCode === "number" ? process.exitCode : undefined;
	process.exitCode = undefined;
	return { stdout, stderr, exitCode };
}

describe("kanban pipeline status", () => {
	afterEach(() => {
		mocks.cardStages.mockReset();
		mocks.createdFor.length = 0;
	});

	it("prints each landing-qa workspace's card stages as the server has them, and asks no other workspace", async () => {
		mocks.config = { workspaces: { foo: { landing: { mode: "qa" } } } };
		mocks.cardStages.mockResolvedValue({ stages: [STAGE] });
		const result = await runCli(["pipeline", "status", "--decisions", "0"]);
		expect(result.exitCode).toBeUndefined();
		expect(result.stderr).toBe("");
		expect(mocks.createdFor).toEqual(["foo"]);
		const output = JSON.parse(result.stdout);
		expect(output.server).toMatchObject({ running: true, error: null });
		const [foo, notes] = output.workspaces;
		expect(foo).toMatchObject({ workspaceId: "foo", landingMode: "qa" });
		expect(foo.cardStages).toEqual([{ ...STAGE, deadlineAt: "2026-10-11T07:03:00.000Z" }]);
		expect(notes.workspaceId).toBe("notes");
		expect(notes).not.toHaveProperty("cardStages");
	});

	it("says plainly that no server is running and keeps the rest of the output", async () => {
		mocks.config = { workspaces: { foo: { landing: { mode: "qa" } } } };
		mocks.cardStages.mockRejectedValue(new TRPCClientError("fetch failed"));
		const result = await runCli(["pipeline", "status", "--decisions", "0"]);
		expect(result.exitCode).toBeUndefined();
		expect(result.stderr).toContain("No Kanban server is running at");
		expect(result.stderr).toContain("card stages come only from it");
		const output = JSON.parse(result.stdout);
		expect(output).toMatchObject({ ok: true, server: { running: false, error: "fetch failed" } });
		expect(output.workspaces[0]).toMatchObject({
			workspaceId: "foo",
			landingMode: "qa",
			kit: "default",
			cardStages: null,
			cardStagesError: "fetch failed",
			decisions: [],
		});
	});

	it("reports a server's refusal on the workspace, not as a server that isn't running", async () => {
		mocks.config = { workspaces: { foo: { landing: { mode: "qa" } } } };
		mocks.cardStages.mockRejectedValue(
			TRPCClientError.from({
				error: {
					message: "refused",
					code: -32603,
					data: { code: "FORBIDDEN", httpStatus: 403 },
				},
			}),
		);
		const result = await runCli(["pipeline", "status", "--decisions", "0"]);
		expect(result.stderr).toBe("");
		const output = JSON.parse(result.stdout);
		expect(output.server).toMatchObject({ running: true, error: null });
		expect(output.workspaces[0]).toMatchObject({ cardStages: null, cardStagesError: "refused" });
	});

	it("asks no server when no workspace is on landing qa", async () => {
		mocks.config = {};
		const result = await runCli(["pipeline", "status", "--decisions", "0"]);
		expect(mocks.createdFor).toEqual([]);
		expect(JSON.parse(result.stdout).server).toMatchObject({ running: null, error: null });
	});
});
