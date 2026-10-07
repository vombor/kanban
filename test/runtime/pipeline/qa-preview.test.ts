import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createQaPreviewController } from "../../../src/pipeline/qa-preview";
import { createTempDir } from "../../utilities/temp-dir";

const PREVIEW = { pidFile: ".preview.pid", start: "start-preview", stop: "stop-preview" };

describe("QA preview on demand", () => {
	const temps: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const temp of temps.splice(0)) {
			temp.cleanup();
		}
	});

	const setup = (alive: Set<number>) => {
		const temp = createTempDir("kanban-qa-preview-");
		temps.push(temp);
		const repoPath = join(temp.path, "repo");
		mkdirSync(repoPath, { recursive: true });
		const markPath = join(temp.path, "run", "qa-preview-foo.pid");
		let now = 0;
		const commands: string[] = [];
		const logs: string[] = [];
		const controller = createQaPreviewController({
			runShell: async (command) => {
				commands.push(command);
				if (command === "start-preview") {
					writeFileSync(join(repoPath, ".preview.pid"), "4321");
					alive.add(4321);
				}
				return { code: 0, output: "" };
			},
			isPidAlive: (pid) => alive.has(pid),
			getMarkPath: () => markPath,
			now: () => now,
			log: (message) => logs.push(message),
		});
		return {
			controller,
			repoPath,
			markPath,
			commands,
			logs,
			setNow: (next: number) => {
				now = next;
			},
		};
	};

	it("starts a preview that is down, remembers its pid, and stops it after the idle time", async () => {
		const harness = setup(new Set());
		await harness.controller.ensure({ workspaceId: "foo", repoPath: harness.repoPath, preview: PREVIEW });
		expect(harness.commands).toEqual(["start-preview"]);
		expect(readFileSync(harness.markPath, "utf8")).toBe("4321");

		const idle = { workspaceId: "foo", repoPath: harness.repoPath, preview: PREVIEW, qaActive: false, idleMin: 5 };
		await harness.controller.stopIfIdle(idle);
		harness.setNow(4 * 60_000);
		await harness.controller.stopIfIdle(idle);
		expect(harness.commands).toEqual(["start-preview"]);
		harness.setNow(5 * 60_000);
		await harness.controller.stopIfIdle(idle);
		expect(harness.commands).toEqual(["start-preview", "stop-preview"]);
		expect(existsSync(harness.markPath)).toBe(false);
	});

	it("leaves a running preview alone, and never stops one the user restarted under a new pid", async () => {
		const alive = new Set([1111]);
		const harness = setup(alive);
		writeFileSync(join(harness.repoPath, ".preview.pid"), "1111");
		await harness.controller.ensure({ workspaceId: "foo", repoPath: harness.repoPath, preview: PREVIEW });
		expect(harness.commands).toEqual([]);

		// The gate started 4321 earlier; the user's Preview button restarted it as 1111.
		mkdirSync(join(harness.markPath, ".."), { recursive: true });
		writeFileSync(harness.markPath, "4321");
		const idle = { workspaceId: "foo", repoPath: harness.repoPath, preview: PREVIEW, qaActive: false, idleMin: 0 };
		await harness.controller.stopIfIdle(idle);
		expect(harness.commands).toEqual([]);
		expect(harness.logs.at(-1)).toContain("isn't the one the QA gate started");
	});

	it("does nothing while QA is active or when the gate started no preview", async () => {
		const harness = setup(new Set([4321]));
		writeFileSync(join(harness.repoPath, ".preview.pid"), "4321");
		await harness.controller.stopIfIdle({
			workspaceId: "foo",
			repoPath: harness.repoPath,
			preview: PREVIEW,
			qaActive: false,
			idleMin: 0,
		});
		mkdirSync(join(harness.markPath, ".."), { recursive: true });
		writeFileSync(harness.markPath, "4321");
		await harness.controller.stopIfIdle({
			workspaceId: "foo",
			repoPath: harness.repoPath,
			preview: PREVIEW,
			qaActive: true,
			idleMin: 0,
		});
		expect(harness.commands).toEqual([]);
	});
});
