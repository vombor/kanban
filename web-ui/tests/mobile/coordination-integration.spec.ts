import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devices } from "@playwright/test";
import { z } from "zod";
import { runtimeBoardDataSchema } from "../../../src/core/api-contract";
import { createGitTestEnv } from "../../../test/utilities/git-env";
import { expect, test } from "../shared-chrome";
import { type DevInstance, startDevInstance } from "./dev-instance";

const FAKE = `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('fake 1.0');process.exit(0);}
process.stdout.write('OWNED COORDINATION FIXTURE - NO MODEL\\r\\n');process.stdin.resume();
`;
const { defaultBrowserType: _browser, ...desktop } = devices["Desktop Chrome"];
for (const profile of ["phone", "desktop"] as const)
	test.describe(profile, () => {
		if (profile === "desktop") test.use({ ...desktop, viewport: { width: 1400, height: 900 } });
		let instance: DevInstance,
			home: string,
			workspaceId: string,
			ids: string[],
			boardPath: string,
			boardBefore: string,
			headBefore: string;
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: instance.projectDir,
				env: createGitTestEnv(),
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		test.beforeAll(async () => {
			instance = await startDevInstance({
				runtimeArgs: ["--skip-shutdown-cleanup"],
				fakeCommands: { claude: FAKE, cline: FAKE },
				globalConfig: {
					selectedAgentId: "claude",
					watchdog: { mode: "report" },
					pipeline: { recovery: { mode: "off" } },
					providerConcurrency: { lemonade: 1 },
				},
			});
			ids = [];
			for (const [title, model] of [
				["Primary reviewed fixture", "Ornith-1.5-35B-A3B-GGUF-Q4_K_M"],
				["Secondary reviewed fixture", "MuseGlimmer-Q4-DFlash-Test"],
			]) {
				const created = instance.runCli([
					"task",
					"create",
					"--title",
					title ?? "Fixture",
					"--prompt",
					"Owned fixture; do not start an agent or claim QA acceptance.",
					"--agent-id",
					"cline",
					"--provider",
					"lemonade",
					"--model",
					model ?? "fixture",
				]);
				expect(created.status, created.stderr).toBe(0);
				ids.push(z.object({ task: z.object({ id: z.string() }) }).parse(JSON.parse(created.stdout)).task.id);
			}
			home = join(instance.rootDir, "kanban-home");
			const entries = (await readdir(join(home, "workspaces"), { withFileTypes: true })).filter((entry) =>
				entry.isDirectory(),
			);
			if (!entries[0] || entries.length !== 1) throw new Error("Expected isolated workspace");
			workspaceId = entries[0].name;
			const configPath = join(home, "config.json"),
				config: Record<string, unknown> = JSON.parse(await readFile(configPath, "utf8"));
			config.workspaces = { [workspaceId]: { checks: { enabled: true, scripts: ["test"] } } };
			await writeFile(configPath, JSON.stringify(config));
			await writeFile(
				join(instance.projectDir, "package.json"),
				JSON.stringify({
					name: "owned-integration-fixture",
					version: "1.0.0",
					private: true,
					scripts: { test: "node checks.cjs" },
				}),
			);
			await writeFile(
				join(instance.projectDir, "checks.cjs"),
				"const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(fs.readFileSync('a.txt','utf8'),'combined a\\n');assert.equal(fs.readFileSync('b.txt','utf8'),'combined b\\n');assert.equal(process.env.KANBAN_RUNTIME_PORT,undefined);console.log('OWNED COMBINED FIXTURE CHECK PASSED');\n",
			);
			await writeFile(join(instance.projectDir, "a.txt"), "base a\n");
			await writeFile(join(instance.projectDir, "b.txt"), "base b\n");
			git("add", ".");
			git(
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"-m",
				"Owned integration fixture base",
			);
			const base = git("rev-parse", "HEAD"),
				branch = git("branch", "--show-current");
			for (let i = 0; i < 2; i++) {
				git("checkout", "-b", `owned-${i}`, base);
				await writeFile(
					join(instance.projectDir, i === 0 ? "a.txt" : "b.txt"),
					i === 0 ? "combined a\n" : "combined b\n",
				);
				git("add", ".");
				git(
					"-c",
					"user.name=Fixture",
					"-c",
					"user.email=fixture@example.invalid",
					"-c",
					"core.hooksPath=/dev/null",
					"commit",
					"-m",
					`Owned snapshot ${i}`,
				);
				git("update-ref", `refs/kanban/snapshots/${ids[i]}`, git("rev-parse", "HEAD"));
			}
			git("checkout", branch);
			headBefore = git("rev-parse", "HEAD");
			boardPath = join(home, "workspaces", workspaceId, "board.json");
			const board = runtimeBoardDataSchema.parse(JSON.parse(await readFile(boardPath, "utf8"))),
				cards = board.columns.flatMap((column) => column.cards).filter((card) => ids.includes(card.id));
			expect(cards).toHaveLength(2);
			for (const column of board.columns)
				column.cards = column.id === "review" ? cards : column.cards.filter((card) => !ids.includes(card.id));
			for (const card of cards) card.baseRef = branch;
			await writeFile(boardPath, JSON.stringify(board));
			await instance.restartRuntime();
			boardBefore = await readFile(boardPath, "utf8");
			expect(
				runtimeBoardDataSchema.parse(JSON.parse(boardBefore)).columns.find((column) => column.id === "review")
					?.cards,
			).toHaveLength(2);
			const preview = instance.runCli(["coordination", "--project", workspaceId]);
			expect(preview.status, preview.stderr).toBe(0);
			expect(z.object({ tasks: z.array(z.unknown()) }).parse(JSON.parse(preview.stdout)).tasks).toHaveLength(2);
			const integration = instance.runCli(["integration", "preview", ...ids, "--project", workspaceId]);
			expect(integration.status, integration.stderr).toBe(0);
			expect(z.object({ fingerprint: z.string() }).parse(JSON.parse(integration.stdout)).fingerprint).toMatch(
				/^[a-f0-9]{64}$/u,
			);
		});
		test.afterAll(async () => {
			await instance?.stop();
		});
		test("shows advisory sequencing and executes one disposable exact combination without moving tasks or granting QA", async ({
			page,
		}) => {
			test.setTimeout(120000);
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			await page.goto(instance.baseUrl);
			await page.getByRole("button", { name: "Project knowledge", exact: true }).click();
			const knowledge = page.getByRole("dialog", { name: /Knowledge ·/ });
			await knowledge.getByRole("button", { name: "Coordination preview", exact: true }).click();
			const coordination = page.getByRole("dialog", { name: "Coordination preview", exact: true });
			await expect(coordination).toContainText("2 tasks");
			await expect(coordination).toContainText("provider serialization");
			await expect(coordination).toContainText("Advisory only");
			await expect(coordination.getByRole("button", { name: /start task|reassign|land/i })).toHaveCount(0);
			await coordination.getByRole("button", { name: "Close coordination", exact: true }).click();
			await knowledge.getByRole("button", { name: "Integration reports", exact: true }).click();
			const integration = page.getByRole("dialog", { name: "Speculative integration reports", exact: true });
			await integration.getByLabel("Integration task ids", { exact: true }).fill(ids.join(","));
			await integration.getByRole("button", { name: "Preview exact candidate", exact: true }).click();
			await expect(integration).toContainText("Candidate fingerprint:");
			const run = integration.getByRole("button", { name: "Run exact candidate checks", exact: true });
			await expect(run).toBeDisabled();
			expect(await readFile(boardPath, "utf8")).toBe(boardBefore);
			await integration.getByRole("checkbox").check();
			await run.click();
			await expect(integration).toContainText("Retained request id:");
			await expect(async () => {
				await integration.getByRole("button", { name: "Read retained report", exact: true }).click();
				await expect(integration).toContainText("Status: checks passed");
			}).toPass({ timeout: 45000 });
			await expect(integration).toContainText("freshness: current");
			await expect(integration).toContainText("cleanup: complete");
			await expect(integration).toContainText("not individual QA acceptance");
			await expect(run).toHaveCount(0);
			const bounds = await integration.boundingBox();
			expect(bounds?.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
			expect(await readFile(boardPath, "utf8")).toBe(boardBefore);
			expect(git("rev-parse", "HEAD")).toBe(headBefore);
			await writeFile(join(instance.projectDir, "unsubmitted.txt"), "Does not enter retained candidate snapshots\n");
			await integration.getByRole("button", { name: "Read retained report", exact: true }).click();
			await expect(integration).toContainText("freshness: current");
			const changed = instance.runCli([
				"task",
				"update",
				"--task-id",
				ids[0] ?? "missing",
				"--title",
				"Changed fixture after report",
			]);
			expect(changed.status, changed.stderr).toBe(0);
			await integration.getByRole("button", { name: "Read retained report", exact: true }).click();
			await expect(integration).toContainText("freshness: stale");
			expect(errors).toEqual([]);
		});
	});
