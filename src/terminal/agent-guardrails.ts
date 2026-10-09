// How each agent CLI enforces a task card's guardrails (src/guardrails/task-guardrails.ts), kept with the other
// per-agent adapter knowledge. Every mechanism below was checked against the installed CLI on 2026-10-07:
//
// - Claude Code (2.1.292): `permissions.deny` in the card's --settings file, plus a PreToolUse hook on Bash that runs
//   `kanban hooks claude-guard` (Kanban's own matcher, as for Cline). Deny rules apply to each subcommand of a
//   compound command, also in auto mode, and `*` matches any text, spaces included; but a rule only matches the
//   command text as written, so `Bash(git push *)` misses `git -C . push`, `git 'push'`, `/usr/bin/git push` and
//   `sh -c 'git push'` (code.claude.com/docs/en/permissions, "What a Bash rule doesn't match"). The rules here also
//   cover git's global options (`git -* push *`) and `{shared}` anywhere after the subcommand; the hook covers the
//   rest the matcher knows (quoting, paths, wrappers, `sh -c`) and a PR card's own-branch push, which globs can't
//   express. A hook's `permissionDecision: "deny"` prevents the tool call in every permission mode, and deny rules
//   still apply whatever the hook says (code.claude.com/docs/en/hooks). `Edit(//<abs>/**)` covers the file tools,
//   the Bash file commands Claude Code recognizes and redirect targets. The user's own autoMode rules apply on top.
// - Codex (0.160): `prefix_rule(..., decision="forbidden")` in `<worktree>/.codex/rules/` (project rules of a
//   trusted project; Kanban pre-trusts the repo). Verified to reject `git push` even with
//   --dangerously-bypass-approvals-and-sandbox. Matching is by argv prefix, so `git -C <dir> push` is not caught,
//   and option slots and `{shared}` are only caught right after the subcommand (each order of them is a rule).
//   A `{shared-dest}` rule (`git fetch . card:main`) can't be a prefix rule without forbidding every fetch: prompt.
//   Writes are confined by `--sandbox workspace-write` (reads stay unrestricted) only where Codex's Linux sandbox
//   runs (bubblewrap with user namespaces; a rootless container usually can't), so it is probed first.
// - Cline CLI (3.x): no deny flag, and tool policies are per tool. Its PreToolUse hook is blocking: `{"cancel":
//   true, "errorMessage"}` stops the tool call before it runs and ends the turn with that reason. Kanban's hook runs
//   `kanban hooks cline-guard`, which checks `run_commands` against the deny list and `editor`/`apply_patch`
//   paths against the writable dirs. Shell commands that write files are not confined.
// - GitHub Copilot CLI (1.0.92): `--deny-tool` wins over --allow-all-tools and doesn't trigger autopilot's
//   blocking "Enable autopilot mode" dialog. `shell(<cmd> <sub>)` matches by command name, plus the first
//   subcommand only for git and gh (`shell(podman restart)` blocks nothing), so a `{shared-dest}` rule is prompt only. `write(<dir>/**)` denies the file
//   tools in a subtree, but not shell writes, and there is no "allow only": deny wins over allow. Confining paths
//   with --add-dir instead of --allow-all-paths would confine reads too, and without all permissions autopilot
//   (0aa75) opens that dialog, which hangs the card. So Copilot keeps --allow-all-paths and denies writes into the
//   main checkout and the project's other worktrees.
// - Gemini, OpenCode, Droid, Kiro: not installed here, so nothing was verified against their CLI: prompt only.
//
// Project isolation (`isolation.mode` `enforce`, src/isolation/) adds, checked against the same CLIs on 2026-10-07:
// - Claude Code: `Read(//<dir>/**)` and `Edit(//<dir>/**)` deny rules on the other projects (Read covers the Read,
//   Grep and Glob tools and the Bash file commands Claude Code recognizes), `Edit` on the machine-wide config, and
//   the Bash guard hook refuses a command that names a denied path (absolute, `~/` or `../` words).
// - Cline CLI: the PreToolUse guard cancels `read_files` (its `files[].path`, a bare string or `file_path`) and
//   `editor`/`apply_patch` into a denied dir, and `run_commands` naming a denied path. `search_codebase` takes
//   only queries and searches the cwd. Cline 3.x runs every card's tools in one hub daemon with the first card's env,
//   so the session credential there is the first card's: the server tells them apart by the caller's cwd.
// - Copilot CLI: `--deny-tool write(<dir>/**)` on the other projects and the machine-wide config (file tools). There
//   is no read kind (`copilot help permissions`: shell, write, url, MCP), and confining paths would drop
//   --allow-all-paths and hang autopilot: reads are prompt only.
// - Codex: no path rules (execpolicy matches argv prefixes, the sandbox can't run in the pod and never limits
//   reads): prompt only. Its shell tool drops env vars matching *KEY*, *SECRET*, *TOKEN* by default
//   (shell_environment_policy), which the session credential's name avoids.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeAgentId } from "../core/api-contract";
import { type DeniedCommandRule, expandSlots } from "../guardrails/command-patterns";
import { isPathInside, listMatcherDeniedCommands, type TaskGuardrails } from "../guardrails/task-guardrails";
import { listIsolationReadDenied, listIsolationWriteDenied } from "../isolation/isolation-paths";

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

/**
 * Whether the agent's command guard is Kanban's own matcher (a PreToolUse hook running command-patterns.ts), so a
 * PR card's `git push {shared-push}` can be enforced. CLI-native deny lists can't tell the target branch.
 */
export function usesKanbanCommandMatcher(agentId: RuntimeAgentId): boolean {
	return agentId === "claude" || agentId === "cline";
}

/**
 * Whether the agent runs every session's tools in one shared process with one env (Cline 3.x's hub daemon), so a
 * session credential in the env can be another session's (src/isolation/isolation-service.ts uses the caller's cwd).
 */
export function sharesProcessEnvAcrossSessions(agentId: RuntimeAgentId): boolean {
	return agentId === "cline";
}

/** Whether a command line is the agent's shared daemon (Cline's hub daemon runs with `--cline-hub-daemon`). */
export function isSharedAgentDaemonCommand(agentId: RuntimeAgentId, command: string): boolean {
	return agentId === "cline" && command.includes("--cline-hub-daemon");
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
		if (rule.sharedDestination || rule.issuesApiWrite) {
			// `shell(git fetch)` would deny every fetch, `shell(gh api)` every API read: Copilot can't look at the
			// arguments.
			unenforced.push(rule);
		} else if (rule.words.length === 1 && program) {
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
	const denies = guardrails.confineWrites ? guardrails.protectedDirs.map((dir) => `write(${dir}/**)`) : [];
	if (guardrails.isolation) {
		// A path may be a file or a dir: deny both forms.
		for (const path of listIsolationWriteDenied(guardrails.isolation)) {
			denies.push(`write(${path})`, `write(${path}/**)`);
		}
	}
	return [...new Set(denies)];
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export const CODEX_GUARDRAIL_RULES_RELATIVE_PATH = ".codex/rules/kanban-guardrails.rules";
/** The first line of the rules file Kanban writes; a file without it is the user's. */
export const CODEX_GUARDRAIL_RULES_MARKER = "kanban-managed: task-card guardrails";

function toStarlarkString(value: string): string {
	return JSON.stringify(value);
}

/** Every order of a rule's floating slots (options, `{shared}`), each after its head slots. */
export function listRuleSlotOrders(rule: DeniedCommandRule): string[][][] {
	const head = rule.words.slice(0, rule.headLength);
	const permute = (slots: string[][]): string[][][] =>
		slots.length <= 1
			? [slots]
			: slots.flatMap((slot, index) =>
					permute([...slots.slice(0, index), ...slots.slice(index + 1)]).map((rest) => [slot, ...rest]),
				);
	return permute(rule.words.slice(rule.headLength)).map((tail) => [...head, ...tail]);
}

/**
 * The execpolicy rules file: one `forbidden` prefix rule per pattern and order of its floating slots (a list
 * position = alternatives). A `{shared-push}` rule forbids every `git push`: an argv prefix can't tell the
 * target branch. A `{shared-dest}` rule is left out: forbidding its prefix would forbid every `git fetch`; so is
 * `gh api {issues-write}` (every `gh api` read).
 */
export function buildCodexRulesFile(rules: readonly DeniedCommandRule[]): string {
	const lines = [
		`# ${CODEX_GUARDRAIL_RULES_MARKER} (guardrails.denyCommands in Kanban's config.json). Rewritten at each launch.`,
	];
	for (const rule of rules.filter((candidate) => !candidate.sharedDestination && !candidate.issuesApiWrite)) {
		for (const slots of listRuleSlotOrders(rule)) {
			// The program position is always a single word: one rule per program.
			const [programs = [], ...rest] = slots;
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
	}
	return `${lines.join("\n")}\n`;
}

/**
 * The tool caches a card's installs and test runs write under the user's home: npm's cache (`npm ci`), the XDG
 * cache (Playwright's browsers, node-gyp, pip, …) and the other package managers' stores.
 */
export function listToolCacheDirs(home = homedir()): string[] {
	if (!home) {
		return [];
	}
	return [".npm", ".cache", ".pnpm-store", ".yarn", ".bun/install/cache"].map((dir) => join(home, dir));
}

/** The --add-dir dirs of Codex's workspace-write sandbox (the cwd, /tmp and $TMPDIR are always writable). */
export function listCodexWritableDirs(guardrails: TaskGuardrails, home = homedir()): string[] {
	const dirs = [
		guardrails.gitCommonDir,
		...guardrails.linkedDirs,
		...guardrails.extraWritableDirs,
		...listToolCacheDirs(home),
	].filter((dir): dir is string => Boolean(dir));
	return [...new Set(dirs)].filter((dir) => !isPathInside(guardrails.worktreePath, dir));
}

const CODEX_SANDBOX_PROBE_TIMEOUT_MS = 15_000;
const CODEX_SANDBOX_TIMEOUT_CACHE_MS = 10 * 60_000;

interface CodexSandboxProbe {
	result: Promise<boolean | null>;
	timeoutMs: number;
	/** Set once the probe timed out: until then the timeout answers callers that would wait no longer. */
	timedOutUntil: number | null;
}

// Probes by binary. A settled answer is kept for the process. A timeout is kept for a short while only: a hanging
// `codex sandbox` must not add the probe time to every Codex launch, and a slow first start must not turn the
// sandbox off for the rest of the process.
const codexSandboxProbes = new Map<string, CodexSandboxProbe>();

export interface CodexSandboxProbeOptions {
	/** How long the probe may run; default 15 s. */
	timeoutMs?: number;
	/** How long a timed-out probe answers "not known" before the next caller probes again; default 10 min. */
	timeoutCacheMs?: number;
	now?: () => number;
}

function isCodexSandboxProbeReusable(probe: CodexSandboxProbe, timeoutMs: number, now: number): boolean {
	return probe.timedOutUntil === null || (now < probe.timedOutUntil && timeoutMs <= probe.timeoutMs);
}

/** Runs `codex sandbox` once: true/false, or null when it timed out. */
async function runCodexSandboxProbe(binary: string, timeoutMs: number): Promise<boolean | null> {
	const dir = await mkdtemp(join(tmpdir(), "kanban-codex-sandbox-"));
	try {
		return await new Promise<boolean | null>((resolvePromise) => {
			const child = spawn(binary, ["sandbox", "-P", ":workspace", "-C", dir, "--", "true"], {
				stdio: "ignore",
			});
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolvePromise(null);
			}, timeoutMs);
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

/**
 * Whether `codex sandbox` ran a command here, or null when the probe timed out. Cached per binary: a settled result
 * for the process, a timeout for `timeoutCacheMs` (and only for callers whose own timeout is no longer).
 */
export async function probeCodexSandboxResult(
	binary = "codex",
	options: CodexSandboxProbeOptions = {},
): Promise<boolean | null> {
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? CODEX_SANDBOX_PROBE_TIMEOUT_MS;
	const cached = codexSandboxProbes.get(binary);
	if (cached && isCodexSandboxProbeReusable(cached, timeoutMs, now())) {
		return await cached.result;
	}
	const probe: CodexSandboxProbe = {
		result: runCodexSandboxProbe(binary, timeoutMs),
		timeoutMs,
		timedOutUntil: null,
	};
	codexSandboxProbes.set(binary, probe);
	void probe.result.then((result) => {
		if (result === null) {
			probe.timedOutUntil = now() + (options.timeoutCacheMs ?? CODEX_SANDBOX_TIMEOUT_CACHE_MS);
		}
	});
	return await probe.result;
}

/** Whether `codex sandbox` can run a command here; a timed-out probe counts as no (the card keeps the bypass). */
export async function probeCodexSandbox(binary = "codex"): Promise<boolean> {
	return (await probeCodexSandboxResult(binary)) === true;
}

/**
 * Whether the agent's OS sandbox runs here, for agents that have one (Codex); null for the others, and when the
 * probe timed out (not known).
 */
export async function probeAgentSandbox(
	agentId: RuntimeAgentId,
	binary: string,
	options: CodexSandboxProbeOptions = {},
): Promise<boolean | null> {
	return agentId === "codex" ? await probeCodexSandboxResult(binary, options) : null;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/** The text a rule's head may start with: as written and, for git, after global options (`git -C <dir> push`). */
function listClaudeCommandPrefixes(head: readonly string[]): string[] {
	const [program, ...rest] = head;
	const plain = head.join(" ");
	return program === "git" && rest.length > 0 ? [plain, `git -* ${rest.join(" ")}`] : [plain];
}

// A `git push` without a target branch, or one that pushes refs it doesn't name (pushMayUpdateSharedBranch).
const CLAUDE_UNNAMED_PUSH_WORDS = ["HEAD", "+HEAD", "@", "+@", ":", "--all", "--branches", "--mirror", "--prune"];

/**
 * The deny rules for a `git push {shared-push}` rule (a PR card's own-branch push): a shared branch as a refspec or
 * as its destination, an unnamed target, and the bare command. A push naming only its remote (`git push origin`)
 * can't be told from one naming a branch, so only the guard hook catches that.
 */
function buildClaudeSharedPushDeny(sharedBranches: readonly string[]): string[] {
	const words = [...CLAUDE_UNNAMED_PUSH_WORDS];
	const destinations: string[] = [];
	for (const name of sharedBranches) {
		for (const ref of [name, `refs/heads/${name}`]) {
			words.push(ref, `+${ref}`);
			destinations.push(ref);
		}
		// Any destination ending in `/<shared>` (git's DWIM takes `card:heads/main` as the remote's main).
		words.push(`*/${name}`);
	}
	const deny: string[] = [];
	for (const prefix of listClaudeCommandPrefixes(["git", "push"])) {
		deny.push(`Bash(${prefix})`);
		for (const word of words) {
			deny.push(`Bash(${prefix}* ${word})`, `Bash(${prefix}* ${word} *)`);
		}
		for (const destination of destinations) {
			deny.push(`Bash(${prefix}*:${destination})`, `Bash(${prefix}*:${destination} *)`);
		}
	}
	return deny;
}

/**
 * The deny rules for a `… {shared-dest}` rule: a refspec whose destination is a shared branch or ends in
 * `/<shared>`. A pattern destination (`refs/heads/*:refs/heads/*`) is left to the guard hook: `*` can't match a
 * literal star.
 */
function buildClaudeSharedDestinationDeny(head: readonly string[], sharedBranches: readonly string[]): string[] {
	const deny: string[] = [];
	for (const prefix of listClaudeCommandPrefixes(head)) {
		for (const name of sharedBranches) {
			for (const destination of [name, `*/${name}`]) {
				deny.push(`Bash(${prefix}*:${destination})`, `Bash(${prefix}*:${destination} *)`);
			}
		}
	}
	return deny;
}

/**
 * The `Bash(...)` deny rules for one rule. `*` matches any text, so `git branch* -D* main` is `git branch`, then
 * ` -D` and ` main` as later words (each order of the floating slots is a rule), and the trailing ` *` form lets
 * anything follow.
 */
export function buildClaudeBashDeny(rule: DeniedCommandRule): string[] {
	if (rule.sharedPush) {
		return buildClaudeSharedPushDeny(rule.sharedPush);
	}
	if (rule.issuesApiWrite) {
		// A Bash(...) rule can't look at the method or endpoint; Kanban's claude-guard hook matches it.
		return [];
	}
	if (rule.sharedDestination) {
		return expandSlots(rule.words).flatMap((head) =>
			buildClaudeSharedDestinationDeny(head, rule.sharedDestination ?? []),
		);
	}
	const deny: string[] = [];
	for (const slots of listRuleSlotOrders(rule)) {
		for (const words of expandSlots(slots)) {
			const tail = words.slice(rule.headLength);
			for (const prefix of listClaudeCommandPrefixes(words.slice(0, rule.headLength))) {
				const command = tail.length > 0 ? `${prefix}${tail.map((word) => `* ${word}`).join("")}` : prefix;
				deny.push(`Bash(${command})`, `Bash(${command} *)`);
			}
		}
	}
	return deny;
}

/** `permissions.deny` entries for a card's --settings file. */
export function buildClaudePermissionDeny(guardrails: TaskGuardrails): string[] {
	const deny: string[] = [];
	for (const rule of listMatcherDeniedCommands(guardrails)) {
		deny.push(...buildClaudeBashDeny(rule));
	}
	if (guardrails.confineWrites) {
		// `//` is an absolute path from the filesystem root in a permission rule.
		deny.push(...guardrails.protectedDirs.map((dir) => `Edit(/${dir}/**)`));
	}
	if (guardrails.isolation) {
		for (const path of listIsolationReadDenied(guardrails.isolation)) {
			deny.push(`Read(/${path})`, `Read(/${path}/**)`);
		}
		for (const path of listIsolationWriteDenied(guardrails.isolation)) {
			deny.push(`Edit(/${path})`, `Edit(/${path}/**)`);
		}
	}
	return [...new Set(deny)];
}

// ---------------------------------------------------------------------------
// Cline CLI
// ---------------------------------------------------------------------------

/** What `kanban hooks claude-guard` gets (base64 JSON on its command line). */
export interface CommandGuardPolicy {
	deniedCommands: DeniedCommandRule[];
	/** Project isolation: a command naming a path inside one of these is refused (findDeniedPathInCommand). */
	deniedPathRoots?: string[];
	/** Project isolation: a command writing inside one of these (machine-wide config) is refused (findProtectedFileWrite). */
	protectedWriteRoots?: string[];
	/** The session's cwd, for relative (`../`) words. */
	cwd?: string;
}

/** What `kanban hooks cline-guard` gets (base64 JSON on its command line). */
export interface ClineGuardPolicy extends CommandGuardPolicy {
	worktreePath: string;
	confineWrites: boolean;
	writableRoots: string[];
	/** Project isolation: no `read_files` inside these. */
	deniedReadRoots?: string[];
	/** Project isolation: no `editor`/`apply_patch` inside these, whatever confineWrites says. */
	deniedWriteRoots?: string[];
}

/** The guard hooks' isolation fields of a launch (empty without isolation). */
export function buildIsolationGuardPolicy(
	guardrails: TaskGuardrails,
): Pick<ClineGuardPolicy, "deniedPathRoots" | "deniedReadRoots" | "deniedWriteRoots" | "protectedWriteRoots" | "cwd"> {
	if (!guardrails.isolation) {
		return {};
	}
	const readDenied = listIsolationReadDenied(guardrails.isolation);
	const writeDenied = listIsolationWriteDenied(guardrails.isolation);
	return {
		cwd: guardrails.worktreePath,
		// A shell command can't be told reading from writing: commands are checked against the other projects only,
		// so reading the machine-wide config stays allowed.
		deniedPathRoots: readDenied,
		// ...and writes to the machine-wide config (config.json, the agents' config) are checked by command form.
		protectedWriteRoots: guardrails.isolation.machineConfigPaths,
		deniedReadRoots: readDenied,
		deniedWriteRoots: writeDenied,
	};
}

// ---------------------------------------------------------------------------
// The report (kanban doctor) and the prompt note
// ---------------------------------------------------------------------------

function describeUnenforcedRules(rules: readonly DeniedCommandRule[]): string[] {
	return rules.length > 0 ? [`commands: ${rules.map((rule) => rule.pattern).join("; ")}`] : [];
}

export type IsolationEnforcement = "native" | "partial" | "prompt-only";

export interface AgentIsolationReport {
	/** The session credential reaching the runtime API and the Kanban CLI. */
	api: { level: GuardrailEnforcement; mechanism: string };
	reads: { level: GuardrailEnforcement; mechanism: string };
	writes: { level: GuardrailEnforcement; mechanism: string };
	/**
	 * The label for doctor, from reads and writes (the runtime API check is the same for every agent): native (both
	 * native), prompt-only (nothing but the launch prompt), else partial.
	 */
	overall: IsolationEnforcement;
	/** What the CLI does not block; the launch prompt says so. */
	unenforced: string[];
}

function overallIsolation(levels: readonly GuardrailEnforcement[]): IsolationEnforcement {
	if (levels.every((level) => level === "native")) {
		return "native";
	}
	return levels.every((level) => level === "prompt" || level === "none") ? "prompt-only" : "partial";
}

/** How the agent's launch enforces project isolation (doctor's rows, the launch prompt's "not blocked" line). */
export function describeAgentIsolation(agentId: RuntimeAgentId): AgentIsolationReport {
	// Partial: the credential holds only from its session's process tree (checked through /proc), and a process that
	// drops it and leaves the tree is the user's for everything but grants (which need the console code).
	const credential = {
		level: "partial" as const,
		mechanism:
			"per-launch session credential (KANBAN_SESSION_CREDENTIAL), valid only from its session's process tree; a call without it is traced to the session's process tree while some workspace is in enforce",
	};
	const build = (
		api: AgentIsolationReport["api"],
		reads: AgentIsolationReport["reads"],
		writes: AgentIsolationReport["writes"],
		unenforced: string[],
	): AgentIsolationReport => ({
		api,
		reads,
		writes,
		overall: overallIsolation([reads.level, writes.level]),
		unenforced,
	});
	switch (agentId) {
		case "claude":
			return build(
				credential,
				{
					level: "partial",
					mechanism:
						"Read deny rules on the other projects (Read, Grep, Glob and recognized Bash file commands) plus the Bash guard hook on commands that name them",
				},
				{
					level: "partial",
					mechanism:
						"Edit deny rules on the other projects and the machine-wide config, plus the Bash guard hook on commands that name them",
				},
				["shell commands that reach other projects without naming their paths"],
			);
		case "cline":
			return build(
				{
					level: "partial",
					mechanism:
						"session credential; Cline's hub daemon shares the first card's env, so a daemon call is the card whose worktree holds the caller's /proc cwd (never the orchestrator)",
				},
				{
					level: "partial",
					mechanism: "the PreToolUse guard cancels read_files and run_commands that name another project",
				},
				{
					level: "partial",
					mechanism:
						"the PreToolUse guard cancels editor/apply_patch into another project or the machine-wide config, and run_commands that name them",
				},
				["shell commands that reach other projects without naming their paths"],
			);
		case "copilot":
			return build(
				credential,
				{ level: "prompt", mechanism: "launch prompt only (Copilot has no read permission kind)" },
				{
					level: "partial",
					mechanism:
						"--deny-tool write(...) on the other projects and the machine-wide config (file tools only; shell writes are not checked)",
				},
				["reads of other projects", "shell commands that write into other projects"],
			);
		case "codex":
			return build(
				credential,
				{ level: "prompt", mechanism: "launch prompt only (no path rules; the sandbox never limits reads)" },
				{ level: "prompt", mechanism: "launch prompt only (no path rules)" },
				["reads and writes of other projects"],
			);
		default:
			return build(
				credential,
				{ level: "prompt", mechanism: "launch prompt only (no CLI mechanism verified)" },
				{ level: "prompt", mechanism: "launch prompt only" },
				["reads and writes of other projects"],
			);
	}
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
				commands: {
					level: "native",
					mechanism:
						"permissions.deny Bash rules in the card's --settings file (also after git's global options, {shared} anywhere after the subcommand) plus Kanban's PreToolUse hook on Bash, which also catches quoted, wrapped and sh -c forms and checks a PR card's own-branch push",
				},
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
					mechanism:
						"execpolicy forbidden rules in .codex/rules (argv prefix: `git -C <dir> push` is not caught, and options or {shared} only right after the subcommand)",
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
										: "workspace-write sandbox when Codex's sandbox runs on the host (not probed, or the probe timed out)",
							},
				reads: unrestrictedReads,
				unenforced: [
					"command forms other than the plain prefix",
					...describeUnenforcedRules(
						(context.deniedCommands ?? []).filter((rule) => rule.sharedDestination || rule.issuesApiWrite),
					),
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
