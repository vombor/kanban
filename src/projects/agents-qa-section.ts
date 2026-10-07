// The `agents-qa` managed section of a project's AGENTS.md: how cards on a QA-landed board are reviewed and landed.
// `kanban project add --agents-md` adds it; `kanban project sync` keeps it current. It describes landing mode `qa`,
// so it is never added on its own. Rewritten from archive/devteam-kit:templates/AGENTS.qa-section.md@d2fb30f with
// Kanban's names (no kit paths: card agents never need the Kanban home).
import type { ManagedSectionSpec } from "../setup/managed-section";

export const AGENTS_QA_SECTION: ManagedSectionSpec = { id: "agents-qa", updateHint: "kanban project sync" };
export const AGENTS_FILE_NAME = "AGENTS.md";

export interface AgentsQaSectionVars {
	/** The project's display name. */
	name: string;
	/** The branch QA PASSes land on. */
	baseBranch: string;
}

export function renderAgentsQaSection(vars: AgentsQaSectionVars): string {
	return `## How cards are reviewed and landed (${vars.name})

This project runs on an agentic Kanban board: QA gates landing. You are probably one of its card agents, so:

- **Leave your work in your task worktree.** Do not commit, push, merge or cherry-pick into \`${vars.baseBranch}\`
  or the main checkout, and do not touch other cards. When you stop, the card moves to Review and the
  worktree is snapshotted; a QA card reviews that snapshot, and only a QA PASS (or a human's Approve & land)
  lands it (squash onto \`${vars.baseBranch}\`). Cards that depend on yours start after that.
- **Review means "the agent stopped", not "done".** If QA fails your card, it may come back to you (same card,
  same model) with a REWORK section in its prompt: fix the blocking issues it lists, keep what works, re-run
  the tests, and finish the same way. After the last allowed round a human decides.
- **Finish with the card's FINAL STEP** if it has one, exactly as written.
- **Run the tests you touch** (typecheck, unit tests, build). QA compares failures with \`${vars.baseBranch}\`, so
  pre-existing failures are not blamed on you, but new ones are blocking.
- **UI changes need visual proof.** Use the project's screenshot/browse tooling described in this file
  (mobile and desktop), read its text report (HTTP status, console errors, failed requests), and fix
  console errors your change causes. Don't stop a shared preview/dev server other cards use; start your own
  on a free port if the project's tooling supports it.
- **Keep tool output small**: redirect long output to a file, then \`tail\`/\`grep\` it.
`;
}
