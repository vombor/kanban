import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devices } from "@playwright/test";
import { z } from "zod";
import { objectiveCreateSchema } from "../../../src/core/objective-contract";
import { objectiveUsageRecordSchema } from "../../../src/core/objective-usage";
import { createEfficiencyTimingStore } from "../../../src/efficiency/timing-store";
import { createDiscoveryPolicyStore } from "../../../src/knowledge/discovery-policy";
import { createProjectKnowledgeStore } from "../../../src/knowledge/knowledge-store";
import { createObjectiveStore } from "../../../src/objectives/objective-store";
import { getKnowledgeDiscoveryPaths } from "../../../src/state/kanban-home";
import { expect, test } from "../shared-chrome";
import { type DevInstance, startDevInstance } from "./dev-instance";

const FAKE = `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('fake 1.0');process.exit(0);}
process.stdout.write('OWNED REPORT FIXTURE - NO MODEL\\r\\n');process.stdin.resume();
`;
const { defaultBrowserType: _browser, ...desktop } = devices["Desktop Chrome"];
for (const profile of ["phone", "desktop"] as const) {
	test.describe(profile, () => {
		test.use({ actionTimeout: 10000 });
		if (profile === "desktop") test.use({ ...desktop, viewport: { width: 1400, height: 900 } });
		let instance: DevInstance, home: string, workspaceId: string, taskId: string, sharedFile: string;
		test.beforeAll(async () => {
			instance = await startDevInstance({
				fakeCommands: { claude: FAKE },
				globalConfig: { selectedAgentId: "claude" },
				runtimeArgs: ["--skip-shutdown-cleanup"],
			});
			const created = instance.runCli([
				"task",
				"create",
				"--title",
				"Unstarted reports fixture",
				"--prompt",
				"Read-only fixture; never run a model.",
			]);
			expect(created.status, created.stderr).toBe(0);
			taskId = z.object({ task: z.object({ id: z.string() }) }).parse(JSON.parse(created.stdout)).task.id;
			home = join(instance.rootDir, "kanban-home");
			const entries = (await readdir(join(home, "workspaces"), { withFileTypes: true })).filter((entry) =>
				entry.isDirectory(),
			);
			if (entries.length !== 1 || !entries[0]) throw new Error("Expected owned workspace");
			workspaceId = entries[0].name;
			await writeFile(
				join(instance.projectDir, "README.md"),
				"# Project Markdown baseline\nWorks with no optional service.\n",
			);
			await mkdir(join(instance.projectDir, "docs"), { recursive: true });
			await writeFile(join(instance.projectDir, "docs/guide.md"), "# Project guide\nReference only.");
			const policy = createDiscoveryPolicyStore(home),
				definition = await policy.addCollection(workspaceId, {
					globalRevision: null,
					collection: { id: "team", title: "Team library", obsidianFolder: null },
				});
			await policy.saveProject(workspaceId, {
				globalRevision: definition.globalRevision,
				projectRevision: null,
				shared: [],
				obsidianFolder: "Own",
			});
			const folder = join(getKnowledgeDiscoveryPaths(home).shared, "team");
			await mkdir(folder, { recursive: true });
			sharedFile = join(folder, "guide.md");
			await writeFile(
				sharedFile,
				"# Shared playbook\nReusable guidance. #shared\n[Linked](linked.md) [hidden](../other-project/private.md)\n<script>bad()</script>",
			);
			await writeFile(join(folder, "linked.md"), "# Linked shared note\nSafe guidance. #shared");
			const timing = createEfficiencyTimingStore(home),
				now = Date.now();
			await timing.sample(workspaceId, {
				serverId: "owned-injected-metrics",
				at: now - 20000,
				labels: { history1: ["agent_running", "checks_running"], history2: ["agent_running"] },
				counters: { history1: 100, history2: 100 },
			});
			await timing.sample(workspaceId, {
				serverId: "owned-injected-metrics",
				at: now - 10000,
				labels: { history1: ["agent_running", "checks_running"], history2: ["agent_running"] },
				counters: { history1: 6100, history2: 100 },
			});
			const objectives = createObjectiveStore({ home }),
				objective = await objectives.create(
					workspaceId,
					objectiveCreateSchema.parse({
						requestId: randomUUID(),
						title: "Owned injected report evidence",
						requirements: "Fixture-only metric presentation; not execution approval.",
						taskIds: [taskId],
					}),
				);
			await objectives.recordUsage(workspaceId, objective.id, [
				objectiveUsageRecordSchema.parse({
					id: "b".repeat(64),
					version: "c".repeat(64),
					taskId,
					requirementsHash: objective.requirementsHash,
					observedAt: new Date().toISOString(),
					attemptId: null,
					observation: {
						key: "owned-fixture-request",
						agent: "claude",
						basis: "request",
						at: Date.now(),
						model: "fixture-only",
						provider: "bedrock",
						tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0 },
						uncertainty: [],
					},
					price: {
						revision: "d".repeat(64),
						source: "configured",
						kind: "table_estimate",
						rates: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
						estimatedUsd: 1.25,
					},
					uncertainty: ["owned_injected_metrics_not_model_trials"],
				}),
			]);
		});
		test.afterAll(async () => {
			await instance?.stop();
		});
		test("discovers scoped Markdown/Shared refs with optional-service fallback and reads honest reports without starting tasks", async ({
			page,
		}) => {
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.goto(instance.baseUrl);
			await page.getByRole("button", { name: "Project knowledge", exact: true }).click();
			const knowledge = page.getByRole("dialog", { name: /Knowledge ·/ });
			await knowledge.getByRole("button", { name: "Explore reference sources", exact: true }).click();
			const sources = page.getByRole("dialog", { name: "Project and Shared reference sources", exact: true });
			await expect(sources).toContainText("obsidian unavailable markdown fallback");
			await sources.getByRole("button", { name: /^Project Markdown baseline/ }).click();
			await expect(sources.getByRole("heading", { name: "Project Markdown baseline", exact: true })).toBeVisible();
			await expect(sources.getByRole("button", { name: /^Shared playbook/ })).toHaveCount(0);
			await sources.getByRole("button", { name: "User-owned source configuration", exact: true }).click();
			await sources.getByLabel(/Team library/).check();
			await sources.getByRole("button", { name: "Save project source opt-ins", exact: true }).click();
			await sources.getByRole("button", { name: /^Shared playbook/ }).click();
			await expect(sources.getByRole("heading", { name: "Shared playbook", exact: true })).toBeVisible();
			await expect(sources.locator("script,img,iframe")).toHaveCount(0);
			await sources.getByRole("button", { name: "Inspect scoped links and tags", exact: true }).click();
			await expect(sources).toContainText("2 permitted nodes");
			await expect(sources).not.toContainText("other-project/private.md");
			await sources.getByRole("button", { name: "Rediscover references", exact: true }).click();
			await expect(sources.getByRole("button", { name: /^Shared playbook/ })).toBeVisible();
			await writeFile(sharedFile, "# Changed shared playbook\nExplicit new source version.");
			await sources.getByRole("button", { name: /^Shared playbook/ }).click();
			await expect(sources).toContainText("Source changed, access was revoked");
			await sources.getByRole("button", { name: "Rediscover references", exact: true }).click();
			await sources.getByRole("button", { name: /^Changed shared playbook/ }).click();
			await expect(sources.getByRole("heading", { name: "Changed shared playbook", exact: true })).toBeVisible();
			expect(
				Object.keys((await createProjectKnowledgeStore({ homePath: home }).snapshot(workspaceId)).documents),
			).toEqual([]);
			await sources.getByRole("button", { name: "Close sources", exact: true }).click();
			await knowledge.getByRole("button", { name: "Efficiency reports", exact: true }).click();
			const report = page.getByRole("dialog", { name: /Efficiency ·/ });
			await expect(report).toContainText("$1.25");
			await expect(report).toContainText("Total estimated costUnknown");
			await expect(report).toContainText("Insufficient evidence");
			await expect(report).toContainText("6s");
			await expect(report).toContainText("10s");
			await report.getByLabel("Efficiency scope").selectOption("task");
			await report.getByLabel("Efficiency scope id").fill(taskId);
			await report.getByRole("button", { name: "Read efficiency report", exact: true }).click();
			await expect(report).toContainText("task / 1");
			await expect(report).toContainText("Unknown");
			const bounds = await report.boundingBox();
			expect(bounds?.width ?? Infinity).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
			const tasks = instance.runCli(["task", "list"]);
			expect(tasks.status, tasks.stderr).toBe(0);
			expect(JSON.parse(tasks.stdout)).toMatchObject({ count: 1, tasks: [{ column: "backlog", session: null }] });
			expect(errors).toEqual([]);
			await report.getByRole("button", { name: "Close efficiency", exact: true }).click();
			await knowledge.getByRole("button", { name: "Close", exact: true }).click();
			await instance.restartRuntime();
			await page.reload();
			await page.getByRole("button", { name: "Project knowledge", exact: true }).click();
			await knowledge.getByRole("button", { name: "Explore reference sources", exact: true }).click();
			await expect(sources.getByRole("button", { name: /^Changed shared playbook/ })).toBeVisible();
		});
	});
}
