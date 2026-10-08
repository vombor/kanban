// The project a bare `kanban` (and the server it starts) opens in its cwd (docs/fork/project-isolation.md). A
// registered project just opens. An unregistered git repo is registered only through the same rules as
// `projects.add`: never a Kanban task worktree, never for an agent session (a session credential in the env), and
// only strictly inside a projects root (`resolvePathInsideProjectRoots`). The decision itself writes nothing: a
// starting server registers a "register" answer once it has bound the port (cli.ts), and a bare `kanban` that finds a
// server running sends it to that server's `projects.add`, whose isolation rule also refuses a session without the
// env credential. Already registered projects outside a root are left alone (doctor warns).
import type { RuntimeTrpcClient } from "../commands/runtime-trpc-client";
import { readSessionCredential } from "../isolation/cli-scope";
import { loadWorkspaceContext, WorkspaceNotRegisteredError } from "../state/workspace-state";
import { type ProjectRoots, readProjectRoots, resolvePathInsideProjectRoots } from "./project-roots";

export type LaunchProjectDecision =
	| { kind: "none" }
	| { kind: "registered"; workspaceId: string; repoPath: string }
	| { kind: "register"; repoPath: string }
	| { kind: "refused"; repoPath: string; message: string };

export interface ResolveLaunchProjectInput {
	cwd: string;
	hasGitRepository: (path: string) => boolean;
	env?: NodeJS.ProcessEnv;
	/** Default: config.json's `projects.roots`. */
	readProjectRoots?: () => Promise<ProjectRoots>;
}

export async function resolveLaunchProject(input: ResolveLaunchProjectInput): Promise<LaunchProjectDecision> {
	if (!input.hasGitRepository(input.cwd)) {
		return { kind: "none" };
	}
	let repoPath: string;
	try {
		const context = await loadWorkspaceContext(input.cwd, { autoCreateIfMissing: false });
		return { kind: "registered", workspaceId: context.workspaceId, repoPath: context.repoPath };
	} catch (error) {
		if (!(error instanceof WorkspaceNotRegisteredError)) {
			// A CLI scope refusal (cli-scope.ts): the session may not open this directory.
			return {
				kind: "refused",
				repoPath: input.cwd,
				message: error instanceof Error ? error.message : String(error),
			};
		}
		repoPath = error.repoPath;
	}
	const refused = (reason: string): LaunchProjectDecision => ({
		kind: "refused",
		repoPath,
		message: `Not adding ${repoPath} as a Kanban project: ${reason}`,
	});
	const check = await resolvePathInsideProjectRoots(repoPath, await (input.readProjectRoots ?? readProjectRoots)());
	if (!check.ok) {
		return refused(check.error);
	}
	if (readSessionCredential(input.env ?? process.env)) {
		return refused(
			"this runs in an agent session, and only the user adds projects (Open folder, or `kanban project add` in their own terminal).",
		);
	}
	return { kind: "register", repoPath: check.path };
}

export interface LaunchProjectReporter {
	log: (message: string) => void;
	warn: (message: string) => void;
}

/**
 * A starting server, once it has bound the port (no other server owns it): registers a "register" answer and makes it
 * the active project. Returns the project it opens, or null when the cwd isn't one.
 */
export async function registerLaunchProjectInProcess(
	input: ResolveLaunchProjectInput &
		LaunchProjectReporter & { setActiveWorkspace: (workspaceId: string, repoPath: string) => Promise<void> },
): Promise<{ workspaceId: string; repoPath: string } | null> {
	const decision = await resolveLaunchProject(input);
	if (decision.kind === "refused") {
		input.warn(decision.message);
		return null;
	}
	if (decision.kind !== "register") {
		return decision.kind === "registered" ? { workspaceId: decision.workspaceId, repoPath: decision.repoPath } : null;
	}
	try {
		const context = await loadWorkspaceContext(decision.repoPath);
		await input.setActiveWorkspace(context.workspaceId, context.repoPath);
		input.log(`Added project ${context.repoPath}.`);
		return { workspaceId: context.workspaceId, repoPath: context.repoPath };
	} catch (error) {
		input.warn(
			`Could not add ${decision.repoPath} as a Kanban project: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

/**
 * A bare `kanban` that found a server running: a "register" answer goes to that server's `projects.add` (its
 * isolation rule and projects-root check), never into the index from here. Returns the project's workspace id.
 */
export async function registerLaunchProjectThroughServer(
	input: ResolveLaunchProjectInput & LaunchProjectReporter & { client: Pick<RuntimeTrpcClient, "projects"> },
): Promise<string | null> {
	const decision = await resolveLaunchProject(input);
	if (decision.kind === "registered") {
		return decision.workspaceId;
	}
	if (decision.kind === "refused") {
		input.warn(decision.message);
		return null;
	}
	if (decision.kind === "none") {
		return null;
	}
	try {
		const added = await input.client.projects.add.mutate({ path: decision.repoPath });
		if (added.ok && added.project) {
			input.log(`Added project ${added.project.path}.`);
			return added.project.id;
		}
		input.warn(`Not adding ${decision.repoPath} as a Kanban project: ${added.error ?? "the server refused it."}`);
	} catch (error) {
		input.warn(
			`Not adding ${decision.repoPath} as a Kanban project: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return null;
}
