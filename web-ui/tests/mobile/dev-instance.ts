import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

// A throwaway Kanban for the mobile e2e tests: its own runtime with a temp
// Kanban home, HOME and projects root, plus its own Vite dev server proxying to
// it. It never talks to the live server (port 3485) or /root/.kanban.

const webUiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoDir = resolve(webUiDir, "..");
const LIVE_RUNTIME_PORT = 3485;
const STARTUP_TIMEOUT_MS = 60_000;

export interface DevInstance {
	baseUrl: string;
	rootDir: string;
	projectDir: string;
	// Stops the runtime as a restart does (SIGTERM, so its shutdown runs) and
	// starts it again on the same port and Kanban home. Vite keeps running.
	restartRuntime: () => Promise<void>;
	// Runs the kanban CLI against this instance (its home, HOME and runtime port) in the project dir.
	runCli: (args: string[]) => { status: number | null; stdout: string; stderr: string };
	stop: () => Promise<void>;
}

export interface DevInstanceOptions {
	// Executables put first on the runtime's PATH (name -> script), e.g. a fake
	// agent CLI under a name Kanban detects.
	fakeCommands?: Record<string, string>;
	// The Kanban home's config.json, written before the first start.
	globalConfig?: Record<string, unknown>;
	// Extra runtime flags, e.g. the pod's --skip-shutdown-cleanup.
	runtimeArgs?: string[];
}

async function findFreePort(): Promise<number> {
	return await new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolvePort(port));
		});
	});
}

// No KANBAN_* (an agent session's credential, the live runtime port) and no
// git redirection (a hook's GIT_DIR) reach the instance.
function createIsolatedEnv(rootDir: string, extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (name.startsWith("KANBAN_") || name.startsWith("GIT_") || name.startsWith("CLAUDE")) {
			continue;
		}
		env[name] = value;
	}
	return {
		...env,
		HOME: join(rootDir, "user-home"),
		KANBAN_PROJECTS_ROOTS: join(rootDir, "projects"),
		KANBAN_NO_AUTO_UPDATE: "1",
		...extra,
	};
}

function waitForOutput(child: ChildProcess, pattern: RegExp, label: string): Promise<void> {
	return new Promise((resolveReady, reject) => {
		let output = "";
		const timer = setTimeout(() => {
			reject(new Error(`${label} did not start within ${STARTUP_TIMEOUT_MS} ms:\n${output}`));
		}, STARTUP_TIMEOUT_MS);
		const onData = (chunk: Buffer) => {
			// Vite colours its banner even without a TTY.
			output += stripVTControlCharacters(chunk.toString());
			if (pattern.test(output)) {
				clearTimeout(timer);
				resolveReady();
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`${label} exited with code ${code}:\n${output}`));
		});
	});
}

function stopProcess(child: ChildProcess): Promise<void> {
	return new Promise((resolveStopped) => {
		if (child.exitCode !== null || child.pid === undefined) {
			resolveStopped();
			return;
		}
		child.once("exit", () => resolveStopped());
		// Each child leads its own process group: the runtime's PTYs and Vite's
		// esbuild go with it.
		process.kill(-child.pid, "SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null && child.pid !== undefined) {
				process.kill(-child.pid, "SIGKILL");
			}
		}, 5_000).unref();
	});
}

export async function startDevInstance(options: DevInstanceOptions = {}): Promise<DevInstance> {
	const rootDir = mkdtempSync(join(tmpdir(), "kanban-mobile-e2e-"));
	const kanbanHome = join(rootDir, "kanban-home");
	const binDir = join(rootDir, "bin");
	mkdirSync(binDir, { recursive: true });
	for (const [name, script] of Object.entries(options.fakeCommands ?? {})) {
		writeFileSync(join(binDir, name), script);
		chmodSync(join(binDir, name), 0o755);
	}
	if (options.globalConfig) {
		mkdirSync(kanbanHome, { recursive: true });
		writeFileSync(join(kanbanHome, "config.json"), `${JSON.stringify(options.globalConfig, null, 2)}\n`);
	}
	const projectDir = join(rootDir, "projects", "demo");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(join(rootDir, "user-home"), { recursive: true });
	const gitEnv = createIsolatedEnv(rootDir, {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "e2e",
		GIT_AUTHOR_EMAIL: "e2e@example.com",
		GIT_COMMITTER_NAME: "e2e",
		GIT_COMMITTER_EMAIL: "e2e@example.com",
	});
	spawnSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir, env: gitEnv });
	spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: projectDir, env: gitEnv });

	const runtimePort = await findFreePort();
	const webPort = await findFreePort();
	if (runtimePort === LIVE_RUNTIME_PORT || webPort === LIVE_RUNTIME_PORT) {
		throw new Error("Refusing to use the live Kanban port.");
	}

	const startRuntime = () =>
		spawn(
			join(repoDir, "node_modules/.bin/tsx"),
			[
				join(repoDir, "src/cli.ts"),
				"--home",
				kanbanHome,
				"--port",
				String(runtimePort),
				"--no-open",
				...(options.runtimeArgs ?? []),
			],
			{
				cwd: projectDir,
				// Development mode accepts the Vite dev server's origin (KANBAN_WEB_UI_PORT).
				env: createIsolatedEnv(rootDir, {
					NODE_ENV: "development",
					KANBAN_WEB_UI_PORT: String(webPort),
					PATH: `${binDir}:${process.env.PATH ?? ""}`,
				}),
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	let runtime = startRuntime();
	const vite = spawn(
		join(webUiDir, "node_modules/.bin/vite"),
		["--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
		{
			cwd: webUiDir,
			env: createIsolatedEnv(rootDir, {
				KANBAN_RUNTIME_PORT: String(runtimePort),
				KANBAN_WEB_UI_PORT: String(webPort),
			}),
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const stop = async () => {
		await Promise.all([stopProcess(vite), stopProcess(runtime)]);
		rmSync(rootDir, { recursive: true, force: true });
	};
	try {
		await Promise.all([
			waitForOutput(runtime, /Kanban running at/, "Kanban runtime"),
			waitForOutput(vite, /Local:/, "Vite"),
		]);
	} catch (error) {
		await stop();
		throw error;
	}
	const restartRuntime = async () => {
		await stopProcess(runtime);
		runtime = startRuntime();
		await waitForOutput(runtime, /Kanban running at/, "Kanban runtime");
	};
	const runCli = (args: string[]) => {
		const result = spawnSync(join(repoDir, "node_modules/.bin/tsx"), [join(repoDir, "src/cli.ts"), ...args], {
			cwd: projectDir,
			env: createIsolatedEnv(rootDir, {
				KANBAN_HOME: kanbanHome,
				KANBAN_RUNTIME_PORT: String(runtimePort),
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
			}),
			encoding: "utf8",
		});
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	};
	return { baseUrl: `http://127.0.0.1:${webPort}`, rootDir, projectDir, restartRuntime, runCli, stop };
}
