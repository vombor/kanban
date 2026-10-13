// The runtime side of `kanban restart update` (docs/fork/container-lifecycle.md, "Updating from inside"): restarts the
// pod's container onto the registry's newer build of its channel's tag (`update.imageChannel`: `:latest` by default,
// `:stable` for a pod that runs releases, where the answer names them: "v0.1.70-fork.8 is out (running …)"). Kanban can't pull an image from inside its container, so it
// does the part only it can: it checks, runs the restart prepare the image entrypoint runs on a stop (WIP tags +
// restart manifest, with the update recorded for the restart wake), shuts the server down gracefully and exits with
// KANBAN_UPDATE_RESTART_EXIT_CODE. The entrypoint passes that status on, the container exits, and the Quadlet unit's
// `Restart=always` starts it again, where `Pull=newer` pulls the newer image first.
//
// Every decision is here, never in the CLI: the caller (cli-scope.ts's decideKanbanOrchestratorCaller with the strict
// lookup: the user's, apart from the orchestrator of `providers.setupWorkspaceId` where it is registered; any other
// orchestrator, every card and an unidentified caller are refused), running in a container (/run/.containerenv), a newer image
// (the running build's stamp against the channel tag's labels) and no card In Progress; `force` skips the last two. Every
// request, refused or not, goes to the server log and `<home>/logs/restart-update.jsonl`.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getWorkspacePipelineSettings, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeWorkspaceStateResponse } from "../core/api-contract";
import { decideKanbanOrchestratorCaller } from "../isolation/cli-scope";
import type { IsolationService } from "../isolation/isolation-service";
import { describeCaller } from "../isolation/session-identity";
import { getRecoveryScope } from "../pipeline/engine";
import {
	isProcessAlive,
	type PrepareWorkspaceRestartInput,
	prepareWorkspaceRestart,
	type RestartPrepareTarget,
} from "../pipeline/restart-prepare";
import type { RestartManifestUpdate } from "../pipeline/restart-recovery";
import { getKanbanLogsPath } from "../state/kanban-home";
import {
	type ContainerImageBuild,
	compareImageBuilds,
	describeChannelRelease,
	describeImageBuild,
	fetchLatestImageBuild,
	getChannelImageRef,
	getImageRelease,
	getImageReleaseUrl,
	isRunningInContainer,
	KANBAN_IMAGE_CREATED_ENV,
	KANBAN_IMAGE_REVISION_ENV,
	KANBAN_IMAGE_VERSION_ENV,
	readRunningImageBuild,
} from "../update/container-image";
import type { KanbanImageChannel } from "../update/image-channel";
import type { RestartUpdateResponse, RuntimeRestartUpdateApi } from "./restart-update-contract";

/** EX_TEMPFAIL: "restart me". The entrypoint logs it as an update restart and exits with it. */
export const KANBAN_UPDATE_RESTART_EXIT_CODE = 75;

const RESTART_UPDATE_COMMAND = "restart update";

export interface RestartUpdateLogEntry {
	at: string;
	caller: string;
	status: RestartUpdateResponse["status"];
	message: string;
	force: boolean;
	dryRun: boolean;
	channel: KanbanImageChannel;
	from: ContainerImageBuild | null;
	to: ContainerImageBuild | null;
	inProgress: string[];
}

export interface CreateRestartUpdateApiDependencies {
	log: IsolationService["log"];
	/** The server log. */
	warn: (message: string) => void;
	/** Every registered workspace with its main checkout. */
	listWorkspaces: () => Promise<RestartPrepareTarget[]>;
	/** A workspace's live board and session summaries. */
	loadState: (target: RestartPrepareTarget) => Promise<RuntimeWorkspaceStateResponse>;
	/** Shuts the server down gracefully and exits with the code (cli.ts's shutdown handlers). */
	requestExit: (exitCode: number) => void;
	/** `providers.setupWorkspaceId`; tests inject it. */
	readSetupWorkspaceId?: () => Promise<string>;
	isInContainer?: () => boolean;
	/** `update.imageChannel`: the tag the pod's Quadlet unit follows. */
	readImageChannel?: () => Promise<KanbanImageChannel>;
	readRunningBuild?: () => ContainerImageBuild | null;
	fetchLatestBuild?: (channel: KanbanImageChannel) => Promise<ContainerImageBuild>;
	/** What restart recovery does for an In Progress card of the workspace after the restart. */
	describeRecovery?: (workspaceId: string) => Promise<string>;
	prepareWorkspace?: (input: PrepareWorkspaceRestartInput) => Promise<number>;
	appendLog?: (entry: RestartUpdateLogEntry) => Promise<void>;
	/** How long the answer gets to reach the CLI before the shutdown starts. */
	exitDelayMs?: number;
	now?: () => number;
}

export function getRestartUpdateLogPath(): string {
	return join(getKanbanLogsPath(), "restart-update.jsonl");
}

async function appendRestartUpdateLog(entry: RestartUpdateLogEntry): Promise<void> {
	const path = getRestartUpdateLogPath();
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

async function describeRecoveryFromConfig(workspaceId: string): Promise<string> {
	const { config } = await readPipelineConfig();
	return getRecoveryScope(config, getWorkspacePipelineSettings(config, workspaceId)).act
		? "restart recovery resumes it"
		: "restart recovery doesn't act here: resume it with kanban task resume <id>";
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message : String(error);
}

export function createRestartUpdateApi(deps: CreateRestartUpdateApiDependencies): RuntimeRestartUpdateApi {
	const readSetupWorkspaceId =
		deps.readSetupWorkspaceId ?? (async () => (await readPipelineConfig()).config.providers.setupWorkspaceId);
	const isInContainer = deps.isInContainer ?? (() => isRunningInContainer());
	const readImageChannel =
		deps.readImageChannel ?? (async () => (await readPipelineConfig()).config.update.imageChannel);
	const readRunningBuild = deps.readRunningBuild ?? (() => readRunningImageBuild());
	const fetchLatestBuild = deps.fetchLatestBuild ?? ((channel) => fetchLatestImageBuild({ channel }));
	const describeRecovery = deps.describeRecovery ?? describeRecoveryFromConfig;
	const prepareWorkspace = deps.prepareWorkspace ?? prepareWorkspaceRestart;
	const appendLog = deps.appendLog ?? appendRestartUpdateLog;
	const now = deps.now ?? Date.now;
	let restarting = false;

	const listInProgress = async (): Promise<Array<{ target: RestartPrepareTarget; taskIds: string[] }>> => {
		const found: Array<{ target: RestartPrepareTarget; taskIds: string[] }> = [];
		for (const target of await deps.listWorkspaces()) {
			const state = await deps.loadState(target).catch(() => null);
			const taskIds =
				state?.board.columns.find((column) => column.id === "in_progress")?.cards.map((card) => card.id) ?? [];
			if (taskIds.length > 0) {
				found.push({ target, taskIds });
			}
		}
		return found;
	};

	return {
		update: async (caller, request) => {
			const who = describeCaller(caller);
			const lines: string[] = [];
			let from: ContainerImageBuild | null = null;
			let to: ContainerImageBuild | null = null;
			let inProgress: string[] = [];
			let channel: KanbanImageChannel = "latest";
			const finish = async (
				status: RestartUpdateResponse["status"],
				message: string,
			): Promise<RestartUpdateResponse> => {
				deps.warn(
					`[kanban] restart update (${who}${request.force ? ", --force" : ""}${request.dryRun ? ", --dry-run" : ""}): ${status}: ${message}`,
				);
				await appendLog({
					at: new Date(now()).toISOString(),
					caller: who,
					status,
					message,
					force: request.force,
					dryRun: request.dryRun,
					channel,
					from,
					to,
					inProgress,
				}).catch((error: unknown) => {
					deps.warn(`[kanban] could not write ${getRestartUpdateLogPath()}: ${toErrorMessage(error)}`);
				});
				return { status, message, lines };
			};

			const kanbanWorkspaceId = await readSetupWorkspaceId();
			const decision = decideKanbanOrchestratorCaller(caller, kanbanWorkspaceId, RESTART_UPDATE_COMMAND);
			if (!decision.allowed) {
				const fromWorkspaceId = caller.kind === "session" ? caller.session.workspaceId : null;
				await deps.log([kanbanWorkspaceId, fromWorkspaceId], {
					kind: "refused",
					taskId: caller.kind === "session" ? caller.session.taskId : null,
					from: fromWorkspaceId,
					to: kanbanWorkspaceId,
					action: "restart.update",
					detail: `restart update is the user's (${who})`,
				});
				return await finish("refused", decision.message);
			}
			if (restarting) {
				return await finish("refused", "An update restart is already under way.");
			}
			if (!isInContainer()) {
				return await finish(
					"refused",
					"Kanban doesn't run in a container here (no /run/.containerenv): `kanban restart update` restarts the pod's container onto a newer image, so outside one there is nothing to update. Update this install with `kanban update` and restart it yourself.",
				);
			}

			channel = await readImageChannel().catch(() => channel);
			const imageRef = getChannelImageRef(channel);
			from = readRunningBuild();
			try {
				to = await fetchLatestBuild(channel);
			} catch (error) {
				if (!request.force) {
					return await finish(
						"refused",
						`Could not read ${imageRef} from the registry (${toErrorMessage(error)}), so there is no telling whether a newer image exists; --force restarts anyway.`,
					);
				}
				lines.push(`could not read ${imageRef} (${toErrorMessage(error)}); --force restarts anyway`);
			}
			const fromText = describeImageBuild(from);
			const toText = to ? `${describeImageBuild(to)}${to.digest ? `, ${to.digest}` : ""}` : "an unknown build";
			lines.push(`running: ${fromText}`, `${imageRef}: ${toText}`);
			const release = to ? describeChannelRelease(channel, from, to) : null;
			// Linked only when the channel holds another release than the one running.
			const releaseUrl = getImageRelease(to) !== getImageRelease(from) ? getImageReleaseUrl(to) : null;
			if (release) {
				lines.push(releaseUrl ? `${release}; release notes: ${releaseUrl}` : release);
			}
			if (channel === "stable" && from && !getImageRelease(from)) {
				lines.push(
					`the running image is not a release build (no ${KANBAN_IMAGE_VERSION_ENV}): a :latest or branch image, although update.imageChannel is stable`,
				);
			}
			if (to && !request.force) {
				const check = compareImageBuilds(from, to);
				if (check.kind === "current") {
					return await finish(
						"refused",
						channel === "stable" && getImageRelease(to)
							? `Already on the latest release (${fromText}): nothing to update.`
							: `Already on the latest image (${fromText}): nothing to update.`,
					);
				}
				if (check.kind === "older") {
					return await finish(
						"refused",
						channel === "stable" && !getImageRelease(from)
							? `The running image is a non-release build (${fromText}) newer than ${imageRef} (${describeImageBuild(to)}); --force restarts onto the release anyway.`
							: `${imageRef} (${describeImageBuild(to)}) is older than the running image (${fromText}); --force restarts onto it anyway.`,
					);
				}
				if (check.kind === "unknown_running") {
					return await finish(
						"refused",
						`The running image has no build stamp (${KANBAN_IMAGE_REVISION_ENV}/${KANBAN_IMAGE_CREATED_ENV}: not an image CI built), so there is no telling whether ${imageRef} is newer; --force restarts anyway.`,
					);
				}
			}

			const running = await listInProgress();
			inProgress = running.flatMap((entry) =>
				entry.taskIds.map((taskId) => `${entry.target.workspaceId}/${taskId}`),
			);
			if (running.length > 0) {
				if (!request.force) {
					return await finish(
						"refused",
						`Cards are In Progress (${inProgress.join(", ")}): their agents stop with the container. Wait until they reach Review, or --force (restart recovery resumes them after the restart where pipeline.recovery.mode is on).`,
					);
				}
				for (const entry of running) {
					const recovery = await describeRecovery(entry.target.workspaceId).catch(
						() => "check it after the restart",
					);
					lines.push(
						`In Progress in ${entry.target.workspaceId}: ${entry.taskIds.join(", ")} (stops with the container; ${recovery})`,
					);
				}
			}

			const update: RestartManifestUpdate = { from, to, channel };
			const targets = await deps.listWorkspaces();
			for (const target of targets) {
				const print = (line: string) => lines.push(line);
				try {
					const state = await deps.loadState(target);
					await prepareWorkspace({ target, state, dryRun: request.dryRun, print, isProcessAlive, update });
				} catch (error) {
					lines.push(`${target.workspaceId}: restart prepare failed: ${toErrorMessage(error)}`);
				}
			}
			const summary = `from ${fromText} to ${toText}`;
			if (request.dryRun) {
				return await finish(
					"dry_run",
					`Would restart the container ${summary} [dry-run]: nothing tagged, written or stopped.`,
				);
			}
			restarting = true;
			const response = await finish(
				"restarting",
				`Restarting the container ${summary}: Kanban shuts down and exits with ${KANBAN_UPDATE_RESTART_EXIT_CODE}; the unit's Restart=always starts the container again and Pull=newer pulls the newer image first.`,
			);
			setTimeout(() => {
				deps.requestExit(KANBAN_UPDATE_RESTART_EXIT_CODE);
			}, deps.exitDelayMs ?? 1_000);
			return response;
		},
	};
}
