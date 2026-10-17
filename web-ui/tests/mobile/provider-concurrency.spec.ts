import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "../shared-chrome";
import { type DevInstance, startDevInstance } from "./dev-instance";

test.describe("persistent provider pacing (#53)", () => {
	let instance: DevInstance;
	test.beforeAll(async () => {
		const fake =
			'#!/usr/bin/env node\nif(process.argv.includes("--help")||process.argv.includes("--version")){console.log("fake agent test 1.0");process.exit(0);}console.log("isolated test agent running");setInterval(()=>{},1000);process.stdin.resume();\n';
		instance = await startDevInstance({
			// Droid discovers choices through --help, so a fake CLI never boots a real SDK metadata host.
			globalConfig: { home: 1, selectedAgentId: "droid", providerConcurrency: { "cline-pass": 1 } },
			fakeCommands: { cline: fake, droid: fake },
		});
	});
	test.afterAll(async () => {
		await instance?.stop();
	});
	test("queues instead of launching, survives restart, cancels safely and supports one global Save", async ({
		page,
	}, testInfo) => {
		page.on("pageerror", (error) => {
			void testInfo.attach("page-error", { body: error.message, contentType: "text/plain" });
		});
		await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
		await page.goto(instance.baseUrl);
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		const dialog = page.getByRole("dialog");
		const select = dialog.getByRole("combobox", { name: "cline-pass maximum active turns", exact: true });
		await expect(select).toHaveValue("1");
		await select.selectOption("2");
		await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
		await dialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		const configPath = join(instance.rootDir, "kanban-home", "config.json");
		expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
			providerConcurrency: { "cline-pass": 2 },
		});
		const set = instance.runCli(["config", "set", "providerConcurrency.cline-pass", "1"]);
		expect(set.status).toBe(0);
		const create = (title: string) => {
			const result = instance.runCli([
				"task",
				"create",
				"--title",
				title,
				"--prompt",
				"Read-only fake task",
				"--agent-id",
				"cline",
				"--provider",
				"cline-pass",
				"--model",
				"fake-test",
				"--auto-review-enabled",
				"false",
			]);
			expect(result.status, result.stderr).toBe(0);
			return JSON.parse(result.stdout) as { task: { id: string } };
		};
		const a = create("Pacing A").task.id,
			b = create("Pacing B").task.id;
		const startA = instance.runCli(["task", "start", "--task-id", a]);
		expect(startA.status, startA.stderr).toBe(0);
		const startB = instance.runCli(["task", "start", "--task-id", b]);
		expect(startB.status, startB.stderr).toBe(0);
		expect(JSON.parse(startB.stdout)).toMatchObject({ ok: true, queued: true });
		const status = () => {
			const result = instance.runCli(["pipeline", "provider-status", "--json"]);
			expect(result.status, result.stderr).toBe(0);
			return JSON.parse(result.stdout) as { queued: Array<{ taskId: string }>; holders: Array<{ taskId: string }> };
		};
		expect(status().queued.map((intent) => intent.taskId)).toContain(b);
		expect(status().holders.some((holder) => holder.taskId === a)).toBe(true);
		expect(status().holders.some((holder) => holder.taskId === b)).toBe(false);
		// The shutdown ends the first fake process; the durable queued start is reconciled on the same home/port.
		await instance.restartRuntime();
		await expect.poll(() => status().queued.some((intent) => intent.taskId === b)).toBe(false);
		expect(status().holders.some((holder) => holder.taskId === b)).toBe(true);
		const c = create("Pacing C").task.id;
		expect(JSON.parse(instance.runCli(["task", "start", "--task-id", c]).stdout)).toMatchObject({ queued: true });
		const done = instance.runCli(["task", "done", "--task-id", c, "--discard"]);
		expect(done.status, done.stderr).toBe(0);
		await expect.poll(() => status().queued.some((intent) => intent.taskId === c)).toBe(false);
		expect(status().holders.some((holder) => holder.taskId === c)).toBe(false);
	});
});
