// Project isolation inside a Kanban CLI process that an agent session runs (docs/fork/project-isolation.md). The
// runtime API checks every call itself (src/trpc/app-router.ts), but many commands read and write the board files
// in-process (`kanban task create`, doctor, kit, bench). A CLI started with a session credential in its env scopes
// itself here: other workspaces under `enforce` disappear from its listings and can't be opened, registering a project
// is refused, and the machine-wide commands are refused under `enforce`. The server is asked who the session is
// (`isolation.whoami`, which knows the user's grants); when it can't be reached the env's workspace id and the local
// config decide, without grants. A guard against ordinary use, not a sandbox: a process that drops its env gets past
// it, which is why the runtime also traces credential-less calls to the session's process tree. With isolation off
// everywhere nothing is scoped (the CLI behaves as before); only the user-only commands stay refused, and the Kanban
// orchestrator's commands (KANBAN_ORCHESTRATOR_OR_USER_COMMANDS) are asked of the server, in a session or not. Outside a
// session, `kanban project add|create` waits for the console-code approval while some workspace is in `enforce`.

import type { RuntimeTrpcClient } from "../commands/runtime-trpc-client";
import type { IsolationMode, PipelineConfig } from "../config/pipeline-config";
import { getDefaultKanbanHomePath, getKanbanHomePath } from "../state/kanban-home";
import { readLiveKanbanServerLock } from "../state/kanban-server-lock";
import { listWorkspaceIndexEntries, setWorkspaceAccessGuard } from "../state/workspace-state";
import { describeIsolationAction } from "./action-names";
import { type CompleteApprovalInput, completeIsolationApproval } from "./cli-approval";
import { appendIsolationLog } from "./isolation-log";
import {
	isAnyWorkspaceEnforced,
	readIsolationConfig,
	resolveIsolationMode,
	resolveReachIsolationMode,
} from "./isolation-settings";
import {
	describeCaller,
	KANBAN_SESSION_CREDENTIAL_ENV,
	KANBAN_SESSION_WORKSPACE_ENV,
	type RuntimeCaller,
} from "./session-identity";

export interface CliSessionScope {
	workspaceId: string;
	taskId: string | null;
	role: "orchestrator" | "card" | null;
	/** The session's own workspace mode. */
	mode: IsolationMode;
	/** Workspaces the server says the session may reach (its grants included); null when it couldn't be asked. */
	serverReachable: string[] | null;
}

/**
 * The CLI commands that change machine-wide state (config.json, kits, the home, the agents' config, the server):
 * the user's, refused from an agent session under `enforce`. Matched against the command path (`home migrate`).
 */
export const MACHINE_WIDE_COMMANDS = [
	"config import-kit",
	"setup",
	"home migrate",
	"models providers",
	"models prices sync",
	"restart prepare",
	"restart recover",
	"pipeline import-legacy",
	"board restore",
] as const;

/**
 * Commands no agent session may run, whatever the isolation mode: registering and renaming projects, grants, writing
 * Cline's files and approving a plan are the user's (and `plan expand --approved-by-user`).
 */
export const USER_ONLY_COMMANDS = [
	"project add",
	"project create",
	// Also refuses while a server runs, so it can't wait for the console code (the server prints it).
	"project rename-id",
	// Changes card worktrees: the user decides when a card's shared links go.
	"project unlink-ignored",
	"isolation grant",
	"isolation revoke",
	"isolation approve",
	// Only models.lists.lemonade.include: which Lemonade models Cline offers every project (src/commands/config.ts).
	"config set",
	"config unset",
	"plan approve",
	// Moves team keys into a new user kit and switches the project to it: a change of the project's team.
	"kit migrate-overrides",
	// Write user kit files: the team definition of every project on that kit (src/kits/user-kit-edit.ts).
	"kit create",
	"kit edit",
	// Creates the machine's Kanban GitHub App, whose key the server keeps (src/github-app/).
	"github bot create",
] as const;

/** The plan approval refusal (the server's, src/trpc/plans-api.ts, says the same). */
function planApprovalRefusal(taskId: string | undefined): string {
	return `Plan approval is the user's; ask them to run kanban plan approve ${taskId ?? "<id>"} or use the board.`;
}

/**
 * Commands only the user and a project's orchestrator may run, whatever the isolation mode: a card session is
 * refused. `issues sync` calls GitHub with the user's own token (the `gh` login or `GH_TOKEN`); `kit apply` switches
 * the project's kit and `kit set|unset` change its settings on it (the server checks the caller again, also for
 * another project's orchestrator, src/trpc/kit-settings-api.ts), and
 * `shortcut add|remove` its top-bar shortcuts (src/trpc/shortcuts-api.ts checks again), and `pipeline pause|resume`
 * its QA pipeline (src/trpc/pipeline-pause-api.ts checks again), and `project rename` its display name
 * (src/trpc/project-name-api.ts checks again).
 */
export const ORCHESTRATOR_OR_USER_COMMANDS = [
	"issues sync",
	"kit apply",
	"kit set",
	"kit unset",
	"models vet",
	"pipeline pause",
	"pipeline resume",
	"project rename",
	"shortcut add",
	"shortcut remove",
] as const;

function orchestratorOrUserRefusal(commandPath: string): string {
	const why =
		commandPath === "issues sync"
			? "uses the user's GitHub login"
			: commandPath === "models vet"
				? "starts a smoke-test card on another agent and model"
				: commandPath === "project rename"
					? "changes the project's display name"
					: commandPath.startsWith("shortcut ")
						? "changes the project's shortcuts"
						: commandPath.startsWith("pipeline ")
							? "pauses or resumes the project's QA pipeline"
							: commandPath === "kit apply"
								? "switches the project's routing kit"
								: "changes the project's settings on its kit (models, project facts)";
	return `\`kanban ${commandPath}\` ${why}, so only the user or the project's orchestrator runs it, never a card session. Tell your orchestrator what you need.`;
}

/**
 * Commands only the user and the Kanban project's own orchestrator (its sidebar session or headless wake; the workspace
 * is `providers.setupWorkspaceId`, default kanban-2uge) may run, whatever the isolation mode: `setup-provider` writes
 * a model provider's settings into Cline's files, which every project's Cline cards use, and `restart update` restarts
 * the pod's container onto a newer image, which stops every project's agents (the server's `restart.update` route
 * checks the caller again, src/trpc/restart-update-api.ts). Every other project's orchestrator and every card session
 * are refused. The running server decides who calls (`providers.authorizeSetup`,
 * the strict caller lookup: a session without its credential is traced to its process tree, an unidentified caller is
 * refused), outside a session too, since a card that drops its credential looks like the user from here.
 */
export const KANBAN_ORCHESTRATOR_OR_USER_COMMANDS = ["setup-provider", "restart update"] as const;

export type KanbanOrchestratorCallerDecision = { allowed: true } | { allowed: false; message: string };

function kanbanOrchestratorOrUserRefusal(commandPath: string, kanbanWorkspaceId: string, who: string): string {
	const [why, ask] =
		commandPath === "restart update"
			? [
					"restarts the pod's container onto a newer image, which stops every project's agents",
					"that an update is due",
				]
			: [
					"writes model providers' settings into Cline's files, which every project's Cline cards use",
					"which provider needs setting up",
				];
	return `\`kanban ${commandPath}\` ${why}, so only the user or the Kanban project's orchestrator (workspace ${kanbanWorkspaceId}) runs it; ${who} can't. Tell your orchestrator or the user ${ask}.`;
}

/** The one rule for KANBAN_ORCHESTRATOR_OR_USER_COMMANDS, asked by the server's route with the strict caller. */
export function decideKanbanOrchestratorCaller(
	caller: RuntimeCaller,
	kanbanWorkspaceId: string,
	commandPath: string = KANBAN_ORCHESTRATOR_OR_USER_COMMANDS[0],
): KanbanOrchestratorCallerDecision {
	if (caller.kind === "user") {
		return { allowed: true };
	}
	if (
		caller.kind === "session" &&
		caller.session.role === "orchestrator" &&
		caller.session.workspaceId === kanbanWorkspaceId
	) {
		return { allowed: true };
	}
	return {
		allowed: false,
		message: kanbanOrchestratorOrUserRefusal(commandPath, kanbanWorkspaceId, describeCaller(caller)),
	};
}

function isLiveServerOnHome(): boolean {
	// The default home too: a `--home` elsewhere still writes the same Cline files.
	return [getKanbanHomePath(), getDefaultKanbanHomePath()].some((home) => readLiveKanbanServerLock(home) !== null);
}

/**
 * Asks the running server whether this process may run a KANBAN_ORCHESTRATOR_OR_USER_COMMANDS command. Without an
 * answer only a process with no session credential and no live Kanban server goes ahead: no agent session outlives its
 * server, so that is the user. Returns the refusal, or null.
 */
async function requireKanbanOrchestratorOrUser(input: {
	commandPath: string;
	env: NodeJS.ProcessEnv;
	createClient: () => Pick<RuntimeTrpcClient, "providers">;
	isServerRunning: () => boolean;
	timeoutMs?: number;
}): Promise<string | null> {
	const command = KANBAN_ORCHESTRATOR_OR_USER_COMMANDS.find((entry) => matchesCommandPath(input.commandPath, [entry]));
	const answer = await Promise.race([
		Promise.resolve()
			.then(() => input.createClient().providers.authorizeSetup.query({ command }))
			.catch(() => null),
		new Promise<null>((resolve) => setTimeout(() => resolve(null), input.timeoutMs ?? 5000).unref()),
	]);
	if (answer) {
		return answer.allowed ? null : (answer.message ?? `\`kanban ${input.commandPath}\` was refused.`);
	}
	if (readSessionCredential(input.env)) {
		return `\`kanban ${input.commandPath}\` runs only for the user or the Kanban project's orchestrator, and the running Kanban server, which decides who calls, could not be reached.`;
	}
	if (input.isServerRunning()) {
		return `\`kanban ${input.commandPath}\`: a Kanban server runs on this machine but could not be asked who calls (it decides who may run this; an older server must be restarted first).`;
	}
	return null;
}

/** The project changes that wait for an approval under `enforce` (src/isolation/approvals.ts). */
const PROJECT_CHANGE_COMMANDS = { "project add": "project.add", "project create": "project.create" } as const;

export function readSessionCredential(env: NodeJS.ProcessEnv = process.env): string | null {
	return env[KANBAN_SESSION_CREDENTIAL_ENV]?.trim() || null;
}

/** The decision on one workspace: the session's own and reachable ones are allowed. */
export function decideCliWorkspaceAccess(
	scope: CliSessionScope,
	config: PipelineConfig,
	workspaceId: string,
): "allow" | "report" | "refuse" {
	if (workspaceId === scope.workspaceId) {
		return "allow";
	}
	const mode = resolveReachIsolationMode(config, scope.workspaceId, workspaceId);
	if (mode === "off") {
		return "allow";
	}
	if (mode === "report") {
		return "report";
	}
	return scope.serverReachable?.includes(workspaceId) ? "allow" : "refuse";
}

/** The session this CLI process runs for, or null when it isn't an agent session's. */
export async function resolveCliSessionScope(input: {
	env?: NodeJS.ProcessEnv;
	config: PipelineConfig;
	client: Pick<RuntimeTrpcClient, "isolation"> | null;
	timeoutMs?: number;
}): Promise<CliSessionScope | null> {
	const env = input.env ?? process.env;
	if (!readSessionCredential(env)) {
		return null;
	}
	const envWorkspaceId = env[KANBAN_SESSION_WORKSPACE_ENV]?.trim() || null;
	const whoami = input.client
		? await Promise.race([
				input.client.isolation.whoami.query().catch(() => null),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), input.timeoutMs ?? 3000).unref()),
			])
		: null;
	if (whoami?.caller === "session" && whoami.workspaceId) {
		return {
			workspaceId: whoami.workspaceId,
			taskId: whoami.taskId,
			role: whoami.role,
			mode: whoami.mode,
			serverReachable: whoami.reachable ?? null,
		};
	}
	if (!envWorkspaceId) {
		return null;
	}
	return {
		workspaceId: envWorkspaceId,
		taskId: null,
		role: null,
		mode: resolveIsolationMode(input.config, envWorkspaceId),
		serverReachable: null,
	};
}

/** The scope as the board-file layer's guard (workspace-state.ts setWorkspaceAccessGuard); `commandPath` names it. */
export async function installCliWorkspaceGuard(
	scope: CliSessionScope,
	config: PipelineConfig,
	commandPath: string = process.argv.slice(2, 4).join(" "),
): Promise<void> {
	setWorkspaceAccessGuard(null);
	const ownRepoPath =
		(await listWorkspaceIndexEntries()).find((entry) => entry.workspaceId === scope.workspaceId)?.repoPath ?? null;
	const logged = new Set<string>();
	const logOnce = async (workspaceId: string, kind: "reported" | "grant_used", logTo: readonly string[]) => {
		if (logged.has(workspaceId)) {
			return;
		}
		logged.add(workspaceId);
		for (const target of logTo) {
			await appendIsolationLog(target, {
				at: new Date().toISOString(),
				kind,
				taskId: scope.taskId,
				fromWorkspaceId: scope.workspaceId,
				toWorkspaceId: workspaceId,
				action: `cli ${process.argv.slice(2, 4).join(" ")}`.trim(),
				detail:
					kind === "grant_used" ? "in-process board access under the user's grant" : "in-process board access",
			});
		}
	};
	setWorkspaceAccessGuard({
		check: async (workspaceId) => {
			const decision = decideCliWorkspaceAccess(scope, config, workspaceId);
			if (decision === "report") {
				await logOnce(workspaceId, "reported", [scope.workspaceId]);
			} else if (
				decision === "allow" &&
				workspaceId !== scope.workspaceId &&
				resolveReachIsolationMode(config, scope.workspaceId, workspaceId) === "enforce"
			) {
				// Only a grant lets an enforce reach through (the server's reachable list): logged on both sides.
				await logOnce(workspaceId, "grant_used", [scope.workspaceId, workspaceId]);
			}
			return decision === "refuse" ? "refuse" : "allow";
		},
		describeRefusal: ({ workspaceId, repoPath }) =>
			workspaceId
				? `Project isolation refused "${describeIsolationAction(`cli ${commandPath}`, workspaceId)}": this session works only on its own Kanban project${ownRepoPath ? ` (${ownRepoPath})` : ""}; ${repoPath} is not part of it.`
				: `\`kanban ${commandPath}\` names ${repoPath}, which is not a registered Kanban project, and only the user registers projects.${ownRepoPath ? ` For this session's project pass --project-path ${ownRepoPath}.` : ""}`,
	});
}

function isAnyIsolationOn(config: PipelineConfig): boolean {
	return (
		config.isolation.mode !== "off" ||
		Object.values(config.workspaces).some((workspace) => (workspace.isolation.mode ?? "off") !== "off")
	);
}

export function matchesCommandPath(commandPath: string, list: readonly string[]): boolean {
	return list.some((entry) => commandPath === entry || commandPath.startsWith(`${entry} `));
}

/**
 * Outside a session: a project add/create while some workspace is in `enforce` waits for the user's console code
 * (the server refuses the request when the process is traced to a session). Returns the refusal, or null.
 */
async function requireProjectChangeApproval(input: {
	commandPath: keyof typeof PROJECT_CHANGE_COMMANDS;
	args: readonly string[];
	createClient: () => Pick<RuntimeTrpcClient, "isolation">;
	approval?: Partial<CompleteApprovalInput>;
}): Promise<string | null> {
	if (!isAnyWorkspaceEnforced(await readIsolationConfig())) {
		return null;
	}
	const client = input.createClient();
	const summary = [input.commandPath, ...input.args].join(" ").slice(0, 400);
	const requested = await Promise.resolve()
		.then(() =>
			client.isolation.requestApproval.mutate({ kind: PROJECT_CHANGE_COMMANDS[input.commandPath], summary }),
		)
		.catch(() => null);
	if (!requested) {
		return `Project isolation is in enforce: \`kanban ${input.commandPath}\` needs the user's approval through the running Kanban server, which could not be reached.`;
	}
	if (!requested.ok) {
		return requested.error ?? `\`kanban ${input.commandPath}\` was refused.`;
	}
	if (!requested.required || !requested.approvalId) {
		return null;
	}
	const outcome = await completeIsolationApproval({
		...input.approval,
		client,
		approvalId: requested.approvalId,
		what: `\`kanban ${summary}\``,
	});
	return outcome.ok ? null : `\`kanban ${input.commandPath}\` was not approved: ${outcome.error}`;
}

/**
 * Runs before every CLI command (cli.ts preAction). Without a session credential it does nothing except hold a
 * project add/create for approval under `enforce`. With one: user-only commands are refused, and while some isolation
 * is on, machine-wide ones too under `enforce` and the board-file layer is scoped. Returns the refusal message, or
 * null to go ahead.
 */
export async function applyCliSessionScope(input: {
	commandPath: string;
	options: Record<string, unknown>;
	createClient: () => Pick<RuntimeTrpcClient, "isolation" | "providers">;
	env?: NodeJS.ProcessEnv;
	/** The command's arguments, for the approval's summary. */
	args?: readonly string[];
	approval?: Partial<CompleteApprovalInput>;
	/** Whether a Kanban server is live on the home (its lock); tests inject it. */
	isServerRunning?: () => boolean;
}): Promise<string | null> {
	const env = input.env ?? process.env;
	// The hook commands run on every tool call (and in Cline's shared daemon with another card's env): never scoped.
	if (input.commandPath === "hooks" || input.commandPath.startsWith("hooks ")) {
		return null;
	}
	if (matchesCommandPath(input.commandPath, KANBAN_ORCHESTRATOR_OR_USER_COMMANDS)) {
		const refusal = await requireKanbanOrchestratorOrUser({
			commandPath: input.commandPath,
			env,
			createClient: input.createClient,
			isServerRunning: input.isServerRunning ?? isLiveServerOnHome,
		});
		if (refusal) {
			return refusal;
		}
	}
	if (!readSessionCredential(env)) {
		return input.commandPath in PROJECT_CHANGE_COMMANDS
			? await requireProjectChangeApproval({
					commandPath: input.commandPath as keyof typeof PROJECT_CHANGE_COMMANDS,
					args: input.args ?? [],
					createClient: input.createClient,
					approval: input.approval,
				})
			: null;
	}
	if (input.commandPath === "plan approve" || (input.commandPath === "plan expand" && input.options.approvedByUser)) {
		return planApprovalRefusal(input.args?.[0]);
	}
	if (matchesCommandPath(input.commandPath, USER_ONLY_COMMANDS)) {
		return `\`kanban ${input.commandPath}\` is the user's: an agent session can't run it. Tell the user what you need.`;
	}
	const config = await readIsolationConfig();
	if (matchesCommandPath(input.commandPath, ORCHESTRATOR_OR_USER_COMMANDS)) {
		// The server says which session this is; a card, or a session it can't confirm as the orchestrator, is refused.
		const caller = await resolveCliSessionScope({ env, config, client: input.createClient() });
		if (caller?.role !== "orchestrator") {
			return orchestratorOrUserRefusal(input.commandPath);
		}
	}
	// With isolation off everywhere only the user-only rules apply: nothing is scoped, the server isn't asked.
	if (!isAnyIsolationOn(config)) {
		return null;
	}
	const scope = await resolveCliSessionScope({ env, config, client: input.createClient() });
	if (!scope) {
		return null;
	}
	const machineWide =
		matchesCommandPath(input.commandPath, MACHINE_WIDE_COMMANDS) ||
		(input.commandPath === "doctor" && input.options.fix === true);
	if (machineWide && scope.mode === "enforce") {
		return `Project isolation: \`kanban ${input.commandPath}${input.commandPath === "doctor" ? " --fix" : ""}\` changes machine-wide state, which only the user changes. Ask the user to run it.`;
	}
	await installCliWorkspaceGuard(scope, config, input.commandPath);
	return null;
}
