import { scrubGitEnvironment } from "./git-env";

// Runs once in the main vitest process, before any worker starts, so workers inherit an environment without the
// git variables a hook exported (a commit's pre-commit hook runs the tests with GIT_DIR / GIT_INDEX_FILE set, and
// on 2026-10-07 every temp-repo git command went to the real repo). vitest-setup.ts scrubs each worker again.
export default function setup(): void {
	const removed = scrubGitEnvironment(process.env);
	if (removed.length > 0) {
		console.warn(`[kanban tests] removed inherited git environment variables: ${removed.join(", ")}`);
	}
}
