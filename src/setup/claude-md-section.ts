// The `kanban` managed section of Claude Code's user memory (~/.claude/CLAUDE.md, or $CLAUDE_CONFIG_DIR/CLAUDE.md):
// what a Claude orchestrator or card agent on this machine should run. `kanban setup` writes it; the user's own text
// stays outside the markers. Replaces the legacy kit's hand-written "Kanban team kit" text (plan §2.5), so while the
// legacy kit is installed `kanban setup` leaves this file alone unless asked (`--claude-md`): two sets of
// instructions for the same orchestrator would disagree until cutover (P5-3).
import { homedir } from "node:os";
import { join } from "node:path";

import type { ManagedSectionSpec } from "./managed-section";

export const CLAUDE_MD_SECTION: ManagedSectionSpec = { id: "kanban", updateHint: "kanban setup" };

export function getClaudeConfigDirPath(env: NodeJS.ProcessEnv = process.env): string {
	const configDir = env.CLAUDE_CONFIG_DIR?.trim();
	return configDir ? configDir : join(homedir(), ".claude");
}

export function getClaudeUserMemoryPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(getClaudeConfigDirPath(env), "CLAUDE.md");
}

export function renderClaudeMdSection(): string {
	return `# Kanban on this machine

**If you are the Kanban orchestrator (the sidebar agent of a workspace):**
- At the start of a session, run \`kanban doctor <workspace path>\` (the main checkout, never a task worktree). It
  prints each project's routing kit and landing mode, and every problem with the command that fixes it.
  \`kanban doctor --fix <workspace path>\` applies the safe fixes (registering the project, agent folder trust,
  managed sections). Tell the user what it changed.
- A project's routing is its kit, the team definition: its roles (dev, QA, plan, fallback) with a default model each,
  and the flow (QA, rework rounds, which triggers hand a card to the fallback, approval):
  \`kanban kit show --project <path>\`. Change the kit only with \`kanban kit apply\`, and only when the user asks. A
  project without a kit uses \`default\`: every card runs on the agent selected in Kanban settings, and nothing is
  QA'd, reworked or landed automatically.
- The project's settings on its kit are yours to change, at once and without a card: a role's model
  (\`kanban kit set roles.<role>.agent|provider|model|tier <value> --project <path>\`) and project facts (\`qa.blurb\`,
  \`qa.promptNotes.*\`, \`qa.serversScript\`, \`qa.preview\`, \`land.postLand\`, \`plan.rules\`, \`checks.*\`);
  \`kanban kit unset <key>\` removes one. Flow keys are refused: another team is another kit, the user's \`kanban kit apply\`.
- You may add, change and remove the project's top-bar shortcuts (any label, command, icon) for the user:
  \`kanban shortcut add --label <label> --command "<command>" [--icon <icon>] --project <path>\` (\`list\`, \`remove\`);
  \`{port}\` in a command is a free port per run, \`{url}\` the browser's way to it (docs/fork/shortcuts.md).
- Agents never approve a plan; the user approves it on the board (Approve plan). Don't run \`kanban plan approve\`
  or \`kanban plan expand --approved-by-user\`: tell the user the plan is ready, and expand it once they approved it.
- Models come from Kanban's vetted model registry: a role, and a card's own \`--agent-id\`/\`--model\`, can only use
  a combination vetted for that role (\`kanban models list --project <path>\`). For another one, run
  \`kanban models vet --agent <a> [--provider <p>] [--model <m>] --role dev|qa|plan\` and give the Kanban project its
  proposal; provisional combinations are the user's to allow.

**If you are a task agent on a Kanban card:** follow your card prompt. Don't run \`kanban doctor --fix\`,
\`kanban setup\`, \`kanban kit apply\` or \`kanban config import-kit\` unless the prompt says so; \`kanban kit set\` is
the orchestrator's (Kanban refuses it from a card).
`;
}
