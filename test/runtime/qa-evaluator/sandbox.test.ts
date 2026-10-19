import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", () => mocks);

import { createPodmanEvaluatorSandbox } from "../../../src/qa-evaluator/sandbox";

const IMAGE = "a".repeat(64);
describe("owned evaluator CPU sandbox", () => {
	let child: EventEmitter & {
			stdin: PassThrough;
			stdout: PassThrough;
			stderr: PassThrough;
			kill: ReturnType<typeof vi.fn>;
		},
		wrongOwner: boolean;
	beforeEach(() => {
		vi.useFakeTimers();
		mocks.spawn.mockReset();
		mocks.spawnSync.mockReset();
		wrongOwner = false;
		child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(() => {
				queueMicrotask(() => child.emit("exit", null));
				return true;
			}),
		});
		mocks.spawn.mockReturnValue(child);
		mocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
			if (args[0] === "image")
				return { status: 0, stdout: JSON.stringify([{ Id: IMAGE, Config: { Env: ["PATH=/usr/bin"] } }]) };
			if (args[0] === "container" && args[1] === "inspect") {
				const name = args[2] ?? "";
				return {
					status: 0,
					stdout: JSON.stringify([
						{
							Config: {
								Labels: {
									"io.kanban.qa-evaluator": wrongOwner ? "someone-else" : name.replace("kanban-qa-eval-", ""),
								},
							},
							State: { Running: true },
						},
					]),
				};
			}
			return { status: args[1] === "exists" ? 1 : 0, stdout: "" };
		});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});
	it("force-kills a timed-out Podman client and then only its verified owned container, without waiting on SIGTERM", async () => {
		vi.stubEnv("QA_EVAL_HOST_SECRET", "private-host-fixture");
		const sandbox = createPodmanEvaluatorSandbox(IMAGE),
			pending = sandbox({
				source: "untrusted code is data only in this fake",
				functionName: "test",
				parameters: [],
				inputs: [{}],
			});
		const args = mocks.spawn.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(
			expect.arrayContaining([
				"--network=none",
				"--read-only",
				"--cap-drop=ALL",
				"--pids-limit=32",
				"--memory=128m",
				"--cpus=1",
				"--user=65534:65534",
				"--entrypoint=node",
				"--pull=never",
			]),
		);
		expect(JSON.stringify(mocks.spawn.mock.calls[0]?.[2])).not.toContain("private-host-fixture");
		await vi.advanceTimersByTimeAsync(10000);
		expect(await pending).toEqual({ ok: false, values: null, cleanup: true, failure: "infrastructure" });
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(
			mocks.spawnSync.mock.calls.some(
				([_command, command]) => command[0] === "kill" && command.includes("--signal=KILL"),
			),
		).toBe(true);
	});
	it("never kills or removes a container whose owner label does not match", async () => {
		wrongOwner = true;
		const sandbox = createPodmanEvaluatorSandbox(IMAGE),
			pending = sandbox({ source: "data", functionName: "test", parameters: [], inputs: [{}] });
		child.stdout.write('{"values":[1]}');
		child.emit("exit", 0);
		child.emit("close", 0);
		expect(await pending).toEqual({ ok: false, values: null, cleanup: false, failure: "infrastructure" });
		expect(mocks.spawnSync.mock.calls.some(([_command, command]) => ["kill", "rm"].includes(command[0]))).toBe(false);
	});
});
