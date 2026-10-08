// `kanban doctor`'s GitHub auth rows (docs/fork/github-auth.md): whether the container's PAT (GH_TOKEN) is there for
// gh, git and npm, and which credential Copilot runs on. Copilot launches keep Kanban's env, and Copilot takes
// COPILOT_GITHUB_TOKEN, else GH_TOKEN/GITHUB_TOKEN, else its own login. Never prints a token.
import { isCopilotSignedIn } from "../terminal/agent-run-signals";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";
import type { DoctorFinding } from "./doctor-report";

export interface GitHubAuthCheckDeps {
	env: NodeJS.ProcessEnv;
	isOnPath: (binary: string) => boolean;
	isCopilotSignedIn: () => Promise<boolean>;
}

const AREA = "setup";
const COPILOT_PRECEDENCE = "Copilot uses COPILOT_GITHUB_TOKEN when set, else GH_TOKEN/GITHUB_TOKEN, else its own login";

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
	const hasCopilotToken = Boolean(deps.env.COPILOT_GITHUB_TOKEN?.trim());
	const signedIn = await deps.isCopilotSignedIn();
	const current = hasCopilotToken
		? "COPILOT_GITHUB_TOKEN"
		: tokenVar
			? `the PAT in ${tokenVar}`
			: signedIn
				? "its own login"
				: "nothing";
	findings.push({ level: "info", area: AREA, message: `${COPILOT_PRECEDENCE}: Copilot cards run on ${current}` });
	if (!hasCopilotToken && !signedIn) {
		findings.push({
			level: "warn",
			area: AREA,
			message: "no COPILOT_GITHUB_TOKEN and Copilot is not logged in: Copilot cards can't start a run",
			hint: "set COPILOT_GITHUB_TOKEN in the container (docs/fork/github-auth.md), or copilot login",
		});
	} else if (!hasCopilotToken && tokenVar) {
		// The PAT wins over the login, and it is the user's gh/git/npm token, not one made for Copilot.
		findings.push({
			level: "warn",
			area: AREA,
			message: `no COPILOT_GITHUB_TOKEN: Copilot takes the PAT in ${tokenVar} over its own login`,
			hint: "set COPILOT_GITHUB_TOKEN in the container (docs/fork/github-auth.md)",
		});
	}
	return findings;
}
