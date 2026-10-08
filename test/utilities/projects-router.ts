// The runtime's real `projects.*` router (projects API + isolation service) as a CLI reaches it, with `caller` as
// whoever runs the CLI and `root` as the only projects root. For tests of the CLI paths that register a project
// through the server instead of in-process.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parsePipelineConfig } from "../../src/config/pipeline-config";
import { createIsolationService } from "../../src/isolation/isolation-service";
import type { RuntimeCaller } from "../../src/isolation/session-identity";
import { resolveProjectRoots } from "../../src/projects/project-roots";
import { listWorkspaceIndexEntries } from "../../src/state/workspace-state";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createIsolationApi } from "../../src/trpc/isolation-api";
import { createProjectsApi } from "../../src/trpc/projects-api";
import { createGitTestEnv } from "./git-env";

export async function createProjectsRouter(input: {
	caller: RuntimeCaller;
	raw: Record<string, unknown>;
	root: string;
}) {
	const service = createIsolationService({
		readConfig: async () => parsePipelineConfig(input.raw).config,
		processReader: null,
		listLiveSessions: () => [],
		log: async () => {},
		announceApproval: () => {},
	});
	const projectRoots = await resolveProjectRoots([input.root]);
	const projectsApi = createProjectsApi({
		getActiveWorkspacePath: () => null,
		getActiveWorkspaceId: () => null,
		rememberWorkspace: () => {},
		setActiveWorkspace: async () => {},
		clearActiveWorkspace: () => {},
		resolveProjectInputPath: (inputPath: string, cwd: string) => resolve(cwd, inputPath),
		assertPathIsDirectory: async () => {},
		hasGitRepository: (path: string) => existsSync(join(path, ".git")),
		summarizeProjectTaskCounts: async () => ({ backlog: 0, in_progress: 0, review: 0, trash: 0 }),
		createProjectSummary: ({ workspaceId, repoPath }) => ({
			id: workspaceId,
			path: repoPath,
			name: workspaceId,
			taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
		}),
		broadcastRuntimeProjectsUpdated: async () => {},
		getTerminalManagerForWorkspace: () => null,
		disposeWorkspace: () => ({ terminalManager: null, workspacePath: null }),
		collectProjectWorktreeTaskIdsForRemoval: () => new Set<string>(),
		warn: () => {},
		buildProjectsPayload: async () => ({ currentProjectId: null, projects: [] }),
		pickDirectoryPathFromSystemDialog: () => null,
		serverCwd: input.root,
		readProjectRoots: async () => projectRoots,
	} as Parameters<typeof createProjectsApi>[0]);
	const router = runtimeAppRouter.createCaller({
		requestedWorkspaceId: null,
		workspaceScope: null,
		getCaller: async () => input.caller,
		resolveStrictCaller: async () => input.caller,
		trustedBrowser: false,
		isolationApi: createIsolationApi({
			service,
			listEntries: listWorkspaceIndexEntries,
			notices: { allowSend: () => true, enqueue: () => {} },
		}),
		projectsApi,
	} as unknown as RuntimeTrpcContext);
	return router;
}

/** A git repo with one commit at `<parent>/<name>`. */
export function createCommittedRepo(parent: string, name: string): string {
	const repoPath = join(parent, name);
	mkdirSync(repoPath, { recursive: true });
	const env = createGitTestEnv();
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoPath, env });
	writeFileSync(join(repoPath, "a.txt"), "a\n");
	execFileSync("git", ["add", "."], { cwd: repoPath, env });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a"], { cwd: repoPath, env });
	return repoPath;
}
