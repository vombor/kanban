// Where the user's browser reaches Kanban (src/server/browser-origins.ts, src/core/browser-page-origin.ts), and how
// `kanban github bot create` says which origin its links use (src/commands/github.ts).
import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { formatOriginChoice } from "../../../src/commands/github";
import { normalizeBrowserPageOrigin } from "../../../src/core/browser-page-origin";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import {
	chooseBrowserOrigin,
	createBrowserOriginTracker,
	createBrowserUpgradeRecorder,
	getLocalBrowserOrigin,
	readBrowserPageOrigin,
} from "../../../src/server/browser-origins";

function upgrade(headers: Record<string, string>, query = ""): [IncomingMessage, URL] {
	return [{ headers } as unknown as IncomingMessage, new URL(`http://localhost:3485/api/terminal/io?${query}`)];
}

describe("normalizeBrowserPageOrigin", () => {
	it("keeps http(s) origins only, without a path", () => {
		expect(normalizeBrowserPageOrigin("https://pod.tail.ts.net:8443/board?x=1")).toBe("https://pod.tail.ts.net:8443");
		expect(normalizeBrowserPageOrigin("http://localhost:3485/")).toBe("http://localhost:3485");
		expect(normalizeBrowserPageOrigin("javascript:alert(1)")).toBeNull();
		expect(normalizeBrowserPageOrigin("not a url")).toBeNull();
		expect(normalizeBrowserPageOrigin("  ")).toBeNull();
		expect(normalizeBrowserPageOrigin(null)).toBeNull();
	});
});

describe("readBrowserPageOrigin", () => {
	it("reads nothing from a request without an Origin header (the CLI, scripts)", () => {
		expect(readBrowserPageOrigin(...upgrade({}, "pageOrigin=https%3A%2F%2Fevil.example"))).toBeNull();
	});

	it("takes the page's own origin first, then a proxy's forwarded host, then the Origin header", () => {
		const origin = { origin: "http://localhost:3485" };
		expect(
			readBrowserPageOrigin(
				...upgrade(
					{ ...origin, "x-forwarded-host": "proxy.example" },
					"pageOrigin=https%3A%2F%2Fpod.tail.ts.net%3A8443",
				),
			),
		).toBe("https://pod.tail.ts.net:8443");
		expect(
			readBrowserPageOrigin(
				...upgrade({ ...origin, "x-forwarded-host": "kanban.example.net", "x-forwarded-proto": "https" }),
			),
		).toBe("https://kanban.example.net");
		expect(readBrowserPageOrigin(...upgrade(origin, "pageOrigin=ftp%3A%2F%2Fx"))).toBe("http://localhost:3485");
	});
});

describe("the browser origin tracker and the choice", () => {
	it("keeps the last page and each terminal's latest viewer", () => {
		const tracker = createBrowserOriginTracker();
		expect(tracker.lastPageOrigin()).toBeNull();
		tracker.recordTerminalViewer({ workspaceId: "kanban", taskId: "t1", origin: "https://a.example/" });
		expect(tracker.lastPageOrigin()).toBe("https://a.example");
		tracker.recordTerminalViewer({ workspaceId: "kanban", taskId: "t1", origin: "https://b.example" });
		tracker.recordPage("http://localhost:3485");
		tracker.recordPage("not a url");
		expect(tracker.terminalOrigin("kanban", "t1")).toBe("https://b.example");
		expect(tracker.terminalOrigin("notes", "t1")).toBeNull();
		expect(tracker.lastPageOrigin()).toBe("http://localhost:3485");
	});

	it("chooses the requested origin, then the calling terminal's page, then the last browser, then localhost", () => {
		const tracker = createBrowserOriginTracker();
		const terminal = { workspaceId: "kanban", taskId: "__home_terminal__" };
		const choose = (requested: string | null, callingTerminal = terminal) =>
			chooseBrowserOrigin({ requested, callingTerminal, tracker, fallback: () => "http://localhost:3485" });

		expect(choose(null)).toEqual({ origin: "http://localhost:3485", source: "default" });
		tracker.recordPage("https://kanban.example.net");
		expect(choose(null)).toEqual({ origin: "https://kanban.example.net", source: "browser" });
		tracker.recordTerminalViewer({ ...terminal, origin: "https://pod.tail.ts.net:8443" });
		tracker.recordPage("http://localhost:3485");
		expect(choose(null)).toEqual({ origin: "https://pod.tail.ts.net:8443", source: "terminal" });
		expect(chooseBrowserOrigin({ requested: null, callingTerminal: null, tracker })).toEqual({
			origin: "http://localhost:3485",
			source: "browser",
		});
		expect(choose("https://other.example.org/x")).toEqual({
			origin: "https://other.example.org",
			source: "requested",
		});
	});

	it("records a browser's upgrade only when the caller is the user", async () => {
		const tracker = createBrowserOriginTracker();
		let caller: RuntimeCaller = {
			kind: "session",
			session: { workspaceId: "kanban", taskId: "t1", role: "card", agentId: "claude", cwd: "/w" },
			via: "process",
		};
		const record = createBrowserUpgradeRecorder({ tracker, resolveStrictCaller: async () => caller });
		const browser = upgrade({ origin: "http://localhost:3485" }, "pageOrigin=https%3A%2F%2Fevil.example");
		await record(...browser, { workspaceId: "kanban", taskId: "t1" });
		caller = { kind: "unknown", reason: "untraced" };
		await record(...browser, null);
		expect(tracker.lastPageOrigin()).toBeNull();

		caller = { kind: "user" };
		await record(...upgrade({}, "pageOrigin=https%3A%2F%2Fpod.example"), null);
		expect(tracker.lastPageOrigin()).toBeNull();
		await record(...upgrade({ origin: "http://localhost:3485" }, "pageOrigin=https%3A%2F%2Fpod.example"), {
			workspaceId: "kanban",
			taskId: "t1",
		});
		expect(tracker.terminalOrigin("kanban", "t1")).toBe("https://pod.example");
		expect(tracker.lastPageOrigin()).toBe("https://pod.example");
	});

	it("falls back to localhost on the runtime port", () => {
		expect(getLocalBrowserOrigin()).toMatch(/^https?:\/\/localhost:\d+$/u);
	});
});

describe("kanban github bot create's origin line", () => {
	it("names the origin, why, and how to change it", () => {
		const lines = formatOriginChoice("http://localhost:3485", "default").join("\n");
		expect(lines).toContain("Links use http://localhost:3485 (the default");
		expect(lines).toContain("--origin <url>");
		expect(lines).toContain("Settings > GitHub App");
		expect(formatOriginChoice("https://pod.example", "terminal").join("\n")).toContain(
			"the Kanban page this terminal is open in",
		);
		expect(formatOriginChoice("https://pod.example", "requested").join("\n")).not.toContain("pass --origin");
	});
});
