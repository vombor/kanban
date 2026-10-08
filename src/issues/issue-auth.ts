// Where the GitHub token for issue import comes from, in this order: the `gh` CLI's login (`gh auth token`, so the
// user's own `gh auth login` is reused without Kanban storing anything), else `GITHUB_TOKEN` / `GH_TOKEN` from
// Kanban's env, else anonymous (public repositories only, 60 requests/h; the provider's conditional requests keep
// polling within that). The token is returned to the caller and kept in memory only: Kanban never writes it to a
// file or a log, and `source` is what doctor and the logs show.
import { execFile } from "node:child_process";

export type IssueAuthSource = "gh" | "GITHUB_TOKEN" | "GH_TOKEN" | "anonymous";

export interface IssueAuth {
	source: IssueAuthSource;
	token: string | null;
}

/** The token `gh` holds for the host, or null (not installed, not logged in, timed out). */
export type ReadGhToken = (host: string) => Promise<string | null>;

const GH_TIMEOUT_MS = 5_000;

export const readGhCliToken: ReadGhToken = async (host) =>
	await new Promise((resolve) => {
		execFile(
			"gh",
			["auth", "token", "--hostname", host],
			{ timeout: GH_TIMEOUT_MS, encoding: "utf8", env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
			(error, stdout) => {
				const token = String(stdout ?? "").trim();
				resolve(error || !token ? null : token);
			},
		);
	});

export async function resolveGitHubAuth(
	options: { env?: NodeJS.ProcessEnv; readGhToken?: ReadGhToken; host?: string } = {},
): Promise<IssueAuth> {
	const env = options.env ?? process.env;
	const ghToken = await (options.readGhToken ?? readGhCliToken)(options.host ?? "github.com");
	if (ghToken) {
		return { source: "gh", token: ghToken };
	}
	for (const name of ["GITHUB_TOKEN", "GH_TOKEN"] as const) {
		const token = env[name]?.trim();
		if (token) {
			return { source: name, token };
		}
	}
	return { source: "anonymous", token: null };
}
