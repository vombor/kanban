import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { devices } from "@playwright/test";
import { z } from "zod";
import { objectiveReadResponseSchema, objectiveSchema } from "../../../src/core/objective-contract";
import { expect, test } from "../shared-chrome";
import { type DevInstance, startDevInstance } from "./dev-instance";

const FAKE_AGENT = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("fake 1.0"); process.exit(0); }
process.stdout.write("ISOLATED OBJECTIVE TEST STUB\\r\\n");
process.stdin.resume();
`;
const { defaultBrowserType: _browserType, ...desktop } = devices["Desktop Chrome"];
for (const profile of ["phone", "desktop"] as const) {
	test.describe(profile, () => {
		if (profile === "desktop") test.use({ ...desktop, viewport: { width: 1400, height: 900 } });
		let instance: DevInstance, objectiveId: string, taskId: string;
		const cli = (args: string[]) => {
			const result = instance.runCli(args);
			expect(result.status, result.stderr).toBe(0);
			return JSON.parse(result.stdout) as unknown;
		};
		test.beforeAll(async () => {
			instance = await startDevInstance({
				fakeCommands: { claude: FAKE_AGENT },
				globalConfig: { home: 1, selectedAgentId: "claude" },
			});
			const { task } = z
				.object({ ok: z.literal(true), task: z.object({ id: z.string() }) })
				.parse(
					cli(["task", "create", "--title", "Objective fixture task", "--prompt", "Reference only; do not start"]),
				);
			taskId = task.id;
			const file = join(instance.rootDir, "requirements.md");
			writeFileSync(file, "Owned objective acceptance <script>not HTML</script>\nNo models or benchmark reruns.");
			const objective = objectiveSchema.parse(
				cli(["objective", "create", "Owned objective fixture", "--file", file, "--task", task.id, "--json"]),
			);
			objectiveId = objective.id;
		});
		test.afterAll(async () => {
			await instance?.stop();
		});
		test("shows pinned owner facts and rechecks without starting work, including after runtime restart", async ({
			page,
		}) => {
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.goto(instance.baseUrl);
			await page.getByRole("button", { name: "Project objectives", exact: true }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByRole("button", { name: /Owned objective fixture/ }).click();
			await expect(dialog).toContainText("Report mode — Kanban admission controls available");
			await expect(dialog).toContainText("Owned objective acceptance <script>not HTML</script>");
			await expect(dialog).toContainText("Total estimated cost");
			await expect(dialog).toContainText("Unknown");
			await expect(dialog.locator("script")).toHaveCount(0);
			await dialog.getByRole("button", { name: "Recheck retained facts", exact: true }).click();
			await expect(dialog.getByRole("button", { name: "Recheck retained facts", exact: true })).toBeEnabled();
			let retained = objectiveReadResponseSchema.parse(cli(["objective", "read", objectiveId, "--json"]));
			expect(retained.objective.attempts).toEqual([]);
			expect(retained.objective.reservations).toEqual([]);
			expect(retained.objective.status).not.toBe("completed");
			await dialog.locator("summary").filter({ hasText: "User-owned controls and explicit lineage" }).click();
			await dialog
				.getByLabel("Control audit reason")
				.fill("Pause future admissions; preserve active tools and acceptance");
			await dialog.getByRole("button", { name: "Pause Kanban admission", exact: true }).click();
			await expect(dialog).toContainText("Kanban admission paused by user");
			const refused = instance.runCli(["task", "start", "--task-id", taskId]);
			expect(`${refused.stdout}\n${refused.stderr}`).toContain("user_paused");
			await dialog
				.getByLabel("Control audit reason")
				.fill("Resume admission eligibility only; do not replay an uncertain turn");
			await dialog.getByRole("button", { name: "Resume Kanban admission", exact: true }).click();
			await expect(dialog).toContainText("Report mode — Kanban admission controls available");
			retained = objectiveReadResponseSchema.parse(cli(["objective", "read", objectiveId, "--json"]));
			expect(retained.objective.controls.map((row) => row.action)).toEqual(["pause", "resume"]);
			expect(retained.objective.attempts).toEqual([]);
			expect(retained.objective.reservations).toEqual([]);
			await dialog.getByRole("button", { name: "Close", exact: true }).click();
			await instance.restartRuntime();
			await page.reload();
			await page.getByRole("button", { name: "Project objectives", exact: true }).click();
			await dialog.getByRole("button", { name: /Owned objective fixture/ }).click();
			await expect(dialog).toContainText(retained.objective.requirementsHash);
			await expect(dialog).toContainText("No qualified final commit recorded");
			retained = objectiveReadResponseSchema.parse(cli(["objective", "read", objectiveId, "--json"]));
			expect(retained.objective.attempts).toEqual([]);
			expect(retained.objective.reservations).toEqual([]);
			const bounds = await dialog.boundingBox();
			expect(bounds).not.toBeNull();
			expect(bounds?.width ?? Infinity).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
			expect(errors).toEqual([]);
		});
	});
}
