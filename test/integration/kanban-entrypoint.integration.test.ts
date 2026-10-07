import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTempDir } from "../utilities/temp-dir";

const ENTRYPOINT = resolve(__dirname, "../../deploy/kanban-entrypoint.sh");
// The entrypoint bounds the pre-stop hook with coreutils `timeout` (in the image and on CI's Linux runners).
const supported = process.platform === "linux" && spawnSync("timeout", ["1", "true"]).status === 0;

// Stands in for Kanban: records the signal it gets and exits with a per-signal code.
const FAKE_CHILD = `
trap 'echo "child got TERM" >> "$EVENTS"; exit 7' TERM
trap 'echo "child got INT" >> "$EVENTS"; exit 8' INT
echo "child ready" >> "$EVENTS"
while :; do sleep 0.05; done
`;

let tempDir: { path: string; cleanup: () => void };
let kitHome: string;
let events: string;
let childScript: string;
let running: ChildProcess[] = [];

interface Entrypoint {
	process: ChildProcess;
	stderr: () => string;
	exited: Promise<number | null>;
}

function startEntrypoint(args: string[], env: Record<string, string> = {}): Entrypoint {
	let stderr = "";
	// Never the real kit: KANBAN_KIT_HOME is a temp dir and no KANBAN_* setting leaks in from this machine.
	const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KANBAN_")));
	const child = spawn("sh", [ENTRYPOINT, ...args], {
		cwd: tempDir.path,
		env: { ...baseEnv, KANBAN_KIT_HOME: kitHome, EVENTS: events, ...env },
		stdio: ["ignore", "ignore", "pipe"],
	});
	running.push(child);
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	// "exit", not "close": a detached start hook may still hold the stderr pipe.
	const exited = new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)));
	return { process: child, stderr: () => stderr, exited };
}

function readEvents(): string[] {
	return existsSync(events) ? readFileSync(events, "utf8").trim().split("\n").filter(Boolean) : [];
}

async function waitForEvent(event: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!readEvents().includes(event)) {
		if (Date.now() > deadline) {
			throw new Error(`no "${event}" event; events: ${readEvents().join(", ")}`);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
}

function writeFakeKit(): void {
	mkdirSync(join(kitHome, "bin"), { recursive: true });
	const kit = join(kitHome, "bin", "kit");
	writeFileSync(kit, `#!/bin/sh\necho "kit $*" >> "$EVENTS"\necho "kit output for $*"\n`);
	chmodSync(kit, 0o755);
}

describe.skipIf(!supported).sequential("deploy/kanban-entrypoint.sh", () => {
	beforeEach(() => {
		tempDir = createTempDir("kanban-entrypoint-");
		kitHome = join(tempDir.path, "kit");
		mkdirSync(kitHome);
		events = join(tempDir.path, "events");
		childScript = join(tempDir.path, "child.sh");
		writeFileSync(childScript, FAKE_CHILD);
	});

	afterEach(() => {
		for (const child of running) {
			child.kill("SIGKILL");
		}
		running = [];
		tempDir.cleanup();
	});

	it("runs the pre-stop hook to completion, then forwards SIGTERM and exits with the child's status", async () => {
		const entry = startEntrypoint(["sh", childScript], {
			KANBAN_START_HOOK: "",
			KANBAN_PRESTOP_HOOK: 'echo "hook start" >> "$EVENTS"; sleep 0.3; echo "hook end" >> "$EVENTS"',
		});
		await waitForEvent("child ready");

		entry.process.kill("SIGTERM");

		expect(await entry.exited).toBe(7);
		expect(readEvents()).toEqual(["child ready", "hook start", "hook end", "child got TERM"]);
		expect(entry.stderr()).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ kanban-entrypoint: SIGTERM: pre-stop/u);
		expect(entry.stderr()).toContain("pre-stop hook done");
		expect(entry.stderr()).toContain("exited with status 7");
	});

	it("forwards SIGINT too (the child does not inherit an ignored SIGINT)", async () => {
		const entry = startEntrypoint(["sh", childScript], {
			KANBAN_START_HOOK: "",
			KANBAN_PRESTOP_HOOK: 'echo "hook ran" >> "$EVENTS"',
		});
		await waitForEvent("child ready");

		entry.process.kill("SIGINT");

		expect(await entry.exited).toBe(8);
		expect(readEvents()).toEqual(["child ready", "hook ran", "child got INT"]);
	});

	it("stops waiting for the pre-stop hook at the timeout and kills it", async () => {
		const entry = startEntrypoint(["sh", childScript], {
			KANBAN_START_HOOK: "",
			KANBAN_PRESTOP_HOOK: 'echo "hook start" >> "$EVENTS"; sleep 30; echo "hook end" >> "$EVENTS"',
			KANBAN_PRESTOP_TIMEOUT: "1",
		});
		await waitForEvent("child ready");
		const signalledAt = Date.now();

		entry.process.kill("SIGTERM");

		expect(await entry.exited).toBe(7);
		expect(Date.now() - signalledAt).toBeLessThan(5_000);
		expect(readEvents()).toEqual(["child ready", "hook start", "child got TERM"]);
		expect(entry.stderr()).toContain("pre-stop hook timed out after 1s");
	});

	it.each([
		["a failing hook", { KANBAN_PRESTOP_HOOK: "exit 3" }, "pre-stop hook failed (exit 3)"],
		[
			"a hook that is not a command",
			{ KANBAN_PRESTOP_HOOK: "/nonexistent/kit prepare-restart" },
			"failed (exit 127)",
		],
		["no hook and no kit", {}, "no pre-stop hook"],
		["a hook turned off", { KANBAN_PRESTOP_HOOK: "" }, "no pre-stop hook"],
	])("still stops with %s", async (_name, hookEnv, logLine) => {
		const entry = startEntrypoint(["sh", childScript], { KANBAN_START_HOOK: "", ...hookEnv });
		await waitForEvent("child ready");

		entry.process.kill("SIGTERM");

		expect(await entry.exited).toBe(7);
		expect(readEvents()).toEqual(["child ready", "child got TERM"]);
		expect(entry.stderr()).toContain(logLine);
	});

	it("a second signal during the pre-stop hook abandons it and forwards at once", async () => {
		const entry = startEntrypoint(["sh", childScript], {
			KANBAN_START_HOOK: "",
			KANBAN_PRESTOP_HOOK: 'echo "hook start" >> "$EVENTS"; sleep 30; echo "hook end" >> "$EVENTS"',
			KANBAN_PRESTOP_TIMEOUT: "60",
		});
		await waitForEvent("child ready");
		entry.process.kill("SIGTERM");
		await waitForEvent("hook start");
		const secondAt = Date.now();

		entry.process.kill("SIGTERM");

		expect(await entry.exited).toBe(7);
		expect(Date.now() - secondAt).toBeLessThan(3_000);
		expect(readEvents()).toEqual(["child ready", "hook start", "child got TERM"]);
		expect(entry.stderr()).toContain("SIGTERM again: abandoning the pre-stop hook");
	});

	it("a second signal after the hook goes straight to the child", async () => {
		// Ignores the first TERM (like a server busy shutting down), exits on the second.
		writeFileSync(
			childScript,
			`n=0
trap 'n=$((n+1)); echo "child got TERM $n" >> "$EVENTS"; [ $n -lt 2 ] || exit 9' TERM
echo "child ready" >> "$EVENTS"
while :; do sleep 0.05; done
`,
		);
		const entry = startEntrypoint(["sh", childScript], {
			KANBAN_START_HOOK: "",
			KANBAN_PRESTOP_HOOK: 'echo "hook ran" >> "$EVENTS"',
		});
		await waitForEvent("child ready");
		entry.process.kill("SIGTERM");
		await waitForEvent("child got TERM 1");

		entry.process.kill("SIGTERM");

		expect(await entry.exited).toBe(9);
		expect(readEvents()).toEqual(["child ready", "hook ran", "child got TERM 1", "child got TERM 2"]);
		expect(entry.stderr()).toContain("SIGTERM again: forwarding");
	});

	it("passes through the exit code of a child that exits on its own, without running the pre-stop hook", async () => {
		const entry = startEntrypoint(["sh", "-c", "exit 42"], {
			KANBAN_START_HOOK: "",
			KANBAN_PRESTOP_HOOK: 'echo "hook ran" >> "$EVENTS"',
		});

		expect(await entry.exited).toBe(42);
		expect(readEvents()).toEqual([]);
	});

	it("starts the start hook detached: the child starts at once and the entrypoint does not wait for the hook", async () => {
		const entry = startEntrypoint(["sh", "-c", 'echo "child ran" >> "$EVENTS"'], {
			KANBAN_START_HOOK: 'sleep 1; echo "start hook done" >> "$EVENTS"',
			KANBAN_PRESTOP_HOOK: "",
		});

		expect(await entry.exited).toBe(0);
		expect(readEvents()).toEqual(["child ran"]);
		await waitForEvent("start hook done");
	});

	it("runs a command override (quadlet Exec=, `sh -c '...; exec kanban ...'`) and signals the exec'd command", async () => {
		const entry = startEntrypoint(["/bin/sh", "-c", `echo "override ran" >> "$EVENTS"; exec sh '${childScript}'`], {
			KANBAN_START_HOOK: "",
			KANBAN_PRESTOP_HOOK: 'echo "hook ran" >> "$EVENTS"',
		});
		await waitForEvent("child ready");

		entry.process.kill("SIGTERM");

		expect(await entry.exited).toBe(7);
		expect(readEvents()).toEqual(["override ran", "child ready", "hook ran", "child got TERM"]);
	});

	it("defaults to `kit boot` and `kit prepare-restart` from KANBAN_KIT_HOME, logging to its logs dir", async () => {
		writeFakeKit();
		mkdirSync(join(kitHome, "logs"));
		const entry = startEntrypoint(["sh", childScript]);
		await waitForEvent("kit boot");
		await waitForEvent("child ready");

		entry.process.kill("SIGTERM");

		expect(await entry.exited).toBe(7);
		expect(readEvents().filter((event) => event !== "kit boot")).toEqual([
			"child ready",
			"kit prepare-restart",
			"child got TERM",
		]);
		const log = readFileSync(join(kitHome, "logs", "kanban-entrypoint.log"), "utf8");
		expect(log).toContain("kit output for boot");
		expect(log).toContain("kit output for prepare-restart");
		expect(log).toContain("pre-stop hook done");
	});
});
