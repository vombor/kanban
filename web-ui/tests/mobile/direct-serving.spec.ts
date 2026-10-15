import { devices } from "@playwright/test";
import { WebSocket } from "ws";
import { expect, test } from "../shared-chrome";
import { type DevInstance, startDevInstance } from "./dev-instance";

const { defaultBrowserType: _browserType, ...desktop } = devices["Desktop Chrome"];
test.use({ ...desktop, viewport: { width: 1400, height: 900 } });
let instance: DevInstance;
test.beforeAll(async () => {
	instance = await startDevInstance({
		runtimeArgs: ["--host", "::", "--no-passcode"],
		fakeCommands: {
			claude: `#!/usr/bin/env node
if(process.argv.includes("--version")){console.log("fake 1.0");process.exit(0);}
process.stdin.resume();
`,
		},
		globalConfig: { home: 1, selectedAgentId: "claude" },
	});
});
test.afterAll(async () => {
	await instance?.stop();
});

async function expectStateSocketOpen(origin: string, headers?: Record<string, string>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let opened = false;
		const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/runtime/ws`, { headers });
		const timer = setTimeout(() => {
			reject(new Error("State WebSocket handshake timed out"));
			socket.terminate();
		}, 5_000);
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		socket.once("open", () => {
			opened = true;
			socket.close();
		});
		socket.once("close", () => {
			clearTimeout(timer);
			opened ? resolve() : reject(new Error("State WebSocket closed before opening"));
		});
	});
}

test("accepts localhost and a public Host/Origin on the same HTTP/state-WebSocket instance", async () => {
	for (const headers of [
		{ Host: "localhost:3484", Origin: "http://localhost:3484" },
		{ Host: "kanban.example.test", Origin: "https://kanban.example.test" },
		{ Host: "another.example.test:9443", Origin: "https://different.example.test" },
	]) {
		const response = await fetch(`${instance.runtimeUrl}/api/passcode/status`, { headers });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ required: false });
		// No permissive cross-site CORS response is necessary for page-relative browser requests.
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		await expectStateSocketOpen(instance.runtimeUrl, headers);
	}
});

test("serves IPv4, IPv6 and localhost HTTP/state sockets on the same dual-stack listener", async () => {
	for (const origin of [
		instance.runtimeUrl,
		instance.runtimeUrl.replace("127.0.0.1", "[::1]"),
		instance.runtimeUrl.replace("127.0.0.1", "localhost"),
	]) {
		const response = await fetch(`${origin}/api/passcode/status`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ required: false });
		await expectStateSocketOpen(origin);
	}
});

test("two directly served tabs follow their own page's address for API and terminal/state sockets", async ({
	context,
}) => {
	await context.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
	const origins = [
		instance.runtimeUrl,
		instance.runtimeUrl.replace("127.0.0.1", "localhost"),
		instance.runtimeUrl.replace("127.0.0.1", "[::1]"),
	];
	for (const origin of origins) {
		const page = await context.newPage();
		const socketOrigins: string[] = [];
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("websocket", (socket) => socketOrigins.push(new URL(socket.url()).host));
		await page.goto(origin);
		await expect(page.getByRole("combobox", { name: "Project", exact: true })).toContainText("demo");
		await expect.poll(() => socketOrigins.length).toBeGreaterThan(1);
		expect(socketOrigins.every((host) => host === new URL(origin).host)).toBe(true);
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(page.getByRole("dialog")).toContainText("Global Settings");
		expect(errors).toEqual([]);
	}
});
