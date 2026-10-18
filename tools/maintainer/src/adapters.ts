import { z } from "zod";

import {
	commitShaSchema,
	issueSnapshotSchema,
	type MaintenanceConfig,
	type MaintenanceJob,
	verificationSchema,
	type WorkerResult,
} from "./contracts";
import { verifyExactCommitLocalSmoke } from "./local-smoke";
import { OpenCodeMaintenanceClient } from "./opencode-cli";
import type { CommandRunner, MaintenancePorts } from "./ports";
import { runMaintenanceCommand } from "./process";

export function createMaintenancePorts(
	config: MaintenanceConfig,
	run: CommandRunner = runMaintenanceCommand,
): MaintenancePorts {
	const client = new OpenCodeMaintenanceClient(config, run);
	const bridge = async (request: unknown): Promise<unknown> => {
		const response = await run({
			executable: config.githubBridge.executable,
			args: config.githubBridge.args,
			cwd: config.projectDirectory,
			input: JSON.stringify(request),
		});
		if (response.status !== 0) throw new Error("Read-only App bridge unavailable; no credential fallback");
		try {
			return JSON.parse(response.stdout);
		} catch {
			throw new Error("App bridge response invalid; raw body withheld");
		}
	};
	return {
		now: () => new Date(),
		startingCommit: async () => {
			const branch = await run({
				executable: "git",
				args: ["branch", "--show-current"],
				cwd: config.projectDirectory,
			});
			if (branch.status !== 0 || branch.stdout.trim() !== config.branch)
				throw new Error("Configured maintenance branch is not checked out");
			const head = await run({ executable: "git", args: ["rev-parse", "HEAD"], cwd: config.projectDirectory });
			if (head.status !== 0) throw new Error("Maintenance starting commit unavailable");
			return commitShaSchema.parse(head.stdout.trim());
		},
		issues: async () =>
			z
				.array(issueSnapshotSchema)
				.max(100)
				.parse(await bridge({ operation: "issues", repository: config.repository })),
		validateTarget: async () => {
			if (!config.localSmoke)
				throw new Error(
					"Configure an operator-owned immutable local smoke image before admitting a new maintenance job.",
				);
			const image = await run({
				executable: "podman",
				args: ["image", "inspect", config.localSmoke.imageId, "--format", "{{.Id}}"],
				cwd: config.projectDirectory,
			});
			if (image.status !== 0)
				throw new Error("Configured local smoke image is unavailable; no pull or new model turn was authorized.");
			await client.validateTarget();
		},
		submit: (job, text) => client.submit(job, text),
		observe: (job) => client.observe(job),
		verify: async (job: MaintenanceJob, result: WorkerResult) => {
			const verification = verificationSchema.parse(
				await bridge({
					operation: "verify",
					repository: config.repository,
					branch: config.branch,
					requiredWorkflows: config.requiredWorkflows,
					job,
					result,
				}),
			);
			delete verification.localSmoke; // Bridge/worker claims never substitute for independently run local smoke.
			return verification;
		},
		localSmoke: async (_job, result) => verifyExactCommitLocalSmoke(config, result, run),
	};
}
