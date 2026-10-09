// The denied-command patterns of `guardrails.denyCommands` (src/config/pipeline-config.ts), and a matcher for shell
// command lines. Agent-agnostic: each agent adapter translates the parsed rules into its CLI's own mechanism
// (src/terminal/agent-guardrails.ts), and the matcher is what Kanban's own hooks use where the CLI only offers a hook.
//
// Pattern syntax: words separated by spaces. `a|b` matches either word. `{shared}` matches any shared branch, as
// `<name>` or `refs/heads/<name>`. The leading words (the program and its subcommand: up to the last slot that is
// neither an option slot nor `{shared}`) match the command's first words in order. The option slots and `{shared}`
// after them match any later words, in any order, so `git update-ref -m msg refs/heads/main X` and
// `git branch -q -D main` are caught. Anything else may follow.
// `{shared-push}` (only as `git push {shared-push}`) matches a push that may update a shared branch: no explicit
// target, `HEAD` without `:<branch>`, `--all`/`--mirror`/`--prune`, or a refspec whose destination is shared.
// `{shared-dest}` (only as a pattern's last word, e.g. `git fetch {shared-dest}`) matches a later word that is a
// refspec `<src>:<dst>` with a shared destination: `git fetch . card:main` and `git fetch origin main:main`
// fast-forward the local main, `git fetch origin main` (no destination) doesn't.
// `{issues-write}` (only as `gh api {issues-write}`) matches a `gh api` call that writes an issue or an issue
// comment: a REST endpoint under `repos/<owner>/<name>/issues` with a method other than GET (`-X`/`--method`, or
// fields, which make gh POST), or a GraphQL mutation that creates, edits, closes or comments on an issue.
// A destination is shared when, after stripping `refs/` and `heads/`, it is a shared branch or ends in
// `/<shared>`: git's DWIM resolves `card:heads/main` to the remote's main (isSharedRefDestination).
//
//   "git push"                                → git push, git push --force origin x, …
//   "git branch -D|-d|--delete {shared}"     → git branch -D main, git branch -q --delete refs/heads/fork/stack
//
// Because `{shared}` matches anywhere after the subcommand, a command that names a shared branch only as a start
// point is caught as well (`git checkout -B card main`); `origin/main` is not a shared-branch word.
//
// The matcher splits a command line on `&&`, `||`, `;`, `|`, `&`, newlines and parentheses, drops leading
// `VAR=value` words and wrappers (`sudo`, `env`, `timeout`, `nice`, …), looks inside `sh|bash|zsh -c '<script>'`,
// and skips git's global options (`git -C <dir> push`). It is a guard against an agent's ordinary command forms, not
// a sandbox: `eval`, scripts or aliases get past it.
import { basename } from "node:path";

const SHARED_BRANCH_PLACEHOLDER = "{shared}";
const SHARED_PUSH_PLACEHOLDER = "{shared-push}";
const SHARED_DESTINATION_PLACEHOLDER = "{shared-dest}";
const ISSUES_WRITE_PLACEHOLDER = "{issues-write}";

/**
 * Agents never approve a plan: the user approves it on the board (or from their own shell). Every card with guardrails
 * and the orchestrator's isolation guardrails deny these on top of the configured `denyCommands`, which can't drop
 * them (src/guardrails/task-guardrails.ts). The runtime's plans.approve route refuses every agent session anyway
 * (src/trpc/plans-api.ts); this rail stops the attempt where the agent's CLI can.
 */
export const PLAN_APPROVAL_DENY_COMMANDS: readonly string[] = [
	"kanban plan approve",
	"kanban plan expand --approved-by-user",
];

/**
 * Agents file and comment on GitHub issues as the machine's Kanban GitHub App, through `kanban github issue ...`
 * (src/commands/github.ts), which signs each post with the project; never with `gh` and the user's PAT. Appended
 * like the plan-approval rail, so a configured `denyCommands` can't drop them. Reading issues stays allowed.
 */
export const GITHUB_ISSUE_DENY_COMMANDS: readonly string[] = [
	"gh issue create|comment|edit|close|reopen|delete|lock|unlock|transfer|pin|unpin",
	`gh api ${ISSUES_WRITE_PLACEHOLDER}`,
];

/** The rails every card with guardrails and the orchestrator's isolation guardrails get on top of their own rules. */
export const BUILT_IN_DENY_COMMANDS: readonly string[] = [
	...PLAN_APPROVAL_DENY_COMMANDS,
	...GITHUB_ISSUE_DENY_COMMANDS,
];

/** One denied-command rule: `words[i]` lists the words allowed in slot i. */
export interface DeniedCommandRule {
	/** The pattern as configured, `{shared}` included. */
	pattern: string;
	words: string[][];
	/** Slots `[0, headLength)` match the command's first words in order; the others match any later words. */
	headLength: number;
	/** `git push {shared-push}`: the shared branch names the push may not update (pushMayUpdateSharedBranch). */
	sharedPush?: string[];
	/** `… {shared-dest}`: the shared branch names no later refspec may name as its destination (hasSharedRefspec). */
	sharedDestination?: string[];
	/** `gh api {issues-write}`: matches only a call that writes an issue or comment (isGhApiIssueWrite). */
	issuesApiWrite?: boolean;
}

function toSharedBranchName(branch: string): string {
	return branch.trim().replace(/^refs\/heads\//u, "");
}

/**
 * Whether a refspec destination names a shared branch: after stripping `refs/` and `heads/`, it is one or ends in
 * `/<shared>`. Errs on the side of "shared": `refs/remotes/origin/main` and `feature/main` count too.
 */
export function isSharedRefDestination(destination: string, sharedBranches: readonly string[]): boolean {
	const ref = destination
		.trim()
		.replace(/^refs\//u, "")
		.replace(/^heads\//u, "");
	return sharedBranches.some((branch) => {
		const name = toSharedBranchName(branch);
		return name.length > 0 && (ref === name || ref.endsWith(`/${name}`));
	});
}

/**
 * Whether some word is a refspec `[+]<src>:<dst>` whose destination is shared (`{shared-dest}`). A pattern
 * destination counts unless it is under `refs/remotes/` (`refs/heads/*:refs/heads/*` writes the local main).
 */
export function hasSharedRefspec(args: readonly string[], sharedBranches: readonly string[]): boolean {
	return args.some((arg) => {
		if (arg.startsWith("-")) {
			return false;
		}
		const colon = arg.indexOf(":");
		if (colon === -1) {
			return false;
		}
		const destination = arg.slice(colon + 1);
		if (destination.includes("*")) {
			return !destination.startsWith("refs/remotes/");
		}
		return isSharedRefDestination(destination, sharedBranches);
	});
}

/** The words a `{shared}` slot stands for: each branch by name and as a full ref. */
export function expandSharedBranchWords(sharedBranches: readonly string[]): string[] {
	const words: string[] = [];
	for (const branch of sharedBranches) {
		const name = toSharedBranchName(branch);
		if (!name) {
			continue;
		}
		for (const word of [name, `refs/heads/${name}`]) {
			if (!words.includes(word)) {
				words.push(word);
			}
		}
	}
	return words;
}

/** Parses the configured patterns. A pattern whose `{shared}` has no branches to stand for is dropped. */
export function parseDeniedCommandPatterns(
	patterns: readonly string[],
	sharedBranches: readonly string[],
): DeniedCommandRule[] {
	const sharedWords = expandSharedBranchWords(sharedBranches);
	const rules: DeniedCommandRule[] = [];
	for (const pattern of patterns) {
		const tokens = pattern.trim().split(/\s+/u).filter(Boolean);
		const sharedPush = tokens.at(-1) === SHARED_PUSH_PLACEHOLDER;
		if (sharedPush) {
			tokens.pop();
			if (tokens.join(" ") !== "git push") {
				continue;
			}
		}
		const issuesApiWrite = tokens.at(-1) === ISSUES_WRITE_PLACEHOLDER;
		if (issuesApiWrite) {
			tokens.pop();
			if (tokens.join(" ") !== "gh api") {
				continue;
			}
		}
		const sharedDestination = tokens.at(-1) === SHARED_DESTINATION_PLACEHOLDER;
		if (sharedDestination) {
			tokens.pop();
			if (tokens.length === 0 || tokens.some((token) => token.startsWith("{"))) {
				continue;
			}
		}
		const words = tokens.map((token) =>
			token === SHARED_BRANCH_PLACEHOLDER ? [...sharedWords] : token.split("|").filter((word) => word.length > 0),
		);
		if (words.length === 0 || words.some((alternatives) => alternatives.length === 0)) {
			continue;
		}
		// The head runs through the last slot that is neither `{shared}` nor an option slot.
		let headLength = 1;
		tokens.forEach((token, index) => {
			const floats =
				token === SHARED_BRANCH_PLACEHOLDER || (words[index] ?? []).every((word) => word.startsWith("-"));
			if (index > 0 && !floats) {
				headLength = index + 1;
			}
		});
		const sharedNames = sharedBranches.map(toSharedBranchName).filter((name) => name.length > 0);
		if (sharedDestination && sharedNames.length === 0) {
			continue;
		}
		rules.push({
			pattern: pattern.trim(),
			words,
			headLength,
			...(sharedPush ? { sharedPush: sharedNames } : {}),
			...(sharedDestination ? { sharedDestination: sharedNames } : {}),
			...(issuesApiWrite ? { issuesApiWrite: true } : {}),
		});
	}
	return rules;
}

function isPlainGitPushRule(rule: DeniedCommandRule): boolean {
	const [program, subcommand] = rule.words;
	return (
		!rule.sharedPush &&
		!rule.sharedDestination &&
		!rule.issuesApiWrite &&
		rule.words.length === 2 &&
		program?.length === 1 &&
		program[0] === "git" &&
		subcommand?.length === 1 &&
		subcommand[0] === "push"
	);
}

/**
 * The rules of a card that may push its own branch (the PR git action): a plain `git push` rule becomes
 * `git push {shared-push}`, so a push that names a non-shared target branch is allowed.
 */
export function allowOwnBranchPush(
	rules: readonly DeniedCommandRule[],
	sharedBranches: readonly string[],
): DeniedCommandRule[] {
	const [sharedPushRule] = parseDeniedCommandPatterns([`git push ${SHARED_PUSH_PLACEHOLDER}`], sharedBranches);
	return rules.map((rule) => (sharedPushRule && isPlainGitPushRule(rule) ? sharedPushRule : rule));
}

/** The cartesian product of slot alternatives. */
export function expandSlots(slots: readonly (readonly string[])[]): string[][] {
	let sequences: string[][] = [[]];
	for (const alternatives of slots) {
		sequences = sequences.flatMap((sequence) => alternatives.map((word) => [...sequence, word]));
	}
	return sequences;
}

/** Every word sequence a rule stands for (the cartesian product of its alternatives), in pattern order. */
export function expandDeniedCommandRule(rule: DeniedCommandRule): string[][] {
	return expandSlots(rule.words);
}

const SEPARATORS = new Set(["&&", "||", ";", "|", "|&", "&", "\n", "(", ")"]);

/**
 * Splits a shell command line into simple commands, each a list of words with quotes removed. Redirections and
 * their targets are dropped. Unbalanced quotes run to the end of the line.
 */
export function splitShellCommandLine(commandLine: string): string[][] {
	const commands: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let skipNextWord = false;
	const endWord = () => {
		if (!inWord) {
			return;
		}
		if (skipNextWord) {
			skipNextWord = false;
		} else {
			words.push(word);
		}
		word = "";
		inWord = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length > 0) {
			commands.push(words);
		}
		words = [];
	};
	for (let i = 0; i < commandLine.length; i += 1) {
		const char = commandLine[i] ?? "";
		if (char === "'") {
			const end = commandLine.indexOf("'", i + 1);
			word += end === -1 ? commandLine.slice(i + 1) : commandLine.slice(i + 1, end);
			inWord = true;
			i = end === -1 ? commandLine.length : end;
			continue;
		}
		if (char === '"') {
			inWord = true;
			for (i += 1; i < commandLine.length && commandLine[i] !== '"'; i += 1) {
				if (commandLine[i] === "\\" && i + 1 < commandLine.length && '"\\$`'.includes(commandLine[i + 1] ?? "")) {
					i += 1;
				}
				word += commandLine[i];
			}
			continue;
		}
		if (char === "\\") {
			if (commandLine[i + 1] === "\n") {
				i += 1;
				continue;
			}
			word += commandLine[i + 1] ?? "";
			inWord = true;
			i += 1;
			continue;
		}
		if (char === "#" && !inWord) {
			const end = commandLine.indexOf("\n", i);
			i = end === -1 ? commandLine.length : end - 1;
			continue;
		}
		if (char === "$" && commandLine[i + 1] === "(") {
			endCommand();
			i += 1;
			continue;
		}
		if (char === "`") {
			endCommand();
			continue;
		}
		const two = commandLine.slice(i, i + 2);
		if (two === "&>") {
			endWord();
			i += commandLine[i + 2] === ">" ? 2 : 1;
			skipNextWord = true;
			continue;
		}
		if (SEPARATORS.has(two)) {
			endCommand();
			i += 1;
			continue;
		}
		if (SEPARATORS.has(char)) {
			endCommand();
			continue;
		}
		if (char === ">" || char === "<") {
			// `2>`/`&>`: the digit or `&` already went into the word; it isn't one.
			if (inWord && /^(?:\d+|&)$/u.test(word)) {
				word = "";
				inWord = false;
			}
			endWord();
			while (commandLine[i + 1] === ">" || commandLine[i + 1] === "&" || commandLine[i + 1] === "|") {
				i += 1;
			}
			// `2>&1`: the target is a descriptor, not a word.
			if (/^\d/u.test(commandLine[i + 1] ?? "") && commandLine[i] === "&") {
				while (/\d/u.test(commandLine[i + 1] ?? "")) {
					i += 1;
				}
				continue;
			}
			skipNextWord = true;
			continue;
		}
		if (char === " " || char === "\t" || char === "\r") {
			endWord();
			continue;
		}
		word += char;
		inWord = true;
	}
	endCommand();

	return commands;
}

// Wrappers that run their arguments as the command, with the options of each that take a separate value.
const WRAPPERS = new Map<string, ReadonlySet<string>>([
	["sudo", new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"])],
	["env", new Set(["-u", "-C", "--unset", "--chdir"])],
	["command", new Set()],
	["exec", new Set(["-a"])],
	["nohup", new Set()],
	["time", new Set(["-f", "-o"])],
	["builtin", new Set()],
	["nice", new Set(["-n", "--adjustment"])],
	["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
	["stdbuf", new Set(["-i", "-o", "-e"])],
	["setsid", new Set()],
	["ionice", new Set(["-c", "-n", "-p", "-P", "-u"])],
	["xargs", new Set(["-n", "-L", "-I", "-P", "-d", "-a", "-E", "-s"])],
]);
// Wrappers with a positional argument before the command (`timeout 30 git push`).
const WRAPPER_POSITIONAL_ARGUMENTS = new Map<string, number>([["timeout", 1]]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// git's global options that take a separate value (`git -C <dir> push`).
const GIT_OPTIONS_WITH_VALUE = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--config-env",
	"--super-prefix",
]);

function isAssignment(word: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word);
}

/** The words a matcher compares: wrappers and assignments dropped, the program by its base name, git's globals skipped. */
function normalizeCommandWords(words: string[]): string[] {
	let index = 0;
	while (index < words.length) {
		const word = words[index] ?? "";
		if (isAssignment(word)) {
			index += 1;
			continue;
		}
		const wrapper = basename(word);
		const optionsWithValue = WRAPPERS.get(wrapper);
		if (optionsWithValue) {
			index += 1;
			// The wrapper's own options (`sudo -u root`, `env -i`, `nice -n 5`) and positional arguments (`timeout 30`).
			while (index < words.length && (words[index] ?? "").startsWith("-")) {
				index += optionsWithValue.has(words[index] ?? "") ? 2 : 1;
			}
			index += WRAPPER_POSITIONAL_ARGUMENTS.get(wrapper) ?? 0;
			continue;
		}
		break;
	}
	const rest = words.slice(index);
	if (rest.length === 0) {
		return [];
	}
	const program = basename(rest[0] ?? "");
	if (program !== "git") {
		return [program, ...rest.slice(1)];
	}
	let argIndex = 1;
	while (argIndex < rest.length && (rest[argIndex] ?? "").startsWith("-")) {
		argIndex += GIT_OPTIONS_WITH_VALUE.has(rest[argIndex] ?? "") ? 2 : 1;
	}
	return [program, ...rest.slice(argIndex)];
}

/** Each simple command of a command line, normalized; `sh -c '<script>'` contributes the script's commands. */
export function listShellCommands(commandLine: string, depth = 0): string[][] {
	const commands: string[][] = [];
	for (const words of splitShellCommandLine(commandLine)) {
		const normalized = normalizeCommandWords(words);
		if (normalized.length === 0) {
			continue;
		}
		const program = normalized[0] ?? "";
		const scriptFlagIndex = normalized.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/u.test(word));
		if (SHELLS.has(program) && scriptFlagIndex > 0 && depth < 3) {
			const script = normalized[scriptFlagIndex + 1];
			if (script !== undefined) {
				commands.push(...listShellCommands(script, depth + 1));
				continue;
			}
		}
		commands.push(normalized);
	}
	return commands;
}

// `git push` options that take a separate value, and the ones that push (or prune) refs without naming them.
const GIT_PUSH_OPTIONS_WITH_VALUE = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
const GIT_PUSH_UNNAMED_REFS_OPTIONS = new Set(["--all", "--branches", "--mirror", "--prune"]);

/**
 * Whether `git push <args>` may update a shared branch: true unless every refspec names a destination branch that
 * is not shared. A push without refspecs (push.default picks the target), `HEAD`/`@` without `:<branch>` (the
 * current branch, which could be a shared one), a pattern refspec and `--all`/`--mirror`/`--prune` count as "may".
 */
export function pushMayUpdateSharedBranch(args: readonly string[], sharedBranches: readonly string[]): boolean {
	const positionals: string[] = [];
	let repositoryGiven = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--") {
			positionals.push(...args.slice(index + 1));
			break;
		}
		if (arg.startsWith("-")) {
			const name = arg.split("=")[0] ?? arg;
			if (GIT_PUSH_UNNAMED_REFS_OPTIONS.has(name)) {
				return true;
			}
			repositoryGiven ||= name === "--repo";
			if (GIT_PUSH_OPTIONS_WITH_VALUE.has(arg)) {
				index += 1;
			}
			continue;
		}
		positionals.push(arg);
	}
	const refspecs = repositoryGiven ? positionals : positionals.slice(1);
	if (refspecs.length === 0) {
		return true;
	}
	return refspecs.some((refspec) => {
		const spec = refspec.replace(/^\+/u, "");
		const colon = spec.indexOf(":");
		const destination = colon === -1 ? spec : spec.slice(colon + 1);
		if (destination === "" || destination === "HEAD" || destination === "@" || destination.includes("*")) {
			return true;
		}
		return isSharedRefDestination(destination, sharedBranches);
	});
}

// `gh api` options that take a value (gh api --help); fields make gh send a POST unless a method is given.
const GH_API_FIELD_OPTIONS = new Set(["-f", "--raw-field", "-F", "--field", "--input"]);
const GH_API_VALUE_OPTIONS = new Set([
	"-X",
	"--method",
	"-H",
	"--header",
	"-q",
	"--jq",
	"-t",
	"--template",
	"--hostname",
	"--cache",
	"-p",
	"--preview",
	...GH_API_FIELD_OPTIONS,
]);
const ISSUES_ENDPOINT = /^\/?repos\/[^/\s]+\/[^/\s]+\/issues(?:[/?#]|$)/u;
const ISSUE_MUTATION =
	/\bmutation\b[\s\S]*\b(createIssue|updateIssue|closeIssue|reopenIssue|deleteIssue|addComment|updateIssueComment|deleteIssueComment|transferIssue|pinIssue|unpinIssue|lockLockable|unlockLockable)\b/u;

/** Whether `gh api <args>` writes a GitHub issue or issue comment. */
export function isGhApiIssueWrite(args: readonly string[]): boolean {
	let endpoint: string | null = null;
	let method: string | null = null;
	let hasFields = false;
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		const [name, inline] = arg.startsWith("--")
			? [arg.split("=")[0] ?? arg, arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : null]
			: [arg, null];
		// `-XPOST` and `-fbody=x`: the value glued to a short option.
		const short = /^-([XfF])(.+)$/u.exec(arg);
		if (short) {
			if (short[1] === "X") {
				method = short[2] ?? null;
			} else {
				hasFields = true;
				values.push(short[2] ?? "");
			}
			continue;
		}
		if (GH_API_VALUE_OPTIONS.has(name)) {
			const value = inline ?? args[index + 1] ?? "";
			if (inline === null) {
				index += 1;
			}
			if (name === "-X" || name === "--method") {
				method = value;
			} else if (GH_API_FIELD_OPTIONS.has(name)) {
				hasFields = true;
				values.push(value);
			}
			continue;
		}
		if (!arg.startsWith("-") && endpoint === null) {
			endpoint = arg;
		}
	}
	if (endpoint === null) {
		return false;
	}
	if (endpoint === "graphql") {
		return values.some((value) => ISSUE_MUTATION.test(value));
	}
	if (!ISSUES_ENDPOINT.test(endpoint)) {
		return false;
	}
	const effective = (method ?? (hasFields ? "POST" : "GET")).toUpperCase();
	return effective !== "GET" && effective !== "HEAD";
}

/** Whether each floating slot is matched by a different one of `words`, in any order. */
function matchFloatingSlots(slots: readonly string[][], words: readonly string[], used: boolean[] = []): boolean {
	const [slot, ...rest] = slots;
	if (!slot) {
		return true;
	}
	return words.some((word, index) => {
		if (used[index] || !slot.includes(word)) {
			return false;
		}
		const nextUsed = [...used];
		nextUsed[index] = true;
		return matchFloatingSlots(rest, words, nextUsed);
	});
}

function ruleMatchesWords(rule: DeniedCommandRule, words: string[]): boolean {
	if (words.length < rule.words.length) {
		return false;
	}
	const head = rule.words.slice(0, rule.headLength);
	if (!head.every((alternatives, index) => alternatives.includes(words[index] ?? ""))) {
		return false;
	}
	const after = words.slice(rule.headLength);
	if (rule.issuesApiWrite) {
		return isGhApiIssueWrite(after);
	}
	if (rule.sharedPush) {
		return pushMayUpdateSharedBranch(after, rule.sharedPush);
	}
	if (rule.sharedDestination && !hasSharedRefspec(after, rule.sharedDestination)) {
		return false;
	}
	return matchFloatingSlots(rule.words.slice(rule.headLength), after);
}

export interface DeniedCommandMatch {
	rule: DeniedCommandRule;
	command: string;
}

/** The first rule a command line breaks, or null. */
export function findDeniedCommand(commandLine: string, rules: readonly DeniedCommandRule[]): DeniedCommandMatch | null {
	for (const words of listShellCommands(commandLine)) {
		const rule = rules.find((candidate) => ruleMatchesWords(candidate, words));
		if (rule) {
			return { rule, command: words.join(" ") };
		}
	}
	return null;
}

/** What Kanban's guard hooks tell the agent about a blocked command. */
export function describeDeniedCommand(match: DeniedCommandMatch): string {
	const blocked = `Blocked by Kanban's task-card guardrails: \`${match.command}\``;
	if (PLAN_APPROVAL_DENY_COMMANDS.includes(match.rule.pattern)) {
		return `Blocked by Kanban's guardrails: \`${match.command}\`. Agents never approve a plan; the user approves it on the board (Approve plan). Tell the user the plan is ready for their approval.`;
	}
	if (GITHUB_ISSUE_DENY_COMMANDS.includes(match.rule.pattern)) {
		return `${blocked} writes a GitHub issue with the user's own login. Use Kanban's GitHub App instead, which signs the post with this project: \`kanban github issue create --repo <owner/name> --title <title> --body-file <file>\` (also \`comment --number <n> --body-file <file>\`, \`edit\`, \`close\`). Reading issues (\`gh issue view|list\`, \`gh api\` GETs) is fine.`;
	}
	if (match.rule.sharedPush) {
		return `${blocked} may update a shared branch (${match.rule.sharedPush.join(", ")}). This card may push only its own branch, named explicitly: \`git push -u origin HEAD:<your-branch>\` or \`git push -u origin <your-branch>\`.`;
	}
	if (match.rule.sharedDestination) {
		return `${blocked} writes a shared branch (${match.rule.sharedDestination.join(", ")}) through a refspec destination. Fetch without a local destination (\`git fetch origin main\`, then use \`origin/main\`), and leave shared branches to the orchestrator.`;
	}
	const pushHint = isPlainGitPushRule(match.rule)
		? " To let this card push its own branch, the user sets the card's git action to PR and restarts its session (with guardrails.prCardPush `own-branch`, the default); don't work around the block."
		: "";
	return `${blocked} matches "${match.rule.pattern}". Task cards never push, rewrite shared branches or restart services; leave that to the orchestrator.${pushHint}`;
}

/**
 * Project isolation: the first word of a command line that names a path inside one of `roots` (absolute, `~/`, or
 * relative with a `..` segment, resolved against `cwd`), or null. Also catches `--opt=/path`. Like the command
 * matcher it sees the command as written, so a path built at run time (`$VAR`, globs) gets past it.
 */
export function findDeniedPathInCommand(
	commandLine: string,
	roots: readonly string[],
	cwd: string | undefined,
	userHome: string = process.env.HOME ?? "",
): string | null {
	if (roots.length === 0) {
		return null;
	}
	const normalizedRoots = roots.map((root) => root.replace(/\/+$/u, ""));
	const inside = (path: string) =>
		normalizedRoots.some((root) => root.length > 0 && (path === root || path.startsWith(`${root}/`)));
	for (const words of splitShellCommandLine(commandLine)) {
		for (const word of words) {
			const value = word.includes("=") && word.startsWith("-") ? word.slice(word.indexOf("=") + 1) : word;
			let path: string | null = null;
			if (value.startsWith("/")) {
				path = value;
			} else if ((value === "~" || value.startsWith("~/")) && userHome) {
				path = `${userHome}${value.slice(1)}`;
			} else if (cwd && /(^|\/)\.\.(\/|$)/u.test(value)) {
				path = `${cwd}/${value}`;
			}
			if (path && inside(normalizeSlashPath(path))) {
				return word;
			}
		}
	}
	return null;
}

/** Programs that only read the files they name: naming a protected file is fine, a redirect into it isn't. */
const READ_ONLY_PROGRAMS = new Set([
	"cat",
	"less",
	"more",
	"head",
	"tail",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"jq",
	"ls",
	"stat",
	"wc",
	"diff",
	"cmp",
	"file",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"bat",
]);

/**
 * Project isolation's shell-write check for the machine-wide config (config.json, the agents' config): the word of
 * `commandLine` that writes inside one of `roots`, or null. A redirect into it (`> config.json`, `>> …`), or any
 * program but a read-only one naming it, even inside a script (`sed -i`, `cp`, `python -c "open('…','w')"`). Like
 * the other command checks it only sees the command as written.
 */
export function findProtectedFileWrite(
	commandLine: string,
	roots: readonly string[],
	cwd: string | undefined,
	userHome: string = process.env.HOME ?? "",
): string | null {
	const normalizedRoots = roots.map((root) => normalizeSlashPath(root)).filter((root) => root !== "/");
	if (normalizedRoots.length === 0) {
		return null;
	}
	const inside = (path: string) => normalizedRoots.some((root) => path === root || path.startsWith(`${root}/`));
	const resolveWord = (value: string): string | null => {
		if (value.startsWith("/")) {
			return normalizeSlashPath(value);
		}
		if ((value === "~" || value.startsWith("~/")) && userHome) {
			return normalizeSlashPath(`${userHome}${value.slice(1)}`);
		}
		return cwd ? normalizeSlashPath(`${cwd}/${value}`) : null;
	};
	// The splitter drops redirections: their targets are read from the line itself.
	for (const match of commandLine.matchAll(/(?:^|[^<>-])(?:\d|&)?>{1,2}\|?\s*(["']?)([^\s"'|;&<>()]+)\1/gu)) {
		const target = match[2] ?? "";
		const path = resolveWord(target);
		if (path && inside(path)) {
			return target;
		}
	}
	const homeForms = (root: string) =>
		userHome && root.startsWith(`${userHome}/`) ? [root, `~${root.slice(userHome.length)}`] : [root];
	const named = normalizedRoots.flatMap(homeForms);
	for (const words of splitShellCommandLine(commandLine)) {
		const programIndex = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word));
		const program = (words[programIndex] ?? "").split("/").pop() ?? "";
		if (programIndex === -1 || READ_ONLY_PROGRAMS.has(program)) {
			continue;
		}
		for (const word of words.slice(programIndex + 1)) {
			const path = word.startsWith("/") || word.startsWith("~") ? resolveWord(word) : null;
			if ((path && inside(path)) || named.some((root) => word.includes(root))) {
				return word;
			}
		}
	}
	return null;
}

/** `/a/./b/../c//` → `/a/c` (no filesystem access). */
function normalizeSlashPath(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") {
			continue;
		}
		if (part === "..") {
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return `/${parts.join("/")}`;
}

/** What Kanban's guard hooks tell the agent about a command that names another project's path. */
export function describeDeniedPath(word: string): string {
	return `Blocked by Kanban's project isolation: \`${word}\` is outside this session's project (another project, its data, or machine-wide config). Work only on this project; ask the user if you need anything else.`;
}
