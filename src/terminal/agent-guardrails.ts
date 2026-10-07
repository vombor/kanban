// How each agent CLI enforces a task card's guardrails (src/guardrails/task-guardrails.ts), kept with the other
// per-agent adapter knowledge. Every mechanism below was checked against the installed CLI on 2026-10-07:
//
// - Claude Code (2.1.x): `permissions.deny` in the card's --settings file. `Bash(<prefix> *)` rules apply to each
//   subcommand of a compound command, also in auto mode; `Edit(//<abs>/**)` covers the file tools, the Bash file
//   commands Claude Code recognizes and redirect targets (code.claude.com/docs/en/permissions). The user's own
//   autoMode rules apply on top.
// - Codex (0.160): `prefix_rule(..., decision="forbidden")` in `<worktree>/.codex/rules/` (project rules of a
//   trusted project; Kanban pre-trusts the repo). Verified to reject `git push` even with
//   --dangerously-bypass-approvals-and-sandbox. Matching is by argv prefix, so `git -C <dir> push` is not caught.
//   Writes are confined by `--sandbox workspace-write` (reads stay unrestricted) only where Codex's Linux sandbox
//   runs (bubblewrap with user namespaces; a rootless container usually can't), so it is probed first.
// - Cline CLI (3.x): no deny flag, and tool policies are per tool. Its PreToolUse hook is blocking: `{"cancel":
//   true, "errorMessage"}` stops the tool call before it runs and ends the turn with that reason. Kanban's hook runs
//   `kanban hooks cline-guard`, which checks `run_commands` against the deny list and `editor`/`apply_patch`
//   paths against the writable dirs. Shell commands that write files are not confined.
// - GitHub Copilot CLI (1.0.92): `--deny-tool` wins over --allow-all-tools and doesn't trigger autopilot's
//   blocking "Enable autopilot mode" dialog. `shell(<cmd> <sub>)` matches by command name, plus the first
//   subcommand only for git and gh (`shell(podman restart)` blocks nothing). `write(<dir>/**)` denies the file
//   tools in a subtree, but not shell writes, and there is no "allow only": deny wins over allow. Confining paths
//   with --add-dir instead of --allow-all-paths would confine reads too, and without all permissions autopilot
//   (0aa75) opens that dialog, which hangs the card. So Copilot keeps --allow-all-paths and denies writes into the
//   main checkout and the project's other worktrees.
// - Gemini, OpenCode, Droid, Kiro: not installed here, so nothing was verified against their CLI: prompt only.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeAgentId } from "../core/api-contract";
import { type DeniedCommandRule, expandDeniedCommandRule } from "../guardrails/command-patterns";
import { isPathInside, type TaskGuardrails } from "../guardrails/task-guardrails";

export type GuardrailEnforcement = "native" | "partial" | "prompt" | "none";

export interface AgentGuardrailReport {
	commands: { level: GuardrailEnforcement; mechanism: string };
	writes: { level: GuardrailEnforcement; mechanism: string };
	reads: { level: GuardrailEnforcement; mechanism: string };
	/** What the CLI does not block; non-empty means the launch prompt carries the guardrail note. */
	unenforced: string[];
}

export interface AgentGuardrailContext {
	/** Whether the agent's sandbox is used (probeAgentSandbox; Codex only); null = not probed. */
	codexSandbox?: boolean | null;
	/** The rules this launch got (Copilot can't express some); defaults to none. */
	deniedCommands?: readonly DeniedCommandRule[];
	/** `guardrails.confineWrites`; default true. */
	confineWrites?: boolean;
}

// ---------------------------------------------------------------------------
// GitHub Copilot CLI
// ---------------------------------------------------------------------------

// Copilot matches the first subcommand only for these programs (`copilot help permissions`).
const COPILOT_SUBCOMMAND_PROGRAMS = new Set(["git", "gh"]);

/** The `shell(...)` deny patterns for the rules Copilot can express exactly; the rest go to `unenforced`. */
export function buildCopilotDenyTools(rules: readonly DeniedCommandRule[]): {
	denyTools: string[];
	unenforced: DeniedCommandRule[];
} {
	const denyTools: string[] = [];
	const unenforced: DeniedCommandRule[] = [];
	for (const rule of rules) {
		const [program, subcommands] = rule.words;
		if (rule.words.length === 1 && program) {
			denyTools.push(...program.map((word) => `shell(${word})`));
		} else if (
			rule.words.length === 2 &&
			program?.length === 1 &&
			COPILOT_SUBCOMMAND_PROGRAMS.has(program[0] ?? "") &&
			subcommands
		) {
			denyTools.push(...subcommands.map((word) => `shell(${program[0]} ${word})`));
		} else {
			unenforced.push(rule);
		}
	}
	return { denyTools: [...new Set(denyTools)], unenforced };
}

/** `write(<dir>/**)` denies for the main checkout and the project's other worktrees (file tools only). */
export function buildCopilotWriteDenyTools(guardrails: TaskGuardrails): string[] {
	return guardrails.confineWrites ? guardrails.protectedDirs.map((dir) => `write(${dir}/**)`) : [];
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export const CODEX_GUARDRAIL_RULES_RELATIVE_PATH = ".codex/rules/kanban-guardrails.rules";

function toStarlarkString(value: string): string {
	return JSON.stringify(value);
}

/** The execpolicy rules file: one `forbidden` prefix rule per pattern (a list position = alternatives). */
export function buildCodexRulesFile(rules: readonly DeniedCommandRule[]): string {
	const lines = [
		"# kanban-managed: task-card guardrails (guardrails.denyCommands in Kanban's config.json). Rewritten at each launch.",
	];
	for (const rule of rules) {
		// The program position is always a single word: one rule per program.
		const [programs = [], ...rest] = rule.words;
		for (const program of programs) {
			const pattern = [toStarlarkString(program)].concat(
				rest.map((alternatives) =>
					alternatives.length === 1
						? toStarlarkString(alternatives[0] ?? "")
						: `[${alternatives.map(toStarlarkString).join(", ")}]`,
				),
			);
			lines.push(
				`prefix_rule(pattern=[${pattern.join(", ")}], decision="forbidden", justification=${toStarlarkString(
					`Kanban guardrail for task cards: ${rule.pattern}`,
				)})`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** The --add-dir dirs of Codex's workspace-write sandbox (the cwd, /tmp and $TMPDIR are always writable). */
export function listCodexWritableDirs(guardrails: TaskGuardrails): string[] {
	const dirs = [guardrails.gitCommonDir, ...guardrails.linkedDirs, ...guardrails.extraWritableDirs].filter(
		(dir): dir is string => Boolean(dir),
	);
	return [...new Set(dirs)].filter((dir) => !isPathInside(guardrails.worktreePath, dir));
}

const CODEX_SANDBOX_PROBE_TIMEOUT_MS = 15_000;
const codexSandboxProbes = new Map<string, Promise<boolean>>();

async function runCodexSandboxProbe(binary: string): Promise<boolean> {
	const dir = await mkdtemp(join(tmpdir(), "kanban-codex-sandbox-"));
	try {
		return await new Promise<boolean>((resolvePromise) => {
			const child = spawn(binary, ["sandbox", "-P", ":workspace", "-C", dir, "--", "true"], {
				stdio: "ignore",
			});
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolvePromise(false);
			}, CODEX_SANDBOX_PROBE_TIMEOUT_MS);
			child.once("error", () => {
				clearTimeout(timer);
				resolvePromise(false);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				resolvePromise(code === 0);
			});
		});
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Whether `codex sandbox` can run a command here (once per binary per process). */
export async function probeCodexSandbox(binary = "codex"): Promise<boolean> {
	let probe = codexSandboxProbes.get(binary);
	if (!probe) {
		probe = runCodexSandboxProbe(binary);
		codexSandboxProbes.set(binary, probe);
	}
	return await probe;
}

/** Whether the agent's OS sandbox runs here, for agents that have one (Codex); null for the others. */
export async function probeAgentSandbox(agentId: RuntimeAgentId, binary: string): Promise<boolean | null> {
	return agentId === "codex" ? await probeCodexSandbox(binary) : null;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/** `permissions.deny` entries for a card's --settings file. */
export function buildClaudePermissionDeny(guardrails: TaskGuardrails): string[] {
	const deny: string[] = [];
	for (const rule of guardrails.deniedCommands) {
		for (const words of expandDeniedCommandRule(rule)) {
			const command = words.join(" ");
			deny.push(`Bash(${command})`, `Bash(${command} *)`);
		}
	}
	if (guardrails.confineWrites) {
		// `//` is an absolute path from the filesystem root in a permission rule.
		deny.push(...guardrails.protectedDirs.map((dir) => `Edit(/${dir}/**)`));
	}
	return [...new Set(deny)];
}

// ---------------------------------------------------------------------------
// Cline CLI
// ---------------------------------------------------------------------------

/** What `kanban hooks cline-guard` gets (base64 JSON on its command line). */
export interface ClineGuardPolicy {
	worktreePath: string;
	confineWrites: boolean;
	writableRoots: string[];
	deniedCommands: DeniedCommandRule[];
}

// ---------------------------------------------------------------------------
// The report (kanban doctor) and the prompt note
// ---------------------------------------------------------------------------

function describeUnenforcedRules(rules: readonly DeniedCommandRule[]): string[] {
	return rules.length > 0 ? [`commands: ${rules.map((rule) => rule.pattern).join("; ")}`] : [];
}

export function describeAgentGuardrails(
	agentId: RuntimeAgentId,
	context: AgentGuardrailContext = {},
): AgentGuardrailReport {
	const unrestrictedReads = {
		level: "none" as const,
		mechanism: "not restricted, by design: cards read docs, other worktrees and transcripts",
	};
	const confineWrites = context.confineWrites ?? true;
	const notConfined = { level: "none" as const, mechanism: "guardrails.confineWrites is off" };
	switch (agentId) {
		case "claude":
			return {
				commands: { level: "native", mechanism: "permissions.deny Bash rules in the card's --settings file" },
				writes: confineWrites
					? {
							level: "partial",
							mechanism:
								"Edit deny on the main checkout and the project's other worktrees; other paths are left to the user's autoMode rules",
						}
					: notConfined,
				reads: unrestrictedReads,
				unenforced: [],
			};
		case "codex": {
			const sandbox = context.codexSandbox === true;
			return {
				commands: {
					level: "partial",
					mechanism: "execpolicy forbidden rules in .codex/rules (argv prefix: `git -C <dir> push` is not caught)",
				},
				writes: !confineWrites
					? notConfined
					: sandbox
						? { level: "native", mechanism: "--sandbox workspace-write (+ the git dir, shared dirs)" }
						: {
								level: "prompt",
								mechanism:
									context.codexSandbox === false
										? "Codex's sandbox can't run on this host (bubblewrap), so cards keep --dangerously-bypass-approvals-and-sandbox"
										: "workspace-write sandbox when Codex's sandbox runs on the host (not probed)",
							},
				reads: unrestrictedReads,
				unenforced: [
					"command forms other than the plain prefix",
					...(sandbox || !confineWrites ? [] : ["writes outside the worktree"]),
				],
			};
		}
		case "cline":
			return {
				commands: { level: "native", mechanism: "Kanban's PreToolUse hook cancels matching run_commands" },
				writes: confineWrites
					? {
							level: "partial",
							mechanism:
								"the PreToolUse hook cancels editor/apply_patch outside the worktree; shell writes are not checked",
						}
					: notConfined,
				reads: unrestrictedReads,
				unenforced: confineWrites ? ["shell commands that write outside the worktree"] : [],
			};
		case "copilot": {
			const { unenforced } = buildCopilotDenyTools(context.deniedCommands ?? []);
			return {
				commands: {
					level: unenforced.length > 0 ? "partial" : "native",
					mechanism: "--deny-tool shell(...) (git/gh subcommands and whole programs only)",
				},
				writes: confineWrites
					? {
							level: "partial",
							mechanism:
								"--deny-tool write(<dir>/**) on the main checkout and the project's other worktrees (file tools only; shell writes are not checked, and --allow-all-paths stays because autopilot needs all permissions)",
						}
					: notConfined,
				reads: unrestrictedReads,
				unenforced: [
					...describeUnenforcedRules(unenforced),
					...(confineWrites ? ["shell commands that write outside the worktree"] : []),
				],
			};
		}
		default:
			return {
				commands: { level: "prompt", mechanism: "launch prompt note only (no CLI mechanism verified)" },
				writes: { level: "prompt", mechanism: "launch prompt note only" },
				reads: unrestrictedReads,
				unenforced: ["any of them"],
			};
	}
}
