import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { ExecutionObservation, MaintenanceConfig, MaintenanceJob } from "./contracts";
import type { CommandRunner } from "./ports";

const messageSchema = z.object({
	id: z.string(),
	type: z.string(),
	time: z.object({ created: z.number(), completed: z.number().optional() }),
	error: z.unknown().optional(),
	finish: z.string().optional(),
});
const pageSchema = z.object({ data: z.array(messageSchema), cursor: z.unknown().optional() });

function unwrap(value: unknown): unknown {
	if (value && typeof value === "object" && "data" in value) return value.data;
	return value;
}

export class OpenCodeMaintenanceClient {
	constructor(
		private readonly config: MaintenanceConfig,
		private readonly run: CommandRunner,
	) {}

	private async api(method: "get" | "post", path: string, body?: unknown): Promise<unknown> {
		const args = ["api", method, path];
		if (body !== undefined) args.push("--data", JSON.stringify(body));
		const response = await this.run({ executable: this.config.opencodeCli, args, cwd: this.config.projectDirectory });
		if (response.status !== 0) throw new Error("OpenCode API unavailable; mutation outcome may be uncertain");
		try {
			return JSON.parse(response.stdout);
		} catch {
			throw new Error("OpenCode API response invalid; raw body withheld");
		}
	}

	async validateTarget(): Promise<void> {
		const session = z
			.object({ id: z.string(), location: z.object({ directory: z.string() }) })
			.parse(unwrap(await this.api("get", `/api/session/${this.config.sessionId}`)));
		if (
			session.id !== this.config.sessionId ||
			(await realpath(session.location.directory)) !== (await realpath(this.config.projectDirectory))
		)
			throw new Error("Maintenance session moved/mismatched; no prompt admitted");
		const inbox = z
			.array(z.object({ id: z.string(), type: z.string() }))
			.parse(unwrap(await this.api("get", `/api/session/${this.config.sessionId}/inbox`)));
		if (inbox.some((item) => item.id.startsWith("msg_kanban_daily_issues_") || item.id.startsWith("msg_maint_")))
			throw new Error(
				"An unjournaled/legacy maintenance input exists; inspect it instead of creating competing work",
			);
	}

	async submit(job: MaintenanceJob, text: string): Promise<void> {
		const receipt = z.object({ id: z.string(), sessionID: z.string(), delivery: z.string() }).parse(
			unwrap(
				await this.api("post", `/api/session/${job.sessionId}/prompt`, {
					id: job.inputId,
					text,
					delivery: "queue",
					metadata: { maintenanceJobId: job.id },
				}),
			),
		);
		if (receipt.id !== job.inputId || receipt.sessionID !== job.sessionId || receipt.delivery !== "queue")
			throw new Error("Maintenance admission receipt mismatched; never replay automatically");
	}

	async observe(job: MaintenanceJob): Promise<ExecutionObservation> {
		const session = z
			.object({ id: z.string(), location: z.object({ directory: z.string() }) })
			.parse(unwrap(await this.api("get", `/api/session/${job.sessionId}`)));
		if (
			session.id !== job.sessionId ||
			(await realpath(session.location.directory)) !== (await realpath(this.config.projectDirectory))
		)
			throw new Error("Maintenance execution target changed");
		const inbox = z
			.array(z.object({ id: z.string(), type: z.string() }))
			.parse(unwrap(await this.api("get", `/api/session/${job.sessionId}/inbox`)));
		if (inbox.some((item) => item.id === job.inputId && item.type === "user"))
			return {
				queued: true,
				delivered: false,
				active: false,
				failed: false,
				interrupted: false,
				completeTurn: false,
				scopedTurn: false,
			};
		// Exact-ID lookup, not a guessed latest assistant parent or truncated history scan.
		const input = messageSchema.parse(
			unwrap(await this.api("get", `/api/session/${job.sessionId}/message/${job.inputId}`)),
		);
		if (input.id !== job.inputId || input.type !== "user") throw new Error("Maintenance delivery lookup mismatched");
		const users = pageSchema.parse(
			await this.api("get", `/api/session/${job.sessionId}/message?type=user&order=desc&limit=1`),
		);
		const scopedTurn = users.data[0]?.id === job.inputId;
		if (!scopedTurn)
			return {
				queued: false,
				delivered: true,
				active: false,
				failed: false,
				interrupted: false,
				completeTurn: false,
				scopedTurn: false,
			};
		const active = z
			.record(z.string(), z.object({ type: z.literal("running") }))
			.parse(unwrap(await this.api("get", "/api/session/active")));
		const assistants = pageSchema.parse(
			await this.api("get", `/api/session/${job.sessionId}/message?type=assistant&order=desc&limit=1`),
		);
		const latest = assistants.data[0];
		const current = latest?.type === "assistant" && latest.time.created >= input.time.created ? latest : undefined;
		return {
			queued: false,
			delivered: true,
			active: job.sessionId in active,
			failed: current?.error !== undefined || current?.finish === "error",
			interrupted: false,
			completeTurn: current?.time.completed !== undefined && current.finish === "stop",
			scopedTurn,
		};
	}
}
