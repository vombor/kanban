import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devices } from "@playwright/test";

import { verifyQaToolchain } from "../../../src/pipeline/qa-toolchain";
import { expect, test } from "../shared-chrome";
import { type DevInstance, startDevInstance } from "./dev-instance";

const FAKE_AGENT = `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
if(process.argv.includes('--help')||process.argv.includes('--version')){console.log('fake metadata 1.0');process.exit(0);}
if(process.argv.join(' ').includes('HISTORY_FIXTURE')){
 const file=path.join(process.cwd(),'history-fixture-run-count');
 const run=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8'))+1:1;
 fs.writeFileSync(file,String(run));
 for(let i=0;i<20000;i++)process.stdout.write('\\x1b[31mHISTORY_RUN_'+run+'_LINE_'+i+' '+('long🙂'.repeat(30))+'\\x1b[0m\\r\\n');
 setInterval(()=>process.stdout.write('LIVE_RUN_'+run+' prompt ready\\r\\n'),250);
}else console.log('isolated sidebar');
process.stdin.resume();
`;

test.use({ disableWebGL: true });
const { defaultBrowserType: _ignored, ...desktop } = devices["Desktop Chrome"];

for (const profile of ["phone", "desktop"] as const) {
	test.describe(profile, () => {
		if (profile === "desktop") test.use({ ...desktop, viewport: { width: 1400, height: 900 } });
		let instance: DevInstance;
		test.beforeAll(async () => {
			instance = await startDevInstance({
				fakeCommands: { droid: FAKE_AGENT },
				runtimeArgs: ["--skip-shutdown-cleanup"],
				globalConfig: {
					home: 1,
					selectedAgentId: "droid",
					watchdog: { mode: "off" },
					pipeline: { recovery: { mode: "off" } },
				},
			});
		});
		test.afterAll(async () => {
			await instance?.stop();
		});
		test("keeps large history responsive, pages older output and preserves archives across restart/resume", async ({
			page,
		}, testInfo) => {
			const create = instance.runCli([
				"task",
				"create",
				"--title",
				"Large terminal fixture",
				"--prompt",
				"HISTORY_FIXTURE",
				"--agent-id",
				"droid",
				"--auto-review-enabled",
				"false",
			]);
			expect(create.status, create.stderr).toBe(0);
			const id = (JSON.parse(create.stdout) as { task: { id: string } }).task.id;
			expect(instance.runCli(["task", "start", "--task-id", id]).status).toBe(0);
			const hash = `${createHash("sha256").update(id).digest("hex")}.log`;
			const data = join(instance.rootDir, "kanban-home/data");
			const archive = () =>
				readdirSync(data, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => join(data, entry.name, "terminal-output", hash))
					.find((file) => existsSync(file));
			await expect
				.poll(
					() => {
						const file = archive();
						return file ? readFileSync(file, "utf8").includes("LIVE_RUN_1") : false;
					},
					{ timeout: 30000 },
				)
				.toBe(true);
			const before = readFileSync(archive() ?? "", "utf8");
			expect(before).toContain("HISTORY_RUN_1_LINE_0");
			expect(before.length).toBeGreaterThan(3 * 1024 * 1024);
			const restores: string[] = [];
			const frameSizes: number[] = [];
			page.on("websocket", (socket) => {
				const url = new URL(socket.url());
				if (url.searchParams.get("taskId") !== id) return;
				socket.on("framereceived", (frame) => {
					if (url.pathname.endsWith("/io"))
						frameSizes.push(
							typeof frame.payload === "string" ? Buffer.byteLength(frame.payload) : frame.payload.length,
						);
					else if (typeof frame.payload === "string") {
						const message = JSON.parse(frame.payload) as { type?: string; snapshot?: string };
						if (message.type === "restore") restores.push(message.snapshot ?? "");
					}
				});
			});
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			await page.goto(instance.baseUrl);
			await page.locator(`[data-task-id="${id}"]`).getByText("Large terminal fixture", { exact: true }).click();
			await expect
				.poll(
					async () => (await page.locator(".xterm-rows").filter({ visible: true }).allInnerTexts()).join("\n"),
					{ timeout: 30000 },
				)
				.toContain("LIVE_RUN_1");
			expect(restores.length).toBeGreaterThan(0);
			expect(restores.every((snapshot) => Buffer.byteLength(snapshot) <= 128 * 1024)).toBe(true);
			expect(restores.every((snapshot) => !snapshot.includes("HISTORY_RUN_1_LINE_0 "))).toBe(true);
			const historyButton = page
				.getByRole("button", { name: "Output history", exact: true })
				.filter({ visible: true })
				.last();
			await historyButton.click();
			const dialog = page.getByRole("dialog");
			await expect(dialog.getByTestId("terminal-history-page")).toContainText("LIVE_RUN_1");
			const newest = await dialog.getByTestId("terminal-history-page").textContent();
			await dialog.getByRole("button", { name: "Older output", exact: true }).click();
			await expect.poll(() => dialog.getByTestId("terminal-history-page").textContent()).not.toBe(newest);
			expect((await dialog.getByTestId("terminal-history-page").textContent())?.length).toBeLessThanOrEqual(
				64 * 1024,
			);
			await dialog.getByRole("button", { name: "Close", exact: true }).click();
			// Navigation/controls must remain usable while the agent keeps printing live output.
			await page.getByRole("button", { name: "Settings", exact: true }).click();
			await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
			await instance.restartRuntime();
			const resumed = instance.runCli(["task", "resume", id]);
			expect(resumed.status, resumed.stderr).toBe(0);
			expect(JSON.parse(resumed.stdout), resumed.stdout).toMatchObject({ ok: true });
			await expect
				.poll(
					() => {
						const file = archive();
						return file ? readFileSync(file, "utf8").includes("LIVE_RUN_2") : false;
					},
					{ timeout: 30000 },
				)
				.toBe(true);
			await page.reload();
			// The selected card survives page reload. Explicitly close/reopen it to exercise viewer detachment.
			await page.getByRole("button", { name: "Back to board", exact: true }).click();
			await page.locator(`[data-task-id="${id}"]`).getByText("Large terminal fixture", { exact: true }).click();
			await expect
				.poll(
					async () => (await page.locator(".xterm-rows").filter({ visible: true }).allInnerTexts()).join("\n"),
					{ timeout: 30000 },
				)
				.toContain("LIVE_RUN_2");
			expect(frameSizes.every((size) => size <= 16 * 1024)).toBe(true);
			expect(readFileSync(archive() ?? "", "utf8")).toContain("HISTORY_RUN_1_LINE_0");
			const proof = {
				profile,
				restores: restores.map((value) => Buffer.byteLength(value)),
				maxLiveFrameBytes: Math.max(...frameSizes),
				fullArchiveBytes: readFileSync(archive() ?? "").length,
			};
			const proofPath = testInfo.outputPath("bounded-history-proof.json");
			writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
			await testInfo.attach("bounded-history-proof", { path: proofPath, contentType: "application/json" });
		});
	});
}

test("shared Chrome readiness proves glyph ink and multiline controls at both sizes", async () => {
	const result = await verifyQaToolchain();
	expect(result.checks).toMatchObject([
		{ glyphs: true, multiline: true },
		{ glyphs: true, multiline: true },
	]);
});
