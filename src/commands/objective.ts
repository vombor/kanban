import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import {
	objectiveControlRequestSchema,
	objectiveCreateSchema,
	objectiveIdSchema,
	objectiveLimitsRequestSchema,
	objectiveManualLineageSchema,
} from "../core/objective-contract";
import { KANBAN_SESSION_WORKSPACE_ENV } from "../isolation/session-identity";
import { readKnowledgeMarkdown } from "./knowledge";
import { createRuntimeTrpcClient, type RuntimeTrpcClient } from "./runtime-trpc-client";
import { resolveWorkspaceTarget } from "./workspace-target";

interface Options {
	project?: string;
	json?: boolean;
}
async function run<T>(options: Options, operation: (client: RuntimeTrpcClient) => Promise<T>): Promise<void> {
	try {
		const target = await resolveWorkspaceTarget(options.project ?? process.env[KANBAN_SESSION_WORKSPACE_ENV], {
			allowUnregistered: false,
		});
		const result = await operation(createRuntimeTrpcClient(target.workspaceId));
		process.stdout.write(`${JSON.stringify(result, null, options.json ? undefined : 2)}\n`);
	} catch (error) {
		process.stderr.write(
			`kanban objective: ${error instanceof Error ? error.message : "The scoped objective operation failed."}\n`,
		);
		process.exitCode = 1;
	}
}
const common = (command: Command) =>
	command
		.option("--project <workspace>", "Registered project id/path; defaults to this session/cwd.")
		.option("--json", "Print structured objective metadata.");

export function registerObjectiveCommand(program: Command): void {
	const objective = program
		.command("objective")
		.description("Project-scoped durable requirements and objective evidence; not a new orchestrator.");
	common(objective.command("link <id>"))
		.requiredOption("--revision <number>", "Current revision; stale user-owned lineage is refused.")
		.requiredOption(
			"--parent <task>",
			"Own implementation parent; a reference alone never grants execution approval.",
		)
		.requiredOption("--task <ids...>", "Unstarted Backlog dev task ids (or planned ids with --planned).")
		.option("--kind <rework|escalation|runoff>", "Explicit relationship.", "rework")
		.option("--planned", "Reserve new child ids before creation; this creates/starts nothing.")
		.option("--request-id <uuid>", "Identity for an exact retry.")
		.action(
			async (
				id: string,
				options: Options & {
					revision: string;
					parent: string;
					task: string[];
					kind: string;
					planned?: boolean;
					requestId?: string;
				},
			) =>
				run(options, async (client) =>
					client.objectives.manualLineage.mutate(
						objectiveManualLineageSchema.parse({
							id,
							expectedRevision: Number(options.revision),
							parentTaskId: options.parent,
							taskIds: options.task,
							kind: options.kind,
							planned: options.planned ?? false,
							requestId: options.requestId ?? randomUUID(),
						}),
					),
				),
		);
	for (const action of ["pause", "resume", "override", "acknowledge", "revoke"] as const) {
		common(objective.command(`${action} <id>`))
			.requiredOption("--revision <number>", "Current revision from objective read.")
			.requiredOption("--reason <text>", "User-owned audit reason; not acceptance or benchmark execution approval.")
			.option("--task <task>", "One own task, required for override.")
			.option("--kind <start|input>", "One future admission operation, required for override.")
			.option(
				"--reservation <uuid>",
				"Retained uncertain reservation, required for acknowledgement (charge/history retained).",
			)
			.option("--request-id <uuid>", "Exact retry identity.")
			.option("--control <uuid>", "Unused own override id to revoke; no refund, replay or process stop.")
			.action(
				async (
					id: string,
					options: Options & {
						revision: string;
						reason: string;
						task?: string;
						kind?: string;
						reservation?: string;
						control?: string;
						requestId?: string;
					},
				) =>
					run(options, async (client) =>
						client.objectives.control.mutate(
							objectiveControlRequestSchema.parse({
								id,
								action,
								expectedRevision: Number(options.revision),
								reason: options.reason,
								taskId: options.task ?? null,
								kind: options.kind ?? null,
								reservationId: options.reservation ?? null,
								controlId: options.control ?? null,
								requestId: options.requestId ?? randomUUID(),
							}),
						),
					),
			);
	}
	common(objective.command("list")).action(
		async (options: Options) =>
			await run(options, async (client) => await client.objectives.list.query({ offset: 0, limit: 20 })),
	);
	common(objective.command("read <id>")).action(
		async (id: string, options: Options) =>
			await run(options, async (client) => await client.objectives.read.query({ id: objectiveIdSchema.parse(id) })),
	);
	common(
		objective
			.command("recheck <id>")
			.description(
				"User-only: collect retained owner receipts again. No checks/QA/model rerun, task resume or guard override.",
			),
	).action(
		async (id: string, options: Options) =>
			await run(
				options,
				async (client) => await client.objectives.recheck.mutate({ id: objectiveIdSchema.parse(id) }),
			),
	);
	common(
		objective
			.command("limits <id>")
			.description(
				"Set revision-checked user-owned limits; enforcement is explicit opt-in for Kanban admission, not a guaranteed spending cap.",
			),
	)
		.requiredOption("--revision <number>", "Objective revision shown by read; stale changes are refused.")
		.option("--attempts <number|none>", "Observed attempt threshold, or none to clear it.")
		.option("--minutes <number|none>", "Elapsed-time reporting threshold, or none.")
		.option("--usd <number|none>", "Estimated-cost reporting threshold, or none; unknown coverage is not zero.")
		.option("--unknown-cost <hold|allow>", "User choice for incomplete cost coverage (future admission policy).")
		.option("--mode <report|enforce>", "Explicit opt-in Kanban-admission enforcement; report is the default.")
		.option(
			"--acknowledge-admission-scope",
			"Enforce Kanban-issued starts/prompts only, not internal CLI calls, user keystrokes or a guaranteed spending cap.",
		)
		.option("--request-id <uuid>", "Reuse this id for an exact retry after an uncertain response.")
		.action(
			async (
				id: string,
				options: Options & {
					revision: string;
					attempts?: string;
					minutes?: string;
					usd?: string;
					unknownCost?: string;
					mode?: string;
					requestId?: string;
					acknowledgeAdmissionScope?: boolean;
				},
			) => {
				await run(options, async (client) => {
					const target = objectiveIdSchema.parse(id);
					const { objective: current } = await client.objectives.read.query({ id: target });
					const threshold = (value: string | undefined, previous: number | null) =>
						value === undefined ? previous : value === "none" ? null : Number(value);
					const input = objectiveLimitsRequestSchema.parse({
						id: target,
						expectedRevision: Number(options.revision),
						requestId: options.requestId ?? randomUUID(),
						limits: {
							...current.limits,
							maxAttempts: threshold(options.attempts, current.limits.maxAttempts),
							maxElapsedMinutes: threshold(options.minutes, current.limits.maxElapsedMinutes),
							maxEstimatedUsd: threshold(options.usd, current.limits.maxEstimatedUsd),
							unknownCost: options.unknownCost ?? current.limits.unknownCost,
							mode: options.mode ?? current.limits.mode,
						},
						acknowledgeAdmissionScope: options.acknowledgeAdmissionScope ?? false,
					});
					return await client.objectives.setLimits.mutate(input);
				});
			},
		);
	common(objective.command("create <title>"))
		.requiredOption("--file <path>", "Pinned requirements Markdown (not a plan execution approval).")
		.requiredOption("--task <ids...>", "Existing dev tasks in this project's board.")
		.action(async (title: string, options: Options & { file: string; task: string[] }) => {
			await run(
				options,
				async (client) =>
					await client.objectives.create.mutate(
						objectiveCreateSchema.parse({
							requestId: randomUUID(),
							title,
							requirements: await readKnowledgeMarkdown(options.file),
							taskIds: options.task,
						}),
					),
			);
		});
}
