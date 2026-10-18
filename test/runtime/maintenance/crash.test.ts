import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createGitProcessEnv } from "../../../src/core/git-process-env";
import { maintenanceConfigSchema } from "../../../src/maintenance/contracts";
import { MaintenanceStore } from "../../../src/maintenance/store";
import { MaintenanceSupervisor } from "../../../src/maintenance/supervisor";

it("survives a real SIGKILL at the durable admission boundary without replaying the prompt", async () => {
	const home = await mkdtemp(join(tmpdir(), "maintenance-crash-test-"));
	const child = spawn(process.execPath, ["--import", "tsx", "test/runtime/maintenance/crash-fixture.ts"], {
		env: createGitProcessEnv({ MAINTENANCE_TEST_HOME: home }),
		stdio: ["ignore", "pipe", "pipe"],
	});
	const closed = once(child, "close");
	try {
		await once(child.stdout, "data", { signal: AbortSignal.timeout(10_000) });
		const store = new MaintenanceStore(home);
		expect((await store.read()).jobs[0]?.state).toBe("submitting");
		child.kill("SIGKILL");
		expect(await closed).toEqual([null, "SIGKILL"]);
		// Simulate the passage of the existing lock's stale interval, not a production lock deletion/bypass.
		const expired = new Date(Date.now() - 120_000);
		await utimes(`${store.paths.journal}.lock`, expired, expired);
		const config = maintenanceConfigSchema.parse({
			version: 1,
			repository: "example/project",
			projectDirectory: "/fixture",
			branch: "main",
			sessionId: "ses_fixture",
			opencodeCli: "/fixture/opencode",
			githubBridge: { executable: "/fixture/bridge", args: [] },
			timezone: "UTC",
			requiredWorkflows: ["checks.yml"],
		});
		let submitted = 0;
		const supervisor = new MaintenanceSupervisor(config, store, {
			now: () => new Date("2026-10-17T11:00:00Z"),
			startingCommit: async () => {
				throw new Error("Unexpected admission");
			},
			issues: async () => {
				throw new Error("Unexpected issue admission");
			},
			validateTarget: async () => {},
			submit: async () => {
				submitted += 1;
			},
			observe: async () => ({
				queued: true,
				delivered: false,
				active: false,
				failed: false,
				interrupted: false,
				scopedTurn: false,
				completeTurn: false,
			}),
			verify: async () => {
				throw new Error("Unexpected verification");
			},
		});
		await supervisor.daily("2026-10-18");
		expect((await supervisor.reconcile()).jobs[0]?.state).toBe("queued");
		expect(submitted).toBe(0);
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await closed;
		}
	}
}, 15_000);
