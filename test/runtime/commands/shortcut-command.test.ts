import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
	add: vi.fn(),
	remove: vi.fn(),
	list: vi.fn(),
	createdFor: [] as string[],
}));

vi.mock("../../../src/commands/runtime-trpc-client.js", () => ({
	createRuntimeTrpcClient: (workspaceId: string) => {
		clientMocks.createdFor.push(workspaceId);
		return {
			shortcuts: {
				add: { mutate: clientMocks.add },
				remove: { mutate: clientMocks.remove },
				list: { query: clientMocks.list },
			},
		};
	},
}));
vi.mock("../../../src/commands/workspace-target.js", () => ({
	resolveWorkspaceTarget: vi.fn(async (project: string | undefined) => ({
		workspaceId: project === "/projects/notes" ? "notes" : "other",
		repoPath: project ?? "/projects/other",
	})),
}));

import { formatShortcutChange, registerShortcutCommand } from "../../../src/commands/shortcut";

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
	const program = new Command();
	program.exitOverride();
	registerShortcutCommand(program);
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

describe("kanban shortcut", () => {
	afterEach(() => {
		clientMocks.add.mockReset();
		clientMocks.remove.mockReset();
		clientMocks.list.mockReset();
		clientMocks.createdFor.length = 0;
	});

	it("adds through the project's server route and prints what changed", async () => {
		clientMocks.add.mockResolvedValue({
			ok: true,
			shortcuts: [],
			change: { label: "Preview", to: { label: "Preview", command: "PORT={port} npm run dev", icon: "play" } },
		});
		const result = await runCli([
			"shortcut",
			"add",
			"--project",
			"/projects/notes",
			"--label",
			"Preview",
			"--command",
			"PORT={port} npm run dev",
			"--icon",
			"play",
		]);
		expect(clientMocks.createdFor).toEqual(["notes"]);
		expect(clientMocks.add).toHaveBeenCalledWith({
			label: "Preview",
			command: "PORT={port} npm run dev",
			icon: "play",
		});
		expect(result.stdout).toContain('notes: shortcut "Preview" added.');
		expect(result.exitCode).toBeUndefined();
	});

	it("fails with the server's refusal", async () => {
		clientMocks.remove.mockResolvedValue({
			ok: false,
			shortcuts: [],
			change: null,
			error: "card d1111 of notes can't",
		});
		const result = await runCli(["shortcut", "remove", "--project", "/projects/notes", "--label", "Preview"]);
		expect(result.stderr).toContain("Shortcut remove failed: card d1111 of notes can't");
		expect(result.exitCode).toBe(1);
	});

	it("lists the project's shortcuts", async () => {
		clientMocks.list.mockResolvedValue({ shortcuts: [{ label: "Test", command: "npm test", icon: "bug" }] });
		expect((await runCli(["shortcut", "list", "--project", "/projects/notes"])).stdout).toBe(
			"Test [bug]: npm test\n",
		);
	});

	it("says updated, removed or no change", () => {
		const shortcut = { label: "A", command: "ls" };
		expect(
			formatShortcutChange(
				{ ok: true, shortcuts: [], change: { label: "A", from: shortcut, to: shortcut }, changes: [] },
				"w",
			)[0],
		).toContain("updated");
		expect(
			formatShortcutChange({ ok: true, shortcuts: [], change: { label: "A", from: shortcut }, changes: [] }, "w")[0],
		).toContain("removed");
		expect(formatShortcutChange({ ok: true, shortcuts: [], change: null, changes: [] }, "w")[0]).toContain(
			"no change",
		);
	});
});
