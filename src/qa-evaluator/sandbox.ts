import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const SAFE_ENV = new Set([
	"PATH",
	"HOME",
	"NODE_VERSION",
	"YARN_VERSION",
	"LANG",
	"LC_ALL",
	"TZ",
	"NPM_CONFIG_LOGLEVEL",
	"KANBAN_NO_AUTO_UPDATE",
	"KANBAN_UPDATE_MODE",
	"CLINE_NO_AUTO_UPDATE",
	"DISABLE_AUTOUPDATER",
	"COPILOT_AUTO_UPDATE",
	"FACTORY_DROID_AUTO_UPDATE_ENABLED",
	"KANBAN_IMAGE_REVISION",
	"KANBAN_IMAGE_CREATED",
	"KANBAN_IMAGE_VERSION",
]);
const imageSchema = z
	.array(z.object({ Id: z.string(), Config: z.object({ Env: z.array(z.string()).optional() }) }))
	.length(1);
const PROGRAM = `
const fs=require('node:fs'),Module=require('node:module');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const finite=Number.isFinite,stringify=JSON.stringify;
const mod=new Module('/tmp/owned-evaluation.cjs');mod.paths=[];mod._compile(input.source,'/tmp/owned-evaluation.cjs');
const fn=mod.exports[input.functionName];if(typeof fn!=='function'||fn.length!==input.parameters.length)throw new Error('missing or mismatched fixed-arity function');
function valid(value,depth=0){if(depth>12)return false;if(value===null||typeof value==='string'||typeof value==='boolean')return true;if(typeof value==='number')return finite(value);if(Array.isArray(value))return value.every(v=>valid(v,depth+1));if(value&&typeof value==='object'&&typeof value.then!=='function')return Object.values(value).every(v=>valid(v,depth+1));return false;}
const values=input.inputs.map(named=>{const value=fn(...input.parameters.map(parameter=>named[parameter]));if(!valid(value))throw new Error('non-JSON result');return value;});
process.stdout.write(stringify({values}));
`;
export interface SandboxEvaluation {
	ok: boolean;
	values: unknown[] | null;
	cleanup: boolean;
	failure?: "program" | "infrastructure";
}
export type SandboxRunner = (input: {
	source: string;
	functionName: string;
	parameters: string[];
	inputs: Array<Record<string, unknown>>;
}) => Promise<SandboxEvaluation>;
function podmanEnv(): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
		DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
		LANG: "C.UTF-8",
		// Ignore user/system defaults that could inject mounts, devices, hooks or shared namespaces.
		CONTAINERS_CONF: "/dev/null",
	};
}
/** Do not wait synchronously on Podman's SIGTERM handling while untrusted PID 1 code is still running. */
function runContainer(
	args: string[],
	input: string,
): Promise<{ status: number | null; stdout: string; terminated: boolean }> {
	return new Promise((resolve) => {
		const child = spawn("podman", args, { env: podmanEnv(), stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let bytes = 0,
			terminated = false,
			settled = false,
			status: number | null = null;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			resolve({ status, stdout: Buffer.concat(chunks).toString("utf8"), terminated });
		};
		const terminate = () => {
			terminated = true;
			child.kill("SIGKILL");
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
		};
		const timer = setTimeout(terminate, 10000);
		timer.unref();
		child.stdin.on("error", () => {});
		child.stdout.on("data", (chunk) => {
			bytes += chunk.length;
			if (bytes > 1048576) terminate();
			else chunks.push(Buffer.from(chunk));
		});
		child.stderr.on("data", (chunk) => {
			bytes += chunk.length;
			if (bytes > 1048576) terminate();
		});
		child.once("error", finish);
		child.once("exit", (code) => {
			status = code;
			if (terminated) finish();
		});
		child.once("close", finish);
		child.stdin.end(input);
	});
}
export function inspectEvaluatorImage(image: string): void {
	if (!/^[a-f0-9]{64}$/u.test(image))
		throw new Error("Evaluator requires a locally inspected immutable image id; no pull is authorized.");
	const result = spawnSync("podman", ["image", "inspect", image], {
		env: podmanEnv(),
		encoding: "utf8",
		timeout: 10000,
		maxBuffer: 1048576,
		killSignal: "SIGKILL",
	});
	if (result.status !== 0) throw new Error("Local evaluator image unavailable; no pull or fallback is authorized.");
	const parsed = imageSchema.parse(JSON.parse(result.stdout)),
		entry = parsed[0];
	if (
		!entry ||
		entry.Id.replace(/^sha256:/u, "") !== image ||
		(entry.Config.Env ?? []).some((value) => !SAFE_ENV.has(value.split("=", 1)[0] ?? ""))
	)
		throw new Error("Evaluator image identity/environment is not an approved secret-free baseline.");
}
export function createPodmanEvaluatorSandbox(image: string): SandboxRunner {
	inspectEvaluatorImage(image);
	return async (input) => {
		const id = randomUUID(),
			name = `kanban-qa-eval-${id}`,
			label = "io.kanban.qa-evaluator";
		let cleanup = false;
		const result = await runContainer(
			[
				"run",
				"--pull=never",
				"--stop-timeout=1",
				"--timeout=8",
				"--ulimit=cpu=5:5",
				"--name",
				name,
				"--label",
				`${label}=${id}`,
				"--label",
				"io.containers.autoupdate=",
				"--network=none",
				// Podman's subscription-mount override is intentionally hidden from --help; see upstream subscriptions.go.
				"--default-mounts-file=/dev/null",
				"--pid=private",
				"--ipc=private",
				"--uts=private",
				"--cgroupns=private",
				"--unsetenv-all",
				"--http-proxy=false",
				"--env=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
				"--env=HOME=/tmp",
				"--env=LANG=C.UTF-8",
				"--read-only",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges",
				"--pids-limit=32",
				"--memory=128m",
				"--cpus=1",
				"--user=65534:65534",
				"--image-volume=ignore",
				"--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m",
				"--workdir=/tmp",
				"--entrypoint=node",
				"-i",
				image,
				"--max-old-space-size=64",
				"-e",
				PROGRAM,
			],
			JSON.stringify(input),
		);
		try {
			const inspected = spawnSync("podman", ["container", "inspect", name], {
				env: podmanEnv(),
				encoding: "utf8",
				timeout: 10000,
				maxBuffer: 1048576,
				killSignal: "SIGKILL",
			});
			if (inspected.status === 0) {
				const data = z
					.array(
						z.object({
							Config: z.object({ Labels: z.record(z.string(), z.string()) }),
							State: z.object({ Running: z.boolean() }),
						}),
					)
					.parse(JSON.parse(inspected.stdout));
				if (data[0]?.Config.Labels[label] !== id) throw new Error("Evaluator ownership mismatch; refusing cleanup");
				if (data[0]?.State.Running) {
					const killed = spawnSync("podman", ["kill", "--signal=KILL", name], {
						env: podmanEnv(),
						encoding: "utf8",
						timeout: 10000,
						maxBuffer: 1048576,
						killSignal: "SIGKILL",
					});
					if (killed.status !== 0) throw new Error("Owned evaluator stop unconfirmed");
				}
				const removed = spawnSync("podman", ["rm", "--force", name], {
					env: podmanEnv(),
					encoding: "utf8",
					timeout: 10000,
					maxBuffer: 1048576,
					killSignal: "SIGKILL",
				});
				if (removed.status !== 0) throw new Error("Evaluator cleanup unknown");
			}
			const exists = spawnSync("podman", ["container", "exists", name], {
				env: podmanEnv(),
				encoding: "utf8",
				timeout: 10000,
				maxBuffer: 1048576,
				killSignal: "SIGKILL",
			});
			cleanup = exists.status === 1 && (inspected.status === 0 || !result.terminated);
		} catch {
			cleanup = false;
		}
		if (!cleanup) return { ok: false, values: null, cleanup: false, failure: "infrastructure" };
		if (result.status !== 0 || result.terminated)
			return {
				ok: false,
				values: null,
				cleanup: true,
				failure:
					result.terminated || result.status === null || [125, 126, 127].includes(result.status)
						? "infrastructure"
						: "program",
			};
		try {
			const parsed = z
				.object({ values: z.array(z.json()).max(10) })
				.strict()
				.parse(JSON.parse(result.stdout));
			return parsed.values.length === input.inputs.length
				? { ok: true, values: parsed.values, cleanup: true }
				: { ok: false, values: null, cleanup: true, failure: "program" };
		} catch {
			return { ok: false, values: null, cleanup: true, failure: "program" };
		}
	};
}
