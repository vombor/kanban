import { devices, type Page } from "@playwright/test";
import { isHomeAgentSessionId } from "../../../src/core/home-agent-session";
import { expect, test } from "../shared-chrome";
import { type DevInstance, startDevInstance } from "./dev-instance";

// The orchestrator sidebar after a Kanban restart, on a phone (the config's
// Pixel 7) and on a desktop. The runtime runs like the pod's
// (--skip-shutdown-cleanup): its stop leaves the sidebar's summary as it was,
// "awaiting_review" with the dead pid once the orchestrator waits for the
// user. The new server marks that summary interrupted and the browser starts
// the sidebar again on the mark; before, the open tab's sidebar stayed blank
// (2026-10-12 09:24:50Z restart).

// A stand-in for the orchestrator's agent CLI (launched as `claude`): a banner
// naming its pid, then the end of its first turn through Kanban's Stop hook, as
// Claude Code does once it waits for the user (the session goes to Review).
const FAKE_AGENT = `#!/usr/bin/env node
const { execSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
process.stdout.write("ORCH " + process.pid + "\\r\\n");
const settingsIndex = process.argv.indexOf("--settings");
if (settingsIndex > 0) {
	const settings = JSON.parse(readFileSync(process.argv[settingsIndex + 1], "utf8"));
	const command = settings.hooks?.Stop?.[0]?.hooks?.[0]?.command;
	if (command) {
		execSync(command, { input: JSON.stringify({ hook_event_name: "Stop" }), stdio: ["pipe", "ignore", "ignore"] });
	}
}
process.stdin.resume();
`;

const BANNER_PATTERN = /ORCH (\d+)/;

// No WebGL: xterm falls back to its DOM renderer, so the screen can be read.
test.use({ disableWebGL: true });

let instance: DevInstance;

test.beforeAll(async () => {
	instance = await startDevInstance({
		fakeCommands: { claude: FAKE_AGENT },
		globalConfig: { home: 1, selectedAgentId: "claude" },
		runtimeArgs: ["--skip-shutdown-cleanup"],
	});
});

test.afterAll(async () => {
	await instance?.stop();
});

// The sidebar session's state as its terminal's control socket last reported it.
function followSidebarState(page: Page): { state: string | null } {
	const latest: { state: string | null } = { state: null };
	page.on("websocket", (socket) => {
		const url = new URL(socket.url());
		if (
			!url.pathname.endsWith("/api/terminal/control") ||
			!isHomeAgentSessionId(url.searchParams.get("taskId") ?? "")
		) {
			return;
		}
		socket.on("framereceived", (frame) => {
			if (typeof frame.payload !== "string") {
				return;
			}
			const message = JSON.parse(frame.payload) as { type?: string; summary?: { state?: string } };
			if (message.type === "state" && message.summary?.state) {
				latest.state = message.summary.state;
			}
		});
	});
	return latest;
}

// On a phone the sidebar is a layer the top bar opens.
async function showSidebar(page: Page, isPhone: boolean): Promise<void> {
	if (!isPhone) {
		return;
	}
	const visibleTerminal = page.locator(".kb-terminal-container").filter({ visible: true });
	await expect(async () => {
		if ((await visibleTerminal.count()) === 0) {
			await page.getByRole("button", { name: "Toggle sidebar" }).click({ timeout: 1_000 });
		}
		await expect(visibleTerminal.first()).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
}

// The agent pid in the banner on the sidebar's screen (other than `notPid`).
async function sidebarScreenPid(page: Page, notPid?: string): Promise<string> {
	let pid = "";
	await expect(async () => {
		const rows = await page.locator(".xterm-rows").filter({ visible: true }).allInnerTexts();
		pid = BANNER_PATTERN.exec(rows.join("\n"))?.[1] ?? "";
		expect(pid).not.toBe("");
		expect(pid).not.toBe(notPid);
	}).toPass({ timeout: 30_000 });
	return pid;
}

const { defaultBrowserType: _desktopBrowserType, ...desktopChrome } = devices["Desktop Chrome"];

for (const profile of ["phone", "desktop"] as const) {
	test.describe(profile, () => {
		if (profile === "desktop") {
			test.use({ ...desktopChrome, viewport: { width: 1400, height: 900 } });
		}

		for (const reload of [false, true]) {
			test(`the sidebar shows its agent after a restart (${reload ? "page reloaded" : "tab kept open"})`, async ({
				page,
			}) => {
				await page.addInitScript(() => {
					window.localStorage.setItem("kanban.onboarding.dialog.shown", "true");
				});
				const sidebar = followSidebarState(page);
				await page.goto(instance.baseUrl);
				await showSidebar(page, profile === "phone");
				const firstPid = await sidebarScreenPid(page);
				// The orchestrator waits for the user, as it does between turns.
				await expect.poll(() => sidebar.state, { timeout: 15_000 }).toBe("awaiting_review");

				await instance.restartRuntime();
				if (reload) {
					await page.reload();
				}
				// A phone closes the sidebar layer while the runtime is away.
				await showSidebar(page, profile === "phone");
				// A new process on screen, with no (further) reload.
				await sidebarScreenPid(page, firstPid);
			});
		}
	});
}
