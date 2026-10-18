import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devices } from "@playwright/test";
import { z } from "zod";
import { runtimeBoardDataSchema } from "../../../src/core/api-contract";
import { createProjectKnowledgeStore } from "../../../src/knowledge/knowledge-store";
import { createPlanBundleStore } from "../../../src/knowledge/plan-bundle-store";
import { createTaskContextStore } from "../../../src/knowledge/task-context-store";
import { planBreakdownSchema } from "../../../src/plans/plan-breakdown";
import { createPlanIndexStore } from "../../../src/plans/plan-index";
import { getPlanIndexPath } from "../../../src/state/kanban-home";
import { expect, test } from "../shared-chrome";
import { type DevInstance, startDevInstance } from "./dev-instance";

const FAKE_AGENT = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("fake 1.0"); process.exit(0); }
process.stdout.write("OWNED PLAN REFERENCE FIXTURE - NO MODEL\\r\\n");
process.stdin.resume();
`;
const { defaultBrowserType: _browserType, ...desktop } = devices["Desktop Chrome"];
for (const profile of ["phone", "desktop"] as const) {
	test.describe(profile, () => {
		if (profile === "desktop") test.use({ ...desktop, viewport: { width: 1400, height: 900 } });
		let instance: DevInstance, taskId: string, contextRevision: string;
		test.beforeAll(async () => {
			instance = await startDevInstance({
				fakeCommands: { claude: FAKE_AGENT },
				globalConfig: { selectedAgentId: "claude" },
				runtimeArgs: ["--skip-shutdown-cleanup"],
			});
			const created = instance.runCli([
				"task",
				"create",
				"--title",
				"Owned plan handoff fixture",
				"--prompt",
				"Reference-only fixture. Never call a real model.",
			]);
			expect(created.status, created.stderr).toBe(0);
			taskId = z.object({ task: z.object({ id: z.string() }) }).parse(JSON.parse(created.stdout)).task.id;
			const homePath = join(instance.rootDir, "kanban-home");
			const workspaceDirectories = (await readdir(join(homePath, "workspaces"), { withFileTypes: true })).filter(
				(entry) => entry.isDirectory(),
			);
			if (workspaceDirectories.length !== 1) throw new Error("Expected exactly one owned fixture workspace");
			const workspaceId = workspaceDirectories[0]?.name;
			if (!workspaceId) throw new Error("Owned workspace id missing");
			const knowledge = createProjectKnowledgeStore({ homePath });
			const published = await knowledge.mutate(
				workspaceId,
				{ kind: "user" },
				{
					action: "publish",
					requestId: randomUUID(),
					expectedRevision: null,
					document: { id: "api", title: "Reviewed API", kind: "contract", summary: "", tags: [], sources: [] },
					markdown: "# API\nPinned reviewed response.",
				},
			);
			if (published.kind !== "document") throw new Error("Expected document");
			const bundles = createPlanBundleStore({ homePath, knowledge });
			const breakdown = planBreakdownSchema.parse({
				version: 1,
				slug: "fixture",
				knowledgeReferences: [{ id: "api", revision: published.document.revision }],
				cards: [
					{
						id: "implementation",
						title: "Owned implementation fixture",
						prompt: "Read and check this owned reference fixture.",
						acceptanceCriteria: ["No real model run"],
					},
				],
			});
			const bundle = await bundles.persist(
				workspaceId,
				await bundles.prepare(workspaceId, {
					planTaskId: "planfixture",
					slug: "fixture",
					specPath: "docs/specs/fixture.md",
					breakdownPath: "docs/specs/fixture.cards.json",
					spec: `# Retained reviewed spec\n<script>literal reference, never HTML</script>\n${"Owned bounded content. ".repeat(400)}`,
					breakdown,
					breakdownText: JSON.stringify(breakdown),
				}),
			);
			const index = createPlanIndexStore({ getPath: (id) => getPlanIndexPath(id, homePath) });
			// Disposable fixture provenance, not a live plan action or an approval inferred from publication.
			await index.update(workspaceId, (current) => ({
				...current,
				plans: {
					planfixture: {
						taskId: "planfixture",
						slug: "fixture",
						title: "Fixture",
						kit: "team",
						agentId: "claude",
						providerId: null,
						modelId: null,
						startInPlanMode: true,
						createdAt: new Date().toISOString(),
						approval: {
							at: new Date().toISOString(),
							via: "approve",
							breakdownSha256: bundle.breakdown.contentHash,
							bundleRevision: bundle.revision,
						},
						expansion: {
							status: "done",
							startedAt: new Date().toISOString(),
							finishedAt: new Date().toISOString(),
							breakdownSha256: bundle.breakdown.contentHash,
							bundleRevision: bundle.revision,
							cards: { implementation: taskId },
							links: [],
						},
						metrics: null,
					},
				},
			}));
			const contexts = createTaskContextStore({ homePath, bundles, index });
			await contexts.attachExpansion(workspaceId, "planfixture");
			contextRevision = (await contexts.read(workspaceId, taskId))?.revision ?? "";
			await knowledge.mutate(
				workspaceId,
				{ kind: "user" },
				{
					action: "publish",
					requestId: randomUUID(),
					expectedRevision: published.document.revision,
					document: { id: "api", title: "Reviewed API", kind: "contract", summary: "", tags: [], sources: [] },
					markdown: "# API\nFuture incompatible response.",
				},
			);
			const boardPath = join(homePath, "workspaces", workspaceId, "board.json");
			const board = runtimeBoardDataSchema.parse(JSON.parse(await readFile(boardPath, "utf8")));
			const card = board.columns.flatMap((column) => column.cards).find((item) => item.id === taskId);
			if (!card) throw new Error("Fixture card missing");
			for (const column of board.columns) column.cards = column.cards.filter((item) => item.id !== taskId);
			board.columns.find((column) => column.id === "backlog")?.cards.push(card);
			await writeFile(boardPath, JSON.stringify(board));
		});
		test.afterAll(async () => {
			await instance?.stop();
		});
		test("reads pinned content, explicitly adopts only a reviewed reference before start, and preserves history across restart", async ({
			page,
		}) => {
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.goto(instance.baseUrl);
			await page.locator(`[data-task-id="${taskId}"]`).first().click();
			await page.getByRole("button", { name: "Plan context", exact: true }).click();
			const dialog = page.getByRole("dialog");
			await expect(dialog).toContainText(contextRevision);
			await expect(dialog).toContainText("Revision drift: api");
			await expect(dialog.locator("pre")).toHaveCount(0);
			await dialog.getByRole("button", { name: "Read retained spec", exact: true }).click();
			await expect(dialog.locator("pre")).toContainText("Retained reviewed spec");
			await expect(dialog.locator("pre")).toContainText("<script>literal reference, never HTML</script>");
			await expect(dialog.locator("script")).toHaveCount(0);
			await expect(dialog.getByRole("button", { name: "Read next slice", exact: true })).toBeVisible();
			await dialog.getByRole("button", { name: "Read api", exact: true }).click();
			await expect(dialog.locator("pre")).toContainText("Pinned reviewed response");
			await expect(dialog.locator("pre")).not.toContainText("Future incompatible");
			await dialog.getByRole("button", { name: "Review replacement api", exact: true }).click();
			await expect(dialog.locator("section pre")).toContainText("Future incompatible response");
			await expect(dialog.getByRole("button", { name: "Adopt reviewed reference", exact: true })).toBeDisabled();
			await dialog
				.getByLabel("Reference adoption reason")
				.fill("Explicit fixture review: replace reference only, approved requirements unchanged");
			await dialog.getByRole("button", { name: "Adopt reviewed reference", exact: true }).click();
			await expect(dialog).toContainText("User adoption");
			await expect(dialog).toContainText("Original plan approval unchanged");
			await dialog.getByRole("button", { name: "Read previous reference", exact: true }).click();
			await expect(dialog.locator("pre")).toContainText("Pinned reviewed response");
			await dialog.getByRole("button", { name: "Read api", exact: true }).click();
			await expect(dialog.locator("pre")).toContainText("Future incompatible response");
			const retained = instance.runCli(["knowledge", "task-context", taskId, "--json"]);
			expect(retained.status, retained.stderr).toBe(0);
			const adopted = z
				.object({
					context: z.object({ revision: z.string(), bundleRevision: z.string() }),
					history: z.array(z.unknown()),
					canAdopt: z.boolean(),
					startReservation: z.null(),
				})
				.parse(JSON.parse(retained.stdout));
			expect(adopted.history).toHaveLength(2);
			expect(adopted.context.revision).not.toBe(contextRevision);
			contextRevision = adopted.context.revision;
			const bounds = await dialog.boundingBox();
			expect(bounds?.width ?? Infinity).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
			await page.keyboard.press("Escape");
			await instance.restartRuntime();
			await page.reload();
			await page.locator(`[data-task-id="${taskId}"]`).first().click();
			await page.getByRole("button", { name: "Plan context", exact: true }).click();
			await expect(dialog).toContainText(contextRevision);
			await expect(dialog).toContainText("User adoption");
			await page.keyboard.press("Escape");
			const started = instance.runCli(["task", "start", "--task-id", taskId]);
			expect(started.status, started.stderr).toBe(0);
			expect(JSON.parse(started.stdout)).toMatchObject({ ok: true });
			const frozen = instance.runCli(["knowledge", "task-context", taskId, "--json"]);
			expect(JSON.parse(frozen.stdout)).toMatchObject({ canAdopt: false, startReservation: { contextRevision } });
			expect(errors).toEqual([]);
		});
	});
}
