import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { devices } from "@playwright/test";
import { createProjectKnowledgeStore, type ProjectKnowledgeStore } from "../../../src/knowledge/knowledge-store";
import type { KnowledgeMetadata } from "../../../src/trpc/knowledge-contract";
import { expect, test } from "../shared-chrome";
import { type DevInstance, startDevInstance } from "./dev-instance";

const FAKE_AGENT = `#!/usr/bin/env node
if(process.argv.includes('--version')) { console.log('fake 1.0'); process.exit(0); }
process.stdout.write('OWNED KNOWLEDGE FIXTURE - NO MODEL\\r\\n'); process.stdin.resume();
`;
const { defaultBrowserType: _browserType, ...desktop } = devices["Desktop Chrome"];
for (const profile of ["phone", "desktop"] as const) {
	test.describe(profile, () => {
		test.use({ actionTimeout: 10000 });
		if (profile === "desktop") test.use({ ...desktop, viewport: { width: 1400, height: 900 } });
		let instance: DevInstance, store: ProjectKnowledgeStore, workspaceId: string, previousRevision: string;
		const metadata: KnowledgeMetadata = {
			id: "api-contract",
			kind: "contract",
			title: "API guide",
			summary: "Reviewed cursor shape",
			tags: ["api"],
			sources: [
				{ kind: "task", taskId: "ownedfixture" },
				{ kind: "url", url: "https://docs.example.invalid/api" },
			],
		};
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
				"Unstarted knowledge fixture",
				"--prompt",
				"Reference-only validation; never start this card.",
			]);
			expect(created.status, created.stderr).toBe(0);
			const homePath = join(instance.rootDir, "kanban-home"),
				entries = (await readdir(join(homePath, "workspaces"), { withFileTypes: true })).filter((entry) =>
					entry.isDirectory(),
				);
			if (entries.length !== 1 || !entries[0]) throw new Error("Expected one owned workspace");
			workspaceId = entries[0].name;
			store = createProjectKnowledgeStore({ homePath });
			const hostile = `# API Contract v1\n\n**Reviewed cursor pagination**\n\n<script>fetch('/api/knowledge-attack')</script>\n\n![tracking](https://example.invalid/knowledge-pixel.png)\n[unsafe](javascript:alert%281%29) [relative](/api/knowledge-attack) [same](${instance.baseUrl}/api/knowledge-attack) [docs](https://docs.example.invalid/guide)\n\n## Response shape\nReturn an opaque cursor.\n`;
			const first = await store.mutate(
				workspaceId,
				{ kind: "user" },
				{
					action: "publish",
					requestId: randomUUID(),
					document: metadata,
					markdown: hostile,
					expectedRevision: null,
				},
			);
			if (first.kind !== "document") throw new Error("No document");
			const pinned = await store.mutate(
				workspaceId,
				{ kind: "user" },
				{
					action: "pin",
					requestId: randomUUID(),
					id: metadata.id,
					expectedRevision: first.document.revision,
					pinned: true,
				},
			);
			if (pinned.kind !== "document") throw new Error("No pin");
			previousRevision = pinned.document.revision;
			await store.mutate(
				workspaceId,
				{ kind: "session", role: "card", taskId: "owned-proposer" },
				{
					action: "propose",
					requestId: randomUUID(),
					document: metadata,
					markdown:
						"# API Contract v2\n\nReviewed stable cursor response.\n\n## Response shape\nPreserve cursor behavior.\n",
					expectedRevision: previousRevision,
					reason: "Clarify the response without changing task acceptance",
				},
			);
			await store
				.mutate(
					workspaceId,
					{ kind: "user" },
					{
						action: "publish",
						requestId: randomUUID(),
						document: { ...metadata, id: "stale", title: "Stale guide" },
						markdown: "# Old reference\nOriginal.",
						expectedRevision: null,
					},
				)
				.then(async (first) => {
					if (first.kind !== "document") throw new Error("No base");
					await store.mutate(
						workspaceId,
						{ kind: "session", role: "card", taskId: "owned-proposer" },
						{
							action: "propose",
							requestId: randomUUID(),
							document: { ...metadata, id: "stale", title: "Stale guide" },
							markdown: "# Stale proposal\nMust not silently rebase.",
							expectedRevision: first.document.revision,
							reason: "Stale test fixture",
						},
					);
					await store.mutate(
						workspaceId,
						{ kind: "user" },
						{
							action: "publish",
							requestId: randomUUID(),
							document: { ...metadata, id: "stale", title: "Stale guide" },
							markdown: "# Changed current reference",
							expectedRevision: first.document.revision,
						},
					);
				});
			await store.mutate(
				workspaceId,
				{ kind: "session", role: "card", taskId: "owned-proposer" },
				{
					action: "propose",
					requestId: randomUUID(),
					document: { ...metadata, id: "new-runbook", title: "New runbook", kind: "runbook" },
					markdown: "# New reviewed runbook\nReference only, not approval.",
					expectedRevision: null,
					reason: "Document a newly discovered procedure",
				},
			);
			for (let n = 0; n < 21; n++)
				await store.mutate(
					workspaceId,
					{ kind: "user" },
					{
						action: "publish",
						requestId: randomUUID(),
						document: {
							...metadata,
							id: `reference-${String(n).padStart(2, "0")}`,
							title: `Reference ${n}`,
							kind: "runbook",
						},
						markdown: `# Reference ${n}\nOwned discoverable reference.`,
						expectedRevision: null,
					},
				);
		});
		test.afterAll(async () => {
			await instance?.stop();
		});
		test("browses revisions safely and confirms proposal curation and user pins without changing tasks", async ({
			page,
		}) => {
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			const errors: string[] = [],
				unwanted: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("request", (request) => {
				if (request.url().includes("knowledge-attack") || request.url().includes("knowledge-pixel"))
					unwanted.push(request.url());
			});
			await page.goto(instance.baseUrl);
			await page.getByRole("button", { name: "Project knowledge", exact: true }).click();
			const dialog = page.getByRole("dialog");
			await expect(dialog).toContainText("23 documents");
			await dialog.getByRole("button", { name: /^API guide/ }).click();
			await expect(dialog.getByRole("heading", { name: "API Contract v1", exact: true })).toBeVisible();
			await expect(dialog.locator("article")).toContainText("User-pinned decision");
			await expect(dialog.locator("article img, article script, article iframe")).toHaveCount(0);
			await expect(
				dialog.locator(
					'article a[href^="javascript:"], article a[href^="/api"], article a[href*="knowledge-attack"]',
				),
			).toHaveCount(0);
			await dialog.getByLabel("Read section").selectOption("response-shape");
			await expect(dialog.locator("article")).toContainText("Return an opaque cursor");
			await dialog.getByRole("button", { name: "Next results", exact: true }).click();
			await expect(dialog).toContainText("Reference 20");
			await dialog.getByRole("button", { name: "Previous results", exact: true }).click();
			await dialog.getByLabel("Search knowledge").fill("opaque cursor");
			await dialog.getByRole("button", { name: "Search", exact: true }).click();
			await expect(dialog).toContainText("1 documents");
			await dialog.getByRole("button", { name: "Proposals", exact: true }).click();
			await dialog.getByRole("button", { name: /^API guide/ }).click();
			await expect(dialog.locator("article")).toContainText("Reviewed stable cursor response");
			await dialog.locator("summary").filter({ hasText: "Compare proposal with its exact base" }).click();
			await expect(dialog.getByLabel("Proposal slice diff")).toContainText("API Contract v1");
			await dialog.getByRole("button", { name: "Publish proposal", exact: true }).click();
			const before = (await store.snapshot(workspaceId)).documents[metadata.id]?.at(-1);
			expect(before?.revision).toBe(previousRevision);
			await dialog.getByRole("button", { name: "Confirm publish proposal", exact: true }).click();
			await expect(dialog).toContainText("Curation confirmed");
			await dialog.getByLabel("Proposal status").selectOption("published");
			await dialog.getByRole("button", { name: /^API guide/ }).click();
			await expect(dialog.locator("article")).toContainText("published");
			await dialog.getByLabel("Proposal status").selectOption("pending");
			await dialog.getByRole("button", { name: /^Stale guide/ }).click();
			await expect(dialog).toContainText("Stale proposal: publication is disabled");
			await expect(dialog.getByRole("button", { name: "Publish proposal", exact: true })).toHaveCount(0);
			await dialog.getByRole("button", { name: "Reject proposal", exact: true }).click();
			await dialog.getByRole("button", { name: "Confirm reject proposal", exact: true }).click();
			await expect(dialog).toContainText("Curation confirmed");
			await dialog.getByRole("button", { name: /^New runbook/ }).click();
			await expect(dialog.locator("article")).toContainText("current no published document");
			await dialog.getByRole("button", { name: "Publish proposal", exact: true }).click();
			await dialog.getByRole("button", { name: "Confirm publish proposal", exact: true }).click();
			await expect(dialog).toContainText("No pending proposals");
			await dialog.getByRole("button", { name: "Documents", exact: true }).click();
			await dialog.getByLabel("Search knowledge").fill("");
			await dialog.getByRole("button", { name: "Search", exact: true }).click();
			await dialog.getByRole("button", { name: /^API guide/ }).click();
			await expect(dialog.getByRole("heading", { name: "API Contract v2", exact: true })).toBeVisible();
			const tasks = instance.runCli(["task", "list"]);
			expect(tasks.status, tasks.stderr).toBe(0);
			expect(JSON.parse(tasks.stdout)).toMatchObject({ count: 1, tasks: [{ column: "backlog", session: null }] });
			await dialog.locator("summary").filter({ hasText: "Published revision history" }).click();
			await dialog.getByRole("button", { name: new RegExp(`^${previousRevision.slice(0, 12)}`) }).click();
			await expect(dialog).toContainText("Historical revision — not current");
			await expect(dialog.getByRole("heading", { name: "API Contract v1", exact: true })).toBeVisible();
			await dialog.getByRole("button", { name: "Reload knowledge", exact: true }).click();
			await dialog.getByRole("button", { name: /^API guide/ }).click();
			await dialog.getByRole("button", { name: "Unpin decision", exact: true }).click();
			await dialog.getByRole("button", { name: "Confirm unpin decision", exact: true }).click();
			await expect(dialog).toContainText("Curation confirmed");
			const retained = (await store.snapshot(workspaceId)).documents[metadata.id];
			expect(retained).toHaveLength(4);
			expect(retained?.at(-1)?.pinnedByUser).toBe(false);
			const bounds = await dialog.boundingBox();
			expect(bounds?.width ?? Infinity).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
			expect(unwanted).toEqual([]);
			expect(errors).toEqual([]);
			await dialog.getByRole("button", { name: "Close", exact: true }).click();
			await instance.restartRuntime();
			await page.reload();
			await page.getByRole("button", { name: "Project knowledge", exact: true }).click();
			await dialog.getByRole("button", { name: /^API guide/ }).click();
			await expect(dialog.getByRole("heading", { name: "API Contract v2", exact: true })).toBeVisible();
		});
	});
}
