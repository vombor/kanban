// The denied-command patterns of `guardrails.denyCommands` (src/config/pipeline-config.ts), and a matcher for shell
// command lines. Agent-agnostic: each agent adapter translates the parsed rules into its CLI's own mechanism
// (src/terminal/agent-guardrails.ts), and the matcher is what Kanban's own hooks use where the CLI only offers a hook.
//
// Pattern syntax: words separated by spaces, matched against a command's words from the start (a prefix: anything
// may follow). `a|b` matches either word. `{shared}` matches any shared branch, as `<name>` or `refs/heads/<name>`.
//
//   "git push"                                → git push, git push --force origin x, …
//   "git branch -D|-d|--delete {shared}"     → git branch -D main, git branch --delete refs/heads/fork/stack
//
// The matcher splits a command line on `&&`, `||`, `;`, `|`, `&`, newlines and parentheses, drops leading
// `VAR=value` words and wrappers (`sudo`, `env`, `command`, `exec`, `nohup`, `time`), looks inside `sh|bash|zsh -c
// '<script>'`, and skips git's global options (`git -C <dir> push`). It is a guard against an agent's ordinary
// command forms, not a sandbox: `eval`, scripts or aliases get past it.
import { basename } from "node:path";

const SHARED_BRANCH_PLACEHOLDER = "{shared}";

/** One denied-command rule: `words[i]` lists the words allowed at position i. */
export interface DeniedCommandRule {
	/** The pattern as configured, `{shared}` included. */
	pattern: string;
	words: string[][];
}

/** The words a `{shared}` slot stands for: each branch by name and as a full ref. */
export function expandSharedBranchWords(sharedBranches: readonly string[]): string[] {
	const words: string[] = [];
	for (const branch of sharedBranches) {
		const name = branch.trim().replace(/^refs\/heads\//u, "");
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
		const words = pattern
			.trim()
			.split(/\s+/u)
			.filter(Boolean)
			.map((token) =>
				token === SHARED_BRANCH_PLACEHOLDER ? [...sharedWords] : token.split("|").filter((word) => word.length > 0),
			);
		if (words.length === 0 || words.some((alternatives) => alternatives.length === 0)) {
			continue;
		}
		rules.push({ pattern: pattern.trim(), words });
	}
	return rules;
}

/** Every word sequence a rule stands for (the cartesian product of its alternatives). */
export function expandDeniedCommandRule(rule: DeniedCommandRule): string[][] {
	let sequences: string[][] = [[]];
	for (const alternatives of rule.words) {
		sequences = sequences.flatMap((sequence) => alternatives.map((word) => [...sequence, word]));
	}
	return sequences;
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

const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "builtin"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// git's global options that take a separate value (`git -C <dir> push`).
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

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
		if (WRAPPERS.has(basename(word))) {
			index += 1;
			// The wrapper's own options (`sudo -u root`, `env -i`): skip dash words.
			while (index < words.length && (words[index] ?? "").startsWith("-")) {
				index += 1;
			}
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

function ruleMatchesWords(rule: DeniedCommandRule, words: string[]): boolean {
	if (words.length < rule.words.length) {
		return false;
	}
	return rule.words.every((alternatives, index) => alternatives.includes(words[index] ?? ""));
}

/** The first rule a command line breaks, or null. */
export function findDeniedCommand(
	commandLine: string,
	rules: readonly DeniedCommandRule[],
): { rule: DeniedCommandRule; command: string } | null {
	for (const words of listShellCommands(commandLine)) {
		const rule = rules.find((candidate) => ruleMatchesWords(candidate, words));
		if (rule) {
			return { rule, command: words.join(" ") };
		}
	}
	return null;
}
