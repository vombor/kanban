// `kanban orchestrator wake|run`: wake the orchestrator (the agent selected in Kanban settings) now or once a condition
// holds, and the headless run the watchdog starts. The watchdog does the waking (src/pipeline/watchdog/), so a wake
// request is a line in the workspace's request file that the next watchdog tick picks up. Ported from
// archive/devteam-kit:bin/orchestrator-wake.mjs@6da71597 and bin/wake-when.mjs@6da71597.
import type { Command } from "commander";

import { readPipelineConfig, resolveWorkspaceWakeSettings } from "../config/pipeline-config";
import { type RuntimeAgentId, runtimeAgentIdSchema } from "../core/api-contract";
import { runOrchestratorHeadless } from "../pipeline/watchdog/headless-run";
import {
	addWakeRequest,
	DEFAULT_WAKE_REQUEST_TIMEOUT_MIN,
	type WakeRequestCondition,
} from "../pipeline/watchdog/wake-requests";
import { getWatchdogWorkspacePaths } from "../state/kanban-home";
import { resolveWorkspaceTarget } from "./workspace-target";

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function parsePositiveNumber(value: string): number {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) {
		throw new Error(`Expected a positive number, got "${value}".`);
	}
	return number;
}

function parseNonNegativeNumber(value: string): number {
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) {
		throw new Error(`Expected a non-negative number, got "${value}".`);
	}
	return number;
}

function parseAgentId(value: string): RuntimeAgentId {
	const parsed = runtimeAgentIdSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`Unknown agent "${value}".`);
	}
	return parsed.data;
}

interface WakeCommandOptions {
	workspace?: string;
	whenCardDone?: string;
	whenModelUp?: string;
	provider?: string;
	timeoutMin?: number;
}

export function registerOrchestratorCommand(program: Command): void {
	const orchestrator = program
		.command("orchestrator")
		.description("Wake the orchestrator (the agent selected in Kanban settings) through the watchdog.");

	orchestrator
		.command("wake")
		.description(
			"Queue an issue for the orchestrator: woken on the next watchdog tick, or once --when-card-done / --when-model-up holds.",
		)
		.argument("<issue...>", "What the orchestrator should look at (one line).")
		.option(
			"--workspace <workspace>",
			"The workspace the issue is about (id or project path; default: the current project).",
		)
		.option("--when-card-done <taskId>", "Wake once this card is in Done or deleted (a card id prefix matches).")
		.option(
			"--when-model-up <model>",
			"Wake once `kanban models probe` gets an answer from this model, twice a minute apart.",
		)
		.option("--provider <id>", "The provider for --when-model-up (default: models.providers.default).")
		.option(
			"--timeout-min <minutes>",
			`Wake anyway after this long (default ${DEFAULT_WAKE_REQUEST_TIMEOUT_MIN}).`,
			parsePositiveNumber,
		)
		.action(async (issueWords: string[], options: WakeCommandOptions) => {
			try {
				if (options.whenCardDone && options.whenModelUp) {
					throw new Error("Pass --when-card-done or --when-model-up, not both.");
				}
				const target = await resolveWorkspaceTarget(options.workspace, { allowUnregistered: false });
				const { config } = await readPipelineConfig();
				const when: WakeRequestCondition | null = options.whenCardDone
					? { kind: "card-done", taskId: options.whenCardDone.trim() }
					: options.whenModelUp
						? {
								kind: "model-up",
								model: options.whenModelUp.trim(),
								provider: options.provider?.trim() || config.models.providers.default,
							}
						: null;
				const request = await addWakeRequest(getWatchdogWorkspacePaths(target.workspaceId).wakeRequests, {
					issue: issueWords.join(" "),
					when,
					timeoutMin: options.timeoutMin,
				});
				const warnings: string[] = [];
				if (config.watchdog.mode !== "on") {
					warnings.push(
						`watchdog.mode is "${config.watchdog.mode}": the request is kept but nothing wakes the orchestrator until it is "on".`,
					);
				}
				if (!resolveWorkspaceWakeSettings(config, target.workspaceId).enabled) {
					warnings.push(
						`orchestrator wakes are off for ${target.workspaceId} (orchestrator.wake.enabled or workspaces.<id>.orchestrator.wake.enabled): the request is listed in the workspace's ATTENTION.md and waits until wakes are on.`,
					);
				}
				for (const warning of warnings) {
					process.stderr.write(`Warning: ${warning}\n`);
				}
				process.stdout.write(
					`${JSON.stringify({ ok: true, workspaceId: target.workspaceId, request, warnings }, null, 2)}\n`,
				);
			} catch (error) {
				process.stderr.write(`Orchestrator wake failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});

	// Started detached by the watchdog for a headless wake; can be run by hand with --ignore-live to test a pass.
	orchestrator
		.command("run", { hidden: true })
		.description("Run the headless orchestrator for the workspace's queued issues (the watchdog starts it).")
		.requiredOption("--workspace <workspaceId>", "The orchestrator's workspace id.")
		.requiredOption("--project <path>", "Its project path (the run's working directory).")
		.requiredOption("--agent <agentId>", "The agent to run headless (the selected agent).", parseAgentId)
		.option("--timeout-min <minutes>", "Stop a pass after this long.", parsePositiveNumber, 45)
		.option(
			"--live-session-min <minutes>",
			"An interactive session this recent blocks the run.",
			parseNonNegativeNumber,
			10,
		)
		.option("--ignore-live", "Run even while an interactive session is live.")
		.action(
			async (options: {
				workspace: string;
				project: string;
				agent: RuntimeAgentId;
				timeoutMin: number;
				liveSessionMin: number;
				ignoreLive?: boolean;
			}) => {
				try {
					const result = await runOrchestratorHeadless({
						workspaceId: options.workspace,
						projectPath: options.project,
						agentId: options.agent,
						timeoutMin: options.timeoutMin,
						liveSessionMin: options.liveSessionMin,
						ignoreLive: options.ignoreLive === true,
					});
					process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
				} catch (error) {
					process.stderr.write(`Orchestrator run failed: ${toErrorMessage(error)}\n`);
					process.exitCode = 1;
				}
			},
		);
}
