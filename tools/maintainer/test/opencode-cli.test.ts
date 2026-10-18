import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type MaintenanceJob, maintenanceConfigSchema } from "../src/contracts";
import { OpenCodeMaintenanceClient } from "../src/opencode-cli";
import type { CommandRunner } from "../src/ports";

async function fixture(overrides: Record<string, unknown> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "maintenance-api-test-"));
	const config = maintenanceConfigSchema.parse({
		version: 1,
		repository: "example/project",
		projectDirectory: directory,
		branch: "main",
		sessionId: "ses_fixture",
		opencodeCli: "/fixture/opencode",
		githubBridge: { executable: "/fixture/bridge", args: [] },
		timezone: "UTC",
		requiredWorkflows: ["ci.yml"],
	});
	const job = {
		id: `maint-${"a".repeat(32)}`,
		inputId: "msg_maint_fixture",
		sessionId: "ses_fixture",
	} as MaintenanceJob;
	const replies: Record<string, unknown> = {
		"/api/session/ses_fixture": { id: "ses_fixture", location: { directory } },
		"/api/session/ses_fixture/inbox": { data: [] },
		"/api/session/ses_fixture/message/msg_maint_fixture": {
			data: { id: job.inputId, type: "user", time: { created: 100 } },
		},
		"/api/session/ses_fixture/message?type=user&order=desc&limit=1": {
			data: [{ id: job.inputId, type: "user", time: { created: 100 } }],
			cursor: "opaque",
		},
		"/api/session/active": { data: { ses_fixture: { type: "running" } } },
		"/api/session/ses_fixture/message?type=assistant&order=desc&limit=1": {
			data: [
				{
					id: "msg_answer",
					type: "assistant",
					time: { created: 101 },
					error: { response: { body: "secret error" } },
				},
			],
		},
		...overrides,
	};
	const calls: string[] = [];
	const runner: CommandRunner = async ({ args }) => {
		const path = args[2];
		if (!path) throw new Error("Missing API path");
		calls.push(path);
		if (!(path in replies)) throw new Error("Unexpected request");
		return { status: 0, stdout: JSON.stringify(replies[path]), stderr: "" };
	};
	return { config, job, calls, client: new OpenCodeMaintenanceClient(config, runner) };
}

describe("scoped V2 maintenance observations", () => {
	it("tracks inbox by exact input without guessing an assistant parent", async () => {
		const f = await fixture({
			"/api/session/ses_fixture/inbox": { data: [{ id: "msg_maint_fixture", type: "user" }] },
		});
		expect((await f.client.observe(f.job)).queued).toBe(true);
		expect(f.calls).not.toContain("/api/session/active");
	});
	it("only attributes an error when the job is the latest user input", async () => {
		const f = await fixture();
		expect((await f.client.observe(f.job)).failed).toBe(true);
		const mixed = await fixture({
			"/api/session/ses_fixture/message?type=user&order=desc&limit=1": {
				data: [{ id: "msg_human", type: "user", time: { created: 200 } }],
			},
		});
		const observation = await mixed.client.observe(mixed.job);
		expect(observation.failed).toBe(false);
		expect(observation.scopedTurn).toBe(false);
		expect(JSON.stringify(observation)).not.toContain("secret error");
	});
	it("refuses old scheduler prompts during migration", async () => {
		const f = await fixture({
			"/api/session/ses_fixture/inbox": { data: [{ id: "msg_kanban_daily_issues_20261017", type: "user" }] },
		});
		await expect(f.client.validateTarget()).rejects.toThrow("legacy");
	});
	it("refuses a receipt mismatch without a second mutation", async () => {
		const f = await fixture({
			"/api/session/ses_fixture/prompt": { data: { id: "wrong", sessionID: "ses_fixture", delivery: "queue" } },
		});
		await expect(f.client.submit(f.job, "safe prompt")).rejects.toThrow("never replay");
		expect(f.calls).toHaveLength(1);
	});
});
