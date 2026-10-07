import type { RuntimeTaskAutoReviewMode, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";

export type TaskGitAction = Extract<RuntimeTaskAutoReviewMode, "commit" | "pr">;

interface TaskGitPromptVariable {
	key: string;
	token: string;
	description: string;
}

export const TASK_GIT_BASE_REF_PROMPT_VARIABLE: TaskGitPromptVariable = {
	key: "base_ref",
	token: "{{base_ref}}",
	description: "the branch this task worktree was created from",
};

export interface TaskGitPromptTemplates {
	commitPromptTemplate?: string | null;
	openPrPromptTemplate?: string | null;
	commitPromptTemplateDefault?: string | null;
	openPrPromptTemplateDefault?: string | null;
}

/**
 * Appended to the Make PR click's prompt (auto-review builds its own, in src/server/auto-review-reconciler.ts, for a
 * card launched with the PR action). Kanban's guardrails decide a card's push permission once, at launch, from the
 * card's git action (`guardrails.prCardPush`, src/guardrails/task-guardrails.ts): a card started with the Commit
 * action, or a Codex/Copilot card, can't push, and a Make PR click doesn't change a running session. So the agent is
 * told what to do instead of looking for a way around the block.
 */
export function buildTaskGitPrPushGuardrailNote(taskId: string): string {
	return [
		"Kanban's task-card guardrails may block `git push` in this session: only a card started with the PR git action may push, and only its own branch.",
		"If a push is blocked, do not try to work around it. Leave the work committed on your branch and tell the user it is not pushed,",
		`and that to let this card push its own branch they set the card's git action to PR (\`kanban task update --task-id ${taskId} --auto-review-mode pr\`) and restart its session, or push the branch themselves.`,
	].join(" ");
}

interface BuildTaskGitActionPromptInput {
	action: TaskGitAction;
	workspaceInfo: RuntimeTaskWorkspaceInfoResponse;
	templates?: TaskGitPromptTemplates | null;
}

function resolveTemplate(action: TaskGitAction, templates?: TaskGitPromptTemplates | null): string {
	if (action === "commit") {
		const template = templates?.commitPromptTemplate?.trim();
		if (template) {
			return template;
		}
		const defaultTemplate = templates?.commitPromptTemplateDefault?.trim();
		if (defaultTemplate) {
			return defaultTemplate;
		}
		return "Handle this commit action using the provided git context.";
	}
	const template = templates?.openPrPromptTemplate?.trim();
	if (template) {
		return template;
	}
	const defaultTemplate = templates?.openPrPromptTemplateDefault?.trim();
	if (defaultTemplate) {
		return defaultTemplate;
	}
	return "Handle this pull request action using the provided git context.";
}

function interpolateTemplate(template: string, variables: Record<string, string>): string {
	let result = template;
	for (const [key, value] of Object.entries(variables)) {
		result = result.replaceAll(`{{${key}}}`, value);
	}
	return result;
}

export function buildTaskGitActionPrompt(input: BuildTaskGitActionPromptInput): string {
	const variables: Record<string, string> = {
		[TASK_GIT_BASE_REF_PROMPT_VARIABLE.key]: input.workspaceInfo.baseRef,
	};
	const template = resolveTemplate(input.action, input.templates);
	const prompt = interpolateTemplate(template, variables);
	return input.action === "pr"
		? `${prompt}\n\n${buildTaskGitPrPushGuardrailNote(input.workspaceInfo.taskId)}`
		: prompt;
}
