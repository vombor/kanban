// Explicit per-instance bootstrap. Startup never rewrites npm or git configuration.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createGitProcessEnv } from "../core/git-process-env";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";
import type { SetupStepPlan } from "./machine-setup";

const execute = promisify(execFile);

export function githubTokenVariable(env: NodeJS.ProcessEnv): "GH_TOKEN" | "GITHUB_TOKEN" | null {
	return env.GH_TOKEN?.trim() ? "GH_TOKEN" : env.GITHUB_TOKEN?.trim() ? "GITHUB_TOKEN" : null;
}

/** GitHub CLI's documented override order; this is agent/user state, not Kanban-owned state. */
export function getGitHubConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	if (env.GH_CONFIG_DIR?.trim()) return env.GH_CONFIG_DIR.trim();
	if (env.XDG_CONFIG_HOME?.trim()) return join(env.XDG_CONFIG_HOME.trim(), "gh");
	if (env.APPDATA?.trim()) return join(env.APPDATA.trim(), "GitHub CLI");
	return join(env.HOME?.trim() || homedir(), ".config", "gh");
}

export interface GitHubGitSetupDeps {
	isOnPath: (binary: string) => boolean;
	readHelpers: () => Promise<string[]>;
	setup: () => Promise<void>;
}

function createGitHubGitSetupDeps(env: NodeJS.ProcessEnv): GitHubGitSetupDeps {
	const gitEnv = createGitProcessEnv(env);
	return {
		isOnPath: isBinaryAvailableOnPath,
		readHelpers: async () => {
			const helpers: string[] = [];
			for (const key of ["credential.https://github.com.helper", "credential.helper"]) {
				try {
					const { stdout } = await execute("git", ["config", "--global", "--get-all", key], {
						env: gitEnv,
						timeout: 5000,
					});
					helpers.push(
						...stdout
							.split("\n")
							.map((value) => value.trim())
							.filter(Boolean),
					);
				} catch (error) {
					if (!(error && typeof error === "object" && "code" in error && error.code === 1))
						throw new Error("Could not read the user's git credential helpers");
				}
			}
			return helpers;
		},
		setup: async () => {
			try {
				await execute("gh", ["auth", "setup-git", "--hostname", "github.com"], { env: gitEnv, timeout: 10_000 });
			} catch {
				throw new Error("Could not configure GitHub's git credential helper; check gh authentication");
			}
		},
	};
}

export async function planGitHubGitAuth(
	env: NodeJS.ProcessEnv,
	deps = createGitHubGitSetupDeps(env),
): Promise<SetupStepPlan> {
	const base = { id: "github-git" as const, target: "user git credential configuration" };
	if (!githubTokenVariable(env))
		return { ...base, status: "skipped", details: ["no GitHub token in the environment"] };
	if (!deps.isOnPath("git") || !deps.isOnPath("gh"))
		return { ...base, status: "manual", details: ["install git and gh, then run kanban setup again"] };
	if ((await deps.readHelpers()).length > 0)
		return { ...base, status: "ok", details: ["existing git credential helpers kept"] };
	return {
		...base,
		status: "change",
		details: ["set gh as git's credential helper for github.com (no token stored)"],
		apply: async () => {
			if ((await deps.readHelpers()).length > 0) return ["existing git credential helpers kept"];
			await deps.setup();
			return ["configured gh's git credential helper"];
		},
	};
}
