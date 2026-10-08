// `kanban doctor`'s GitHub auth rows (docs/fork/github-auth.md): whether the container's PAT (GH_TOKEN) is there for
// gh, git and npm, and that Copilot doesn't use it: Kanban drops Copilot's token variables from every Copilot launch
// (COPILOT_TOKEN_ENV_NAMES), so Copilot cards need Copilot's own login. Never prints a token.
import { isCopilotSignedIn } from "../terminal/agent-run-signals";
import { COPILOT_TOKEN_ENV_NAMES } from "../terminal/agent-session-adapters";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";
import type { DoctorFinding } from "./doctor-report";

export interface GitHubAuthCheckDeps {
	env: NodeJS.ProcessEnv;
	isOnPath: (binary: string) => boolean;
	isCopilotSignedIn: () => Promise<boolean>;
}

const AREA = "setup";

export async function checkGitHubAuth(
	deps: GitHubAuthCheckDeps = { env: process.env, isOnPath: isBinaryAvailableOnPath, isCopilotSignedIn },
): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	const tokenVar = deps.env.GH_TOKEN ? "GH_TOKEN" : deps.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : null;
	findings.push(
		tokenVar
			? {
					level: "info",
					area: AREA,
					message: `${tokenVar} is set: gh, git over https (gh's credential helper) and npm for @vombor use the PAT`,
				}
			: {
					level: "info",
					area: AREA,
					message: "no GH_TOKEN: gh uses its own login (/root/.config/gh), npm can't install @vombor packages",
					hint: "docs/fork/github-auth.md",
				},
	);
	if (!deps.isOnPath("copilot")) {
		return findings;
	}
	findings.push({
		level: "info",
		area: AREA,
		message: `Copilot ignores the container PAT (Kanban drops ${COPILOT_TOKEN_ENV_NAMES.join(", ")} from its launches) and uses its own login`,
	});
	if (!(await deps.isCopilotSignedIn())) {
		findings.push({
			level: "warn",
			area: AREA,
			message: "Copilot is not logged in: Copilot cards can't start a run",
			hint: "copilot login",
		});
	}
	return findings;
}
