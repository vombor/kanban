import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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
let binDir: string;
let events: string;
let childScript: string;
let running: ChildProcess[] = [];

interface Entrypoint {
	process: ChildProcess;
	stderr: () => string;
	exited: Promise<number | null>;
}

/** `env` values override the defaults below; `undefined` leaves a variable unset (the entrypoint's own default). */
function startEntrypoint(args: string[], env: Record<string, string | undefined> = {}): Entrypoint {
	let stderr = "";
	// Never the real kit or the real `kanban restart prepare` (it would tag this machine's worktrees): KANBAN_KIT_HOME
	// is a temp dir, no KANBAN_* setting leaks in from this machine, and restart prepare is off unless a test turns it
	// on (then with the stub `kanban` from writeFakeKanban, first on PATH).
	const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KANBAN_")));
	const childEnv = Object.entries({
		...baseEnv,
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		KANBAN_KIT_HOME: kitHome,
		KANBAN_RESTART_PREPARE_HOOK: "",
		EVENTS: events,
		...env,
	}).filter((entry): entry is [string, string] => entry[1] !== undefined);
	const child = spawn("sh", [ENTRYPOINT, ...args], {
		cwd: tempDir.path,
		env: Object.fromEntries(childEnv),
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

// Stands in for the `kanban` CLI: records its arguments and the server it was pointed at, then runs `body`.
function writeFakeKanban(body = 'echo "kanban output"'): void {
	const kanban = join(binDir, "kanban");
	const record = 'echo "kanban $* port=$KANBAN_RUNTIME_PORT home=$KANBAN_HOME" >> "$EVENTS"';
	writeFileSync(kanban, `#!/bin/sh\n${record}\n${body}\n`);
	chmodSync(kanban, 0o755);
}

/** PATH without the directories that have `command`, plus the stub bin dir (for "not installed"). */
function pathWithout(command: string): string {
	const dirs = (process.env.PATH ?? "").split(":").filter((dir) => dir && !existsSync(join(dir, command)));
	return [binDir, ...dirs].join(":");
}

/** A local port nothing listens on (bound, then released). */
async function findClosedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	await new Promise((resolveClose) => server.close(resolveClose));
	if (!address || typeof address === "string") {
		throw new Error("no port");
	}
	return address.port;
}

describe.skipIf(!supported).sequential("deploy/kanban-entrypoint.sh", () => {
	beforeEach(() => {
		tempDir = createTempDir("kanban-entrypoint-");
		kitHome = join(tempDir.path, "kit");
		mkdirSync(kitHome);
		binDir = join(tempDir.path, "bin");
		mkdirSync(binDir);
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

	it("defaults to `kit boot`, `kit prepare-restart` and `kanban restart prepare`, logging to the kit's logs dir", async () => {
		writeFakeKit();
		writeFakeKanban();
		mkdirSync(join(kitHome, "logs"));
		const entry = startEntrypoint(["sh", childScript, "--port", "3485", "--no-open"], {
			KANBAN_RESTART_PREPARE_HOOK: undefined,
		});
		await waitForEvent("kit boot");
		await waitForEvent("child ready");

		entry.process.kill("SIGTERM");

		expect(await entry.exited).toBe(7);
		// Both while Kanban is up, the kit first; the CLI is pointed at the command's port.
		expect(readEvents().filter((event) => event !== "kit boot")).toEqual([
			"child ready",
			"kit prepare-restart",
			"kanban restart prepare port=3485 home=",
			"child got TERM",
		]);
		const log = readFileSync(join(kitHome, "logs", "kanban-entrypoint.log"), "utf8");
		expect(log).toContain("kit output for boot");
		expect(log).toContain("kit output for prepare-restart");
		expect(log).toContain("pre-stop hook done");
		expect(log).toContain("restart prepare (timeout 20s): kanban restart prepare");
		expect(log).toContain("kanban output");
		expect(log).toContain("restart prepare done");
	});

	it("passes --port=/--home from the command to restart prepare", async () => {
		writeFakeKanban();
		const entry = startEntrypoint(["sh", childScript, "--port=4000", "--home", "/srv/kanban-home"], {
			KANBAN_START_HOOK: "",
			KANBAN_PRESTOP_HOOK: "",
			KANBAN_RESTART_PREPARE_HOOK: "kanban restart prepare",
		});
		await waitForEvent("child ready");

		entry.process.kill("SIGTERM");

		expect(await entry.exited).toBe(7);
		expect(readEvents()).toEqual([
			"child ready",
			"kanban restart prepare port=4000 home=/srv/kanban-home",
			"child got TERM",
		]);
	});

	it.each([
		["fails", "exit 1", "restart prepare failed (exit 1)"],
		// What the real CLI does with the server down: its request is refused and it exits 1.
		[
			"finds the server down",
			`exec node -e 'fetch("http://127.0.0.1:" + process.env.KANBAN_RUNTIME_PORT).then(() => process.exit(0), (error) => { console.error(error.message); process.exit(1); })'`,
			"restart prepare failed (exit 1)",
		],
	])("still stops when restart prepare %s", async (_name, body, logLine) => {
		writeFakeKanban(body);
		const entry = startEntrypoint(["sh", childScript, "--port", String(await findClosedPort())], {
			KANBAN_START_HOOK: "",
			KANBAN_PRESTOP_HOOK: 'echo "hook ran" >> "$EVENTS"',
			KANBAN_RESTART_PREPARE_HOOK: "kanban restart prepare",
		});
		await waitForEvent("child ready");

		entry.process.kill("SIGTERM");

		expect(await entry.exited).toBe(7);
		expect(readEvents()).toEqual([
			"child ready",
			"hook ran",
			expect.stringMatching(/^kanban restart prepare port=\d+ home=$/u),
			"child got TERM",
		]);
		expect(entry.stderr()).toContain(logLine);
	});

	it("stops waiting for restart prepare at its timeout and kills it", async () => {
		writeFakeKanban('sleep 30; echo "kanban end" >> "$EVENTS"');
		const entry = startEntrypoint(["sh", childScript], {
			KANBAN_START_HOOK: "",
			KANBAN_PRESTOP_HOOK: "",
			KANBAN_RESTART_PREPARE_HOOK: "kanban restart prepare",
			KANBAN_RESTART_PREPARE_TIMEOUT: "1",
		});
		await waitForEvent("child ready");
		const signalledAt = Date.now();

		entry.process.kill("SIGTERM");

		expect(await entry.exited).toBe(7);
		expect(Date.now() - signalledAt).toBeLessThan(5_000);
		expect(readEvents()).toEqual(["child ready", "kanban restart prepare port= home=", "child got TERM"]);
		expect(entry.stderr()).toContain("restart prepare timed out after 1s");
	});

	it("skips restart prepare when Kanban exited during the kit hook", async () => {
		writeFakeKanban();
		writeFileSync(
			childScript,
			`echo "child ready" >> "$EVENTS"
while [ ! -e "$EVENTS.quit" ]; do sleep 0.05; done
echo "child quit" >> "$EVENTS"
`,
		);
		const entry = startEntrypoint(["sh", childScript], {
			KANBAN_START_HOOK: "",
			// Kanban goes down on its own while the kit hook runs (the hook waits until it is gone).
			KANBAN_PRESTOP_HOOK:
				'touch "$EVENTS.quit"; while ! grep -q "child quit" "$EVENTS"; do sleep 0.05; done; sleep 0.2',
			KANBAN_RESTART_PREPARE_HOOK: "kanban restart prepare",
		});
		await waitForEvent("child ready");

		entry.process.kill("SIGTERM");

		expect(await entry.exited).toBe(0);
		expect(readEvents()).toEqual(["child ready", "child quit"]);
		expect(entry.stderr()).toMatch(/restart prepare skipped: pid \d+ already exited/u);
	});

	it("skips restart prepare without a `kanban` command", async () => {
		const entry = startEntrypoint(["sh", childScript], {
			KANBAN_START_HOOK: "",
			KANBAN_PRESTOP_HOOK: "",
			KANBAN_RESTART_PREPARE_HOOK: undefined,
			PATH: pathWithout("kanban"),
		});
		await waitForEvent("child ready");

		entry.process.kill("SIGTERM");

		expect(await entry.exited).toBe(7);
		expect(readEvents()).toEqual(["child ready", "child got TERM"]);
		expect(entry.stderr()).toContain("no restart prepare");
	});

	it("a second signal during the kit hook skips restart prepare", async () => {
		writeFakeKanban();
		const entry = startEntrypoint(["sh", childScript], {
			KANBAN_START_HOOK: "",
			KANBAN_PRESTOP_HOOK: 'echo "hook start" >> "$EVENTS"; sleep 30',
			KANBAN_PRESTOP_TIMEOUT: "60",
			KANBAN_RESTART_PREPARE_HOOK: "kanban restart prepare",
		});
		await waitForEvent("child ready");
		entry.process.kill("SIGTERM");
		await waitForEvent("hook start");

		entry.process.kill("SIGTERM");

		expect(await entry.exited).toBe(7);
		expect(readEvents()).toEqual(["child ready", "hook start", "child got TERM"]);
		expect(entry.stderr()).not.toContain("restart prepare (timeout");
	});
});
