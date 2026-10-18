import { spawn } from "node:child_process";
import { createGitProcessEnv, isGitRepositoryEnvName } from "../../../src/core/git-process-env";
import type { CommandRunner } from "./ports";

export const runMaintenanceCommand: CommandRunner = async ({
	executable,
	args,
	cwd,
	input,
	maxBytes = 8 * 1024 * 1024,
	env: explicitEnv,
	timeoutMs = 90_000,
}) => {
	const env = explicitEnv ? { ...explicitEnv } : createGitProcessEnv();
	for (const key of Object.keys(env)) {
		if (
			isGitRepositoryEnvName(key) ||
			/^(KANBAN_.*|AWS_.*|ANTHROPIC_.*|OPENAI_.*|CLINE_.*|SENTRY_.*|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|COPILOT_GITHUB_TOKEN|GH_DEBUG|NODE_DEBUG|GIT_TRACE.*)$/u.test(
				key,
			)
		)
			delete env[key];
	}
	return await new Promise((resolve, reject) => {
		const child = spawn(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
		let bytes = 0;
		const output: Buffer[] = [];
		const errors: Buffer[] = [];
		let invalid = false;
		const timeout = setTimeout(() => {
			invalid = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		const capture = (chunks: Buffer[], chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > maxBytes) {
				invalid = true;
				child.kill("SIGKILL");
				return;
			}
			chunks.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => capture(output, chunk));
		child.stderr.on("data", (chunk: Buffer) => capture(errors, chunk));
		child.stdin.on("error", () => {
			invalid = true;
		});
		child.on("error", () => {
			clearTimeout(timeout);
			reject(new Error("Maintenance subprocess unavailable; raw errors withheld"));
		});
		child.on("close", (status) => {
			clearTimeout(timeout);
			if (invalid || status === null)
				reject(new Error("Maintenance subprocess timed out/overflowed; mutation outcome may be uncertain"));
			else
				resolve({
					status,
					stdout: Buffer.concat(output).toString("utf8"),
					stderr: Buffer.concat(errors).toString("utf8"),
				});
		});
		child.stdin.end(input);
	});
};
