// Safe executable setup guidance supplements the unchanged legacy QA skeleton, just like browser/checks guidance.
import { quoteShellArg } from "../core/shell";

export function buildQaSetupGuidance(input: {
	repoPath: string;
	snapshot: string;
	baseRef: string;
	scratchDir: string;
	outboxDir: string;
	qaTaskId: string;
	dbSetupNotes: string;
}): string {
	const repo = quoteShellArg(input.repoPath);
	const scratch = quoteShellArg(input.scratchDir);
	const baseline = quoteShellArg(`${input.scratchDir}-${input.baseRef}`);
	const snapshot = quoteShellArg(input.snapshot);
	return [
		"EXECUTABLE QA SETUP (authoritative commands for steps 1/2):",
		"Use the explicit commands below instead of the legacy illustrative shorthand '(--stat first)' or 'archive ... into ...'. Never execute those annotations as arguments. The snapshot below is the immutable commit assigned to this review, not a moving snapshot ref.",
		"Run dependent setup commands sequentially: finish extraction, then install, then local generation, then verified isolated database setup, then tests/build, then browser journeys. Do NOT put these dependent commands in a parallel run_commands array. Stop on the first setup failure; do not continue with npx downloads, tests, or inferred setup success.",
		"In one Bash command/session, initialize and extract (pipefail matters). These directories belong only to this QA card; if either is non-empty or used by any running tool/server, do not delete or overwrite it. Record the setup problem as STALLED and retain evidence:",
		"```bash",
		"set -euo pipefail",
		`BASE_SHA=$(git -C ${repo} rev-parse --verify --end-of-options ${quoteShellArg(`${input.baseRef}^{commit}`)})`,
		`git -C ${repo} rev-parse --verify --end-of-options ${quoteShellArg(`${input.snapshot}^{commit}`)}`,
		`git -C ${repo} diff --stat "$BASE_SHA"...${snapshot} --`,
		`git -C ${repo} diff "$BASE_SHA"...${snapshot} --`,
		`mkdir -p ${scratch} ${baseline}`,
		`test -z "$(ls -A ${scratch})"`,
		`test -z "$(ls -A ${baseline})"`,
		`git -C ${repo} archive ${snapshot} | tar -x -C ${scratch}`,
		`git -C ${repo} archive "$BASE_SHA" | tar -x -C ${baseline}`,
		"```",
		"Only after extraction succeeds, install each copy separately; these subshells run npm in the intended scratch directory:",
		"```bash",
		"set -euo pipefail",
		`(cd ${scratch} && unset NODE_ENV && npm ci --include=dev)`,
		`(cd ${baseline} && unset NODE_ENV && npm ci --include=dev)`,
		"```",
		"Run generation through the installed project script/binary only, after successful installation; never let npx fetch an incompatible generator. Read package.json/AGENTS.md for the actual setup and test scripts. Never append --prefix outside a closed subshell. Never clean a scratch directory while commands or servers still use it.",
		`DATABASE SAFETY: use separate, QA-card-specific disposable databases for reviewer ${input.qaTaskId} and its baseline. Keep ambient credentials private; do not invent credentials, use the main/shared app database, or reuse the scripted-checks database. Before any schema/seed mutation, verify the configured name and connection URL agree and ask the installed database client for its actual current database; it must match the intended isolated name. For PostgreSQL, current_database() must match; an admin connection (PGDATABASE) is separate from the app database. If the project has no verifiable isolated setup path, stop database actions, keep the setup error as STALLED (tooling), and save sanitized evidence under ${input.outboxDir}. Missing psql/jq alone is not proof that installed project database clients are unavailable. Do not log URLs/passwords/credentials.`,
		...(input.dbSetupNotes.trim()
			? [
					"PROJECT DATABASE SETUP NOTES (prose reference, NOT a shell command; do not splice into 'cd ... && ...'):",
					input.dbSetupNotes.trim(),
				]
			: []),
		"This guidance does not authorize another QA attempt, handback, fallback, model switch, benchmark reopening, or landing. Unresolved reviewer/tooling failures are STALLED, not a developer FAIL or a PASS. Preserve reports and existing evidence; a corrected script pasted in chat is not executed setup proof.",
	].join("\n");
}
