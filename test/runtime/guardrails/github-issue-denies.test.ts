// The built-in rail that steers agents off `gh issue ...` writes onto `kanban github issue ...` (the Kanban GitHub
// App, docs/fork/github-bots.md): Kanban's matcher (Claude's and Cline's hooks), and what the CLI-native deny lists
// of Codex and Copilot do with it.
import { describe, expect, it } from "vitest";

import {
	BUILT_IN_DENY_COMMANDS,
	describeDeniedCommand,
	findDeniedCommand,
	GITHUB_ISSUE_DENY_COMMANDS,
	isGhApiIssueWrite,
	parseDeniedCommandPatterns,
} from "../../../src/guardrails/command-patterns";
import { buildGuardrailPromptNote, type TaskGuardrails } from "../../../src/guardrails/task-guardrails";
import {
	buildClaudeBashDeny,
	buildCodexRulesFile,
	buildCopilotDenyTools,
} from "../../../src/terminal/agent-guardrails";
import { evaluateClaudeGuard } from "../../../src/terminal/claude-guard";

const rules = parseDeniedCommandPatterns(BUILT_IN_DENY_COMMANDS, ["main"]);
const githubRules = parseDeniedCommandPatterns(GITHUB_ISSUE_DENY_COMMANDS, []);

describe("GitHub issue write denies", () => {
	it("blocks gh issue writes and gh api issue writes, in any command form", () => {
		for (const command of [
			"gh issue create --title x --body-file b.md",
			"gh issue comment 12 --body hi",
			"cd /x && gh issue close 3",
			"sh -c 'gh issue edit 4 --title y'",
			"gh api repos/vombor/kanban/issues -f title=x -f body=y",
			"gh api -X POST /repos/vombor/kanban/issues/12/comments -f body=hi",
			"gh api --method=PATCH repos/vombor/kanban/issues/12 -f state=closed",
			"gh api -XPATCH repos/o/r/issues/comments/5 -f body=x",
			"gh api repos/o/r/issues/12/comments --input body.json",
			'gh api graphql -f query=\'mutation { addComment(input: {subjectId: "x", body: "y"}) { clientMutationId } }\'',
		]) {
			const match = findDeniedCommand(command, rules);
			expect(match, command).not.toBeNull();
			expect(match && describeDeniedCommand(match), command).toContain(
				"kanban github issue create --repo <owner/name>",
			);
		}
	});

	it("leaves reading issues and other gh api calls alone", () => {
		for (const command of [
			"gh issue view 12 --comments",
			"gh issue list --repo vombor/kanban --search 'hook'",
			"gh api repos/vombor/kanban/issues",
			"gh api repos/vombor/kanban/issues/12/comments --paginate",
			"gh api -X GET repos/o/r/issues -f state=all",
			"gh api repos/o/r/pulls -f title=x",
			'gh api graphql -f query=\'query { repository(owner: "o", name: "r") { issues(first: 5) { nodes { title } } } }\'',
			"kanban github issue create --repo o/r --title t --body-file b",
		]) {
			expect(findDeniedCommand(command, rules), command).toBeNull();
		}
		expect(isGhApiIssueWrite(["-H", "Accept: x", "repos/o/r/issues/1"])).toBe(false);
	});

	it("lets Claude's hook match gh api writes instead of a Bash rule that would deny every gh api", () => {
		const apiRule = githubRules.find((rule) => rule.issuesApiWrite);
		expect(apiRule && buildClaudeBashDeny(apiRule)).toEqual([]);
		const issueRule = githubRules.find((rule) => !rule.issuesApiWrite);
		expect(issueRule && buildClaudeBashDeny(issueRule)).toContain("Bash(gh issue create)");
		const output = evaluateClaudeGuard(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "gh api repos/o/r/issues -f t=x" },
			},
			{ deniedCommands: rules },
		);
		expect(output?.hookSpecificOutput.permissionDecision).toBe("deny");
	});

	it("keeps gh api out of Codex's and Copilot's prefix rules, so their gh api reads keep working", () => {
		const codex = buildCodexRulesFile(githubRules);
		expect(codex).toContain('prefix_rule(pattern=["gh", "issue", ["create", "comment"');
		expect(codex).not.toContain('"api"');
		const copilot = buildCopilotDenyTools(githubRules);
		expect(copilot.denyTools).not.toContain("shell(gh api)");
		expect(copilot.unenforced.map((rule) => rule.pattern)).toEqual([...GITHUB_ISSUE_DENY_COMMANDS]);
	});

	it("tells agents whose CLI can't block them where issue writes go", () => {
		const guardrails = {
			role: "card",
			worktreePath: "/w",
			projectPath: "/p",
			protectedDirs: [],
			confineWrites: true,
			gitCommonDir: null,
			tempDirs: [],
			linkedDirs: [],
			extraWritableDirs: [],
			sharedBranches: ["main"],
			deniedCommands: rules,
			ownBranchPush: false,
			isolation: null,
		} satisfies TaskGuardrails;
		const note = buildGuardrailPromptNote(guardrails, ["gh issue writes"]);
		expect(note).toContain("gh api calls that write an issue or issue comment");
		expect(note).toContain("kanban github issue create|comment|edit|close");
	});
});
