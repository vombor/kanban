import { type CardRoleInput, resolveCardRole } from "../core/card-role";
import type { KitDocument } from "./kit-schema";

export const DEV_COMPLETION_MARKER = "TEAM DEVELOPER COMPLETION CONTRACT (Review handoff)";
const CONTRACT = [
	DEV_COMPLETION_MARKER,
	"Own implementation, requested documentation, cleanup and focused unit tests/build checks appropriate to this project. Fix relevant failures independently using concrete error evidence. Reuse passing verification; repeat a passing check only after a relevant change or a new failure.",
	"Live browser walkthroughs, acceptance testing, screenshot capture/assessment and browser-QA tooling investigations belong to the independent QA role. Do browser work only for explicitly requested browser/tooling implementation or when a specific QA rework finding requires it; keep that work targeted, then hand back for independent QA. Do not add a separate self-QA pass to routine development.",
	"Maintain a concise record of requirements completed, remaining work and verification results. After context compaction, re-anchor to the original task, exact retained references and current rework findings rather than expanding scope.",
	"STOP once the dev requirements and focused checks are complete: use your CLI's native completion/end-of-turn mechanism immediately, with a concise change summary, unit-test/build results, startup instructions and known limitations. Kanban owns the move to Review and the existing workflow picks up QA from there.",
	"Do not launch QA, invoke QA workflow commands, mark the card Done, bypass review, wait for routine orchestrator approval or continue tools after completion merely to perform self-QA. Keep existing git/landing guardrails and explicit task requirements. Escalate only genuine external blockers or unresolved product decisions after reasonable self-recovery.",
].join("\n");
export function withDevCompletionContract(prompt: string, kit: KitDocument, card: CardRoleInput | null): string {
	if (
		!prompt.trim() ||
		!card ||
		resolveCardRole(card) !== "dev" ||
		kit.dispatch?.devCompletion !== "review" ||
		prompt.includes(CONTRACT)
	)
		return prompt;
	return `${prompt}\n\n${CONTRACT}`;
}
