import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import type {
	RuntimeAgentId,
	RuntimeHookEvent,
	RuntimeTaskAgentSettings,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { buildKanbanCommandParts } from "../core/kanban-command";
import { quoteShellArg } from "../core/shell";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	buildGuardrailPromptNote,
	listGuardrailWritableRoots,
	listMatcherDeniedCommands,
	type TaskGuardrails,
} from "../guardrails/task-guardrails";
import { buildIsolationPromptNote } from "../isolation/isolation-paths";
import { resolveHomeAgentAppendSystemPrompt } from "../prompts/append-system-prompt";
import { CLINE_RULE_FILES } from "../prompts/cline-rules";
import { getClineDataPath } from "../state/kanban-home";
import { getRuntimeHomePath } from "../state/workspace-state";
import { getGitStdout } from "../workspace/git-utils";
import { getClaudeCardSettingsPath } from "../workspace/task-launch-files";
import {
	buildClaudePermissionDeny,
	buildCodexRulesFile,
	buildCopilotDenyTools,
	buildCopilotWriteDenyTools,
	buildIsolationGuardPolicy,
	type ClineGuardPolicy,
	CODEX_GUARDRAIL_RULES_MARKER,
	CODEX_GUARDRAIL_RULES_RELATIVE_PATH,
	type CommandGuardPolicy,
	describeAgentGuardrails,
	describeAgentIsolation,
	listCodexWritableDirs,
	probeCodexSandbox,
	usesKanbanCommandMatcher,
} from "./agent-guardrails";
import { isRuntimeDebugModeEnabled } from "./agent-registry";
import { ensureClaudeWorkspaceTrusted } from "./claude-workspace-trust";
import {
	ensureCardOwnedClineDir,
	KANBAN_HOME_AGENT_CLINE_RULE_FILE,
	KANBAN_MANAGED_CLINE_CLI_HOOK_MARKER,
	KANBAN_MANAGED_CLINE_RULE_MARKER,
} from "./cline-card-dir";
import { CLINE_HOOK_WORKSPACE_ROOT_FLAG } from "./cline-hook-identity";
import { configureCodexHooks, hasCodexConfigOverride } from "./codex-hook-config";
import { ensureCodexWorkspaceTrusted } from "./codex-workspace-trust";
import { createHookRuntimeArgs, createHookRuntimeEnv } from "./hook-runtime-context";
import {
	getOpenCodeAuthPathCandidates,
	getOpenCodeConfigPathCandidates,
	getOpenCodeModelStatePathCandidates,
} from "./opencode-paths";
import { stripAnsi } from "./output-utils";
import type { SessionTransitionEvent } from "./session-state-machine";
import { prepareTaskPromptWithImages } from "./task-image-prompt";
import type { AgentWorkspaceTrustResult } from "./workspace-trust-root";

export interface AgentAdapterLaunchInput {
	taskId: string;
	agentId: RuntimeAgentId;
	binary?: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	agentSettings?: RuntimeTaskAgentSettings;
	/**
	 * The task card's guardrails (src/guardrails/task-guardrails.ts); null/absent for the orchestrator. Each adapter
	 * applies what its CLI enforces (agent-guardrails.ts); prepareAgentLaunch adds a prompt note for the rest.
	 */
	guardrails?: TaskGuardrails | null;
}

export type AgentOutputTransitionDetector = (
	data: string,
	summary: RuntimeTaskSessionSummary,
) => SessionTransitionEvent | null;

export type AgentOutputTransitionInspectionPredicate = (summary: RuntimeTaskSessionSummary) => boolean;

export interface PreparedAgentLaunch {
	binary?: string;
	args: string[];
	env: Record<string, string | undefined>;
	cleanup?: () => Promise<void>;
	deferredStartupInput?: string;
	sessionWarning?: string;
	detectOutputTransition?: AgentOutputTransitionDetector;
	shouldInspectOutputForTransition?: AgentOutputTransitionInspectionPredicate;
}

interface HookContext {
	taskId: string;
	workspaceId: string;
}

interface HookCommandMetadata {
	source?: string;
	activityText?: string;
	hookEventName?: string;
	notificationType?: string;
}

/** How typed input (follow-ups, auto-review prompts, nudges) has to be written into an agent's TUI. */
export interface AgentInputDeliveryProfile {
	/** The TUI ignores input while the terminal is unfocused, so a focus-in escape is written first. */
	focusInBeforeInput: boolean;
}

const DEFAULT_INPUT_DELIVERY_PROFILE: AgentInputDeliveryProfile = {
	focusInBeforeInput: false,
};

/**
 * What recovery (src/pipeline/recovery-stage.ts) may type into an agent's TUI. `clearContextCommand` starts a new
 * conversation in the same TUI (poisoned history: an empty reply or an image the model rejects stays in the history
 * and fails every later request); `cancelTurnInput` cancels a model request in flight (a hung request). Null: the
 * agent can't, so recovery escalates instead.
 */
export interface AgentRecoveryProfile {
	clearContextCommand: string | null;
	cancelTurnInput: string | null;
}

const DEFAULT_RECOVERY_PROFILE: AgentRecoveryProfile = { clearContextCommand: null, cancelTurnInput: null };
const ESCAPE = "\u001b";

/** Where a turn end that the agent's hooks missed can be read from (see cline-turn-monitor.ts). */
export type AgentTurnEndSource = "cline-session-files";

interface AgentSessionAdapter {
	prepare(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch>;
	inputDelivery?: AgentInputDeliveryProfile;
	turnEndSource?: AgentTurnEndSource;
	recovery?: AgentRecoveryProfile;
}

function escapeForTemplateLiteral(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`");
}

function powerShellQuote(value: string): string {
	return `"${value.replaceAll("`", "``").replaceAll('"', '`"')}"`;
}

function resolveHookContext(input: AgentAdapterLaunchInput): HookContext | null {
	const workspaceId = input.workspaceId?.trim();
	if (!workspaceId) {
		return null;
	}
	return {
		taskId: input.taskId,
		workspaceId,
	};
}

function buildHookCommandParts(event: RuntimeHookEvent, metadata?: HookCommandMetadata): string[] {
	const parts = buildHooksCommandParts(["ingest", "--event", event]);
	if (metadata?.source) {
		parts.push("--source", metadata.source);
	}
	if (metadata?.activityText) {
		parts.push("--activity-text", metadata.activityText);
	}
	if (metadata?.hookEventName) {
		parts.push("--hook-event-name", metadata.hookEventName);
	}
	if (metadata?.notificationType) {
		parts.push("--notification-type", metadata.notificationType);
	}
	return parts;
}

function buildHookCommand(event: RuntimeHookEvent, metadata?: HookCommandMetadata): string {
	return buildHookCommandParts(event, metadata).map(quoteShellArg).join(" ");
}

function buildHooksCommandParts(args: string[]): string[] {
	return buildKanbanCommandParts(["hooks", ...args]);
}

function buildHooksCommand(args: string[]): string {
	return buildHooksCommandParts(args).map(quoteShellArg).join(" ");
}

/**
 * The launch's guardrails: a task card's, or the orchestrator's isolation-only ones (role `orchestrator`, project
 * isolation `enforce`). A home-agent session never gets a card's guardrails.
 */
function getSessionGuardrails(input: AgentAdapterLaunchInput): TaskGuardrails | null {
	const guardrails = input.guardrails ?? null;
	if (!guardrails) {
		return null;
	}
	return isHomeAgentSessionId(input.taskId) === (guardrails.role === "orchestrator") ? guardrails : null;
}

/** The orchestrator's appended system prompt, with the isolation section under `enforce`; null for a card. */
function resolveSessionSystemPrompt(input: AgentAdapterLaunchInput): string | null {
	return resolveHomeAgentAppendSystemPrompt(input.taskId, {}, { isolation: input.guardrails?.isolation ?? null });
}

function hasCliOption(args: string[], optionName: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === optionName || arg.startsWith(`${optionName}=`)) {
			return true;
		}
	}
	return false;
}

// Push a card-derived CLI override verbatim unless the user/workspace already
// set one of the equivalent flags. Values are opaque and never normalized.
function applyCliOptionOverride(
	args: string[],
	value: string | undefined,
	flags: readonly [string, ...string[]],
): void {
	if (!value || flags.some((flag) => hasCliOption(args, flag))) {
		return;
	}
	args.push(flags[0], value);
}

function stripCliOptions(args: string[], optionNames: readonly string[]): string[] {
	const stripped: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		const matchedOption = optionNames.find((optionName) => arg === optionName || arg.startsWith(`${optionName}=`));
		if (!matchedOption) {
			stripped.push(arg);
			continue;
		}
		if (arg === matchedOption && i + 1 < args.length && !args[i + 1].startsWith("-")) {
			i += 1;
		}
	}
	return stripped;
}

// ---------------------------------------------------------------------------
// Cline CLI (cline 3.x) runtime hooks.
//
// Hook scripts are discovered by the CLI from `<cwd>/.cline/hooks/` (plus
// user-level dirs) and must be named after the hook event. `--hooks-dir` only
// sets CLINE_HOOKS_DIR, which current CLI builds never read, so the worktree
// hooks directory is the only reliable injection point. Never overwrite a
// user-owned hook file: every Kanban script carries a marker line, and files
// without it are left untouched.
// ---------------------------------------------------------------------------

const CLINE_CLI_HOOK_SOURCE = "cline-cli";

/** `kanban hooks cline-guard` with the card's policy: the worktree, writable dirs (+ Cline's data dir), denies. */
function buildClineGuardCommandParts(guardrails: TaskGuardrails): string[] {
	const policy: ClineGuardPolicy = {
		worktreePath: guardrails.worktreePath,
		confineWrites: guardrails.confineWrites,
		writableRoots: [...listGuardrailWritableRoots(guardrails), getClineDataPath()],
		deniedCommands: listMatcherDeniedCommands(guardrails),
		...buildIsolationGuardPolicy(guardrails),
	};
	return buildHooksCommandParts(["cline-guard", "--policy-base64", encodeGuardPolicy(policy)]);
}

function encodeGuardPolicy(policy: CommandGuardPolicy): string {
	return Buffer.from(JSON.stringify(policy), "utf8").toString("base64");
}
/** Cline's tools that wait on the user (the hooks move the card to Review for them; a pending one is no stall). */
export const CLINE_CLI_ASK_TOOL_PATTERN = "ask_followup_question|ask_question|plan_mode_respond|submit_and_exit";

/** The card a Cline hook script belongs to: its ids and the worktree its session works in (the launch cwd). */
interface ClineHookCard extends HookContext {
	workspaceRoot: string;
}

type ClineCliHookName =
	| "TaskStart"
	| "TaskResume"
	| "TaskCancel"
	| "TaskComplete"
	| "TaskError"
	| "PreToolUse"
	| "PostToolUse"
	| "UserPromptSubmit";

function getClineCliHookScriptPath(hooksDir: string, hookName: ClineCliHookName): string {
	if (process.platform === "win32") {
		return join(hooksDir, `${hookName}.ps1`);
	}
	return join(hooksDir, hookName);
}

// Cline runs these scripts in its shared hub daemon, whose KANBAN_HOOK_* env and cwd are another card's: the command
// names the card and its session's workspace root, which `kanban hooks notify` checks against the payload's.
// Without a card (no workspace id) there is no notify at all: it would fall back to the daemon's env.
function buildClineCliHookCommandParts(
	event: RuntimeHookEvent,
	hookName: ClineCliHookName,
	card: ClineHookCard | null,
): string[] | null {
	if (!card) {
		return null;
	}
	const parts = buildHooksCommandParts(["notify", "--event", event, "--source", CLINE_CLI_HOOK_SOURCE]);
	parts.push("--hook-event-name", hookName);
	parts.push(...createHookRuntimeArgs(card), CLINE_HOOK_WORKSPACE_ROOT_FLAG, card.workspaceRoot);
	if (event === "to_review" && hookName === "TaskComplete") {
		parts.push("--activity-text", "Waiting for review");
	}
	return parts;
}

function buildClineCliHookScriptContent(
	event: RuntimeHookEvent,
	hookName: ClineCliHookName,
	card: ClineHookCard | null,
): string {
	const commandParts = buildClineCliHookCommandParts(event, hookName, card);
	if (process.platform === "win32") {
		const notify = commandParts
			? `try {
  $inputText | & ${commandParts.map(powerShellQuote).join(" ")} | Out-Null
} catch {
}
`
			: "";
		return `# ${KANBAN_MANAGED_CLINE_CLI_HOOK_MARKER} (${hookName})
$inputText = [Console]::In.ReadToEnd()
${notify}Write-Output '{"cancel":false}'
exit 0
`;
	}
	const notify = commandParts
		? `printf '%s' "$INPUT" | ${commandParts.map(quoteShellArg).join(" ")} >/dev/null 2>&1 || true
`
		: "";
	return `#!/usr/bin/env bash
# ${KANBAN_MANAGED_CLINE_CLI_HOOK_MARKER} (${hookName})
INPUT="$(cat || true)"
${notify}echo '{"cancel":false}'
`;
}

// With a guard, the hook prints the guard's decision instead of `{"cancel":false}`: `{"cancel":true}` stops the
// tool call before it runs (cline-guard.ts).
function buildClineCliPreToolUseHookScriptContent(card: ClineHookCard | null, guardCommand?: string[]): string {
	const activityCommand = buildClineCliHookCommandParts("activity", "PreToolUse", card);
	const reviewCommand = buildClineCliHookCommandParts("to_review", "PreToolUse", card);
	const inProgressCommand = buildClineCliHookCommandParts("to_in_progress", "PreToolUse", card);
	const hasNotify = activityCommand && reviewCommand && inProgressCommand;
	if (process.platform === "win32") {
		const guard = guardCommand
			? `try {
  $guardOutput = ($inputText | & ${guardCommand.map(powerShellQuote).join(" ")}) -join ""
  if ($guardOutput) { $decision = $guardOutput }
} catch {
}
`
			: "";
		const notify = hasNotify
			? `$isUserQuestionTool = $inputText -match '"(toolName|tool)"\\s*:\\s*"(${CLINE_CLI_ASK_TOOL_PATTERN})"'
try {
  $inputText | & ${activityCommand.map(powerShellQuote).join(" ")} | Out-Null
} catch {
}
if ($isUserQuestionTool) {
  try {
    $inputText | & ${reviewCommand.map(powerShellQuote).join(" ")} | Out-Null
  } catch {
  }
} else {
  try {
    $inputText | & ${inProgressCommand.map(powerShellQuote).join(" ")} | Out-Null
  } catch {
  }
}
`
			: "";
		return `# ${KANBAN_MANAGED_CLINE_CLI_HOOK_MARKER} (PreToolUse)
$inputText = [Console]::In.ReadToEnd()
$decision = '{"cancel":false}'
${guard}${notify}Write-Output $decision
exit 0
`;
	}
	const guard = guardCommand
		? `GUARD="$(printf '%s' "$INPUT" | ${guardCommand.map(quoteShellArg).join(" ")} 2>/dev/null || true)"
if [ -n "$GUARD" ]; then DECISION="$GUARD"; fi
`
		: "";
	const notify = hasNotify
		? `printf '%s' "$INPUT" | ${activityCommand.map(quoteShellArg).join(" ")} >/dev/null 2>&1 || true
if printf '%s' "$INPUT" | grep -Eq '"(toolName|tool)"[[:space:]]*:[[:space:]]*"(${CLINE_CLI_ASK_TOOL_PATTERN})"'; then
  printf '%s' "$INPUT" | ${reviewCommand.map(quoteShellArg).join(" ")} >/dev/null 2>&1 || true
else
  printf '%s' "$INPUT" | ${inProgressCommand.map(quoteShellArg).join(" ")} >/dev/null 2>&1 || true
fi
`
		: "";
	return `#!/usr/bin/env bash
# ${KANBAN_MANAGED_CLINE_CLI_HOOK_MARKER} (PreToolUse)
INPUT="$(cat || true)"
DECISION='{"cancel":false}'
${guard}${notify}printf '%s\\n' "$DECISION"
`;
}

function buildClineCliPostToolUseHookScriptContent(card: ClineHookCard | null): string {
	const activityCommand = buildClineCliHookCommandParts("activity", "PostToolUse", card);
	const inProgressCommand = buildClineCliHookCommandParts("to_in_progress", "PostToolUse", card);
	const hasNotify = activityCommand && inProgressCommand;
	if (process.platform === "win32") {
		const notify = hasNotify
			? `$isUserQuestionTool = $inputText -match '"(toolName|tool)"\\s*:\\s*"(${CLINE_CLI_ASK_TOOL_PATTERN})"'
try {
  $inputText | & ${activityCommand.map(powerShellQuote).join(" ")} | Out-Null
} catch {
}
if ($isUserQuestionTool) {
  try {
    $inputText | & ${inProgressCommand.map(powerShellQuote).join(" ")} | Out-Null
  } catch {
  }
}
`
			: "";
		return `# ${KANBAN_MANAGED_CLINE_CLI_HOOK_MARKER} (PostToolUse)
$inputText = [Console]::In.ReadToEnd()
${notify}Write-Output '{"cancel":false}'
exit 0
`;
	}
	const notify = hasNotify
		? `printf '%s' "$INPUT" | ${activityCommand.map(quoteShellArg).join(" ")} >/dev/null 2>&1 || true
if printf '%s' "$INPUT" | grep -Eq '"(toolName|tool)"[[:space:]]*:[[:space:]]*"(${CLINE_CLI_ASK_TOOL_PATTERN})"'; then
  printf '%s' "$INPUT" | ${inProgressCommand.map(quoteShellArg).join(" ")} >/dev/null 2>&1 || true
fi
`
		: "";
	return `#!/usr/bin/env bash
# ${KANBAN_MANAGED_CLINE_CLI_HOOK_MARKER} (PostToolUse)
INPUT="$(cat || true)"
${notify}echo '{"cancel":false}'
`;
}

// Returns false when a user-owned hook file already exists at the path; Kanban
// never clobbers non-Kanban hook scripts in the shared `.cline/hooks` folder.
async function ensureKanbanManagedHookFile(filePath: string, content: string, executable: boolean): Promise<boolean> {
	const existing = await readFile(filePath, "utf8").catch(() => null);
	if (existing !== null && !existing.includes(KANBAN_MANAGED_CLINE_CLI_HOOK_MARKER)) {
		return false;
	}
	await ensureTextFile(filePath, content, executable);
	return true;
}

/** Cline's env for every launch: no ClinePass/Desktop promo notice over the TUI (cline 3.0.69 reads it per run). */
const CLINE_LAUNCH_ENV: Readonly<Record<string, string>> = { CLINE_DISABLE_CLINE_PASS_NOTICE: "1" };

/**
 * Writes Kanban's Cline rules (src/prompts/cline-rules.ts) as workspace rules: cline 3.x loads `<cwd>/.cline/rules/*`
 * into the task, so they no longer go into Cline's global ~/.cline/rules. Git-excluded so they never ship with the
 * card's work; a user-owned file of the same name (no marker) is left alone. Returns the names it skipped.
 */
async function installClineLaunchRules(cwd: string): Promise<string[]> {
	const skipped: string[] = [];
	for (const [name, content] of Object.entries(CLINE_RULE_FILES)) {
		const rulePath = join(cwd, ".cline", "rules", `kanban-${name}`);
		const existing = await readFile(rulePath, "utf8").catch(() => null);
		if (existing !== null && existing.split("\n", 1)[0] !== KANBAN_MANAGED_CLINE_RULE_MARKER) {
			skipped.push(name);
			continue;
		}
		await ensureTextFile(rulePath, `${KANBAN_MANAGED_CLINE_RULE_MARKER}\n${content}`);
		await addToWorktreeGitExclude(cwd, `/${relative(cwd, rulePath).split("\\").join("/")}`);
	}
	return skipped;
}

function buildOpenCodePluginContent(
	reviewCommand: string,
	toInProgressCommand: string,
	activityCommand: string,
): string {
	const reviewCmd = escapeForTemplateLiteral(reviewCommand);
	const toInProgressCmd = escapeForTemplateLiteral(toInProgressCommand);
	const activityCmd = escapeForTemplateLiteral(activityCommand);
	return `export const KanbanPlugin = async ({ $, client }) => {
  if (globalThis.__kanbanOpencodePluginV3) return {};
  globalThis.__kanbanOpencodePluginV3 = true;

  if (!process?.env?.KANBAN_HOOK_TASK_ID) return {};

  let currentState = "idle";
  let rootSessionID = null;
  const childSessionCache = new Map();
  const messageRoleByID = new Map();
  const assistantTextByMessageID = new Map();
  const latestAssistantBySessionID = new Map();
  const toolInputByCallID = new Map();

  const asRecord = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value;
  };

  const getMessageKey = (sessionID, messageID) => String(sessionID) + ":" + String(messageID);
  const getToolCallKey = (sessionID, callID) => String(sessionID) + ":" + String(callID);

  const encodePayload = (payload) => {
    if (!payload || typeof payload !== "object") {
      return "";
    }
    try {
      return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    } catch {
      return "";
    }
  };

	const notify = async (kind, payload) => {
		try {
			const encoded = encodePayload(payload);
			if (kind === "review") {
				if (encoded) {
					await $\`${reviewCmd} --metadata-base64 \${encoded}\`;
				} else {
					await $\`${reviewCmd}\`;
				}
				return;
			}
			if (kind === "in_progress") {
				if (encoded) {
					await $\`${toInProgressCmd} --metadata-base64 \${encoded}\`;
				} else {
					await $\`${toInProgressCmd}\`;
				}
				return;
			}
			if (encoded) {
				await $\`${activityCmd} --metadata-base64 \${encoded}\`;
			} else {
				await $\`${activityCmd}\`;
			}
		} catch {
			// Best effort: hook errors should never break OpenCode event handling.
		}
	};

  const notifyReview = async (sessionID, payload = {}) => {
    const mergedPayload = {
      ...payload,
      last_assistant_message:
        typeof payload.last_assistant_message === "string"
          ? payload.last_assistant_message
          : (latestAssistantBySessionID.get(sessionID) ?? undefined),
    };
		await notify("review", mergedPayload);
  };

  const notifyInProgress = async (payload = {}) => {
		await notify("in_progress", payload);
  };

  const notifyActivity = async (payload = {}) => {
		await notify("activity", payload);
  };

  const isChildSession = async (sessionID) => {
    if (!sessionID) return true;
    if (!client?.session?.list) return true;
    if (childSessionCache.has(sessionID)) {
      return childSessionCache.get(sessionID);
    }
    try {
      const sessions = await client.session.list();
      const session = sessions.data?.find((candidate) => candidate.id === sessionID);
      const isChild = !!session?.parentID;
      childSessionCache.set(sessionID, isChild);
      return isChild;
    } catch {
      return true;
    }
  };

  const handleBusy = async (sessionID) => {
    if (!sessionID) {
      return;
    }
    if (!rootSessionID) {
      rootSessionID = sessionID;
    }
    if (sessionID !== rootSessionID) {
      return;
    }
    if (currentState === "idle") {
      currentState = "busy";
      await notifyInProgress({
        hook_event_name: "session.status",
      });
    }
  };

  const handleReview = async (sessionID, payload = {}, force = false) => {
    if (!sessionID) {
      return;
    }
    if (!rootSessionID) {
      rootSessionID = sessionID;
    }
    if (rootSessionID && sessionID !== rootSessionID) {
      return;
    }

    const shouldNotify = force || currentState === "busy";
    if (shouldNotify) {
      currentState = "idle";
      await notifyReview(sessionID, payload);
      rootSessionID = null;
    }
  };

  return {
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = asRecord(event.properties?.info);
        const sessionID = typeof info?.sessionID === "string" ? info.sessionID : null;
        if (await isChildSession(sessionID)) {
          return;
        }

        const messageID = typeof info?.id === "string" ? info.id : null;
        const role = typeof info?.role === "string" ? info.role : null;
        if (messageID && role) {
          messageRoleByID.set(getMessageKey(sessionID, messageID), role);
          if (role === "assistant" && !assistantTextByMessageID.has(getMessageKey(sessionID, messageID))) {
            assistantTextByMessageID.set(getMessageKey(sessionID, messageID), "");
          }
        }
        return;
      }

      if (event.type === "message.part.updated") {
        const part = asRecord(event.properties?.part);
        if (!part) {
          return;
        }

        const sessionID = typeof part.sessionID === "string" ? part.sessionID : null;
        if (await isChildSession(sessionID)) {
          return;
        }

        if (part.type !== "text") {
          return;
        }

        const messageID = typeof part.messageID === "string" ? part.messageID : null;
        if (!messageID) {
          return;
        }

        const messageKey = getMessageKey(sessionID, messageID);
        if (messageRoleByID.get(messageKey) !== "assistant") {
          return;
        }

        const delta = typeof event.properties?.delta === "string" ? event.properties.delta : "";
        const fullText = typeof part.text === "string" ? part.text : "";
        const previousText = assistantTextByMessageID.get(messageKey) ?? "";
        const nextText = delta ? previousText + delta : (fullText || previousText);
        const normalized = nextText.trim();
        if (!normalized) {
          return;
        }

        assistantTextByMessageID.set(messageKey, normalized);
        latestAssistantBySessionID.set(sessionID, normalized);
        return;
      }

      const sessionID = event.properties?.sessionID;
      if (await isChildSession(sessionID)) {
        return;
      }

      if (event.type === "session.status") {
        const status = event.properties?.status;
        if (status?.type === "busy") {
          await handleBusy(sessionID);
        } else if (status?.type === "idle") {
          await handleReview(sessionID, {
            hook_event_name: "session.status",
          });
        }
      }

      if (event.type === "session.busy") {
        await handleBusy(sessionID);
      }
      if (event.type === "session.idle") {
        await handleReview(sessionID, {
          hook_event_name: "session.idle",
        });
      }
      if (event.type === "session.error") {
        await handleReview(
          sessionID,
          {
            hook_event_name: "session.error",
          },
          true,
        );
      }
    },
    "tool.execute.before": async (input, output) => {
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : null;
      if (await isChildSession(sessionID)) {
        return;
      }

      await handleBusy(sessionID);

      const toolName = typeof input?.tool === "string" ? input.tool : undefined;
      const callID = typeof input?.callID === "string" ? input.callID : "";
      const toolInput = asRecord(output?.args);
      if (callID) {
        toolInputByCallID.set(getToolCallKey(sessionID, callID), toolInput);
      }

      await notifyActivity({
        hook_event_name: "BeforeTool",
        tool_name: toolName,
        tool_input: toolInput ?? undefined,
      });
    },
    "tool.execute.after": async (input) => {
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : null;
      if (await isChildSession(sessionID)) {
        return;
      }

      const toolName = typeof input?.tool === "string" ? input.tool : undefined;
      const callID = typeof input?.callID === "string" ? input.callID : "";
      const toolInput = callID ? toolInputByCallID.get(getToolCallKey(sessionID, callID)) : null;
      if (callID) {
        toolInputByCallID.delete(getToolCallKey(sessionID, callID));
      }

      await notifyActivity({
        hook_event_name: "AfterTool",
        tool_name: toolName,
        tool_input: toolInput ?? undefined,
      });
    },
    "permission.ask": async (_permission, output) => {
      if (output?.status === "ask") {
        const sessionID = typeof _permission?.sessionID === "string" ? _permission.sessionID : null;
        if (await isChildSession(sessionID)) {
          return;
        }
        await handleReview(
          sessionID,
          {
            hook_event_name: "PermissionRequest",
            notification_type: "permission.asked",
          },
          true,
        );
      }
    },
  };
};
`;
}

function getHookAgentDirectory(agentId: RuntimeAgentId): string {
	return join(getRuntimeHomePath(), "hooks", agentId);
}

const KIRO_KANBAN_AGENT_NAME = "kanban";

function getKiroAgentConfigPath(): string {
	return join(homedir(), ".kiro", "agents", `${KIRO_KANBAN_AGENT_NAME}.json`);
}

async function ensureTextFile(filePath: string, content: string, executable = false): Promise<void> {
	await lockedFileSystem.writeTextFileAtomic(filePath, content, {
		executable,
	});
}

function withPrompt(args: string[], prompt: string, mode: "append" | "flag", flag?: string): PreparedAgentLaunch {
	const trimmed = prompt.trim();
	if (!trimmed) {
		return {
			args,
			env: {},
		};
	}
	if (mode === "flag" && flag) {
		args.push(flag, trimmed);
	} else {
		args.push(trimmed);
	}
	return {
		args,
		env: {},
	};
}

function toBracketedPasteSubmission(command: string): string {
	return `\u001b[200~${command}\u001b[201~\r`;
}

function logWorkspacePreTrustError(agentId: "claude" | "codex", result: AgentWorkspaceTrustResult): void {
	if (result.error && isRuntimeDebugModeEnabled()) {
		process.stderr.write(
			`[kanban] ${agentId} workspace pre-trust skipped for ${result.trustRootPath}: ${result.error}\n`,
		);
	}
}

const claudeAdapter: AgentSessionAdapter = {
	recovery: { clearContextCommand: "/clear", cancelTurnInput: ESCAPE },
	async prepare(input) {
		// Pre-trust the main repo so Claude Code skips its folder trust dialog (best effort; the
		// session manager still answers the dialog if it shows).
		logWorkspacePreTrustError("claude", await ensureClaudeWorkspaceTrusted(input.cwd));
		const args = [...input.args];
		const env: Record<string, string | undefined> = {
			FORCE_HYPERLINK: "1",
		};
		const appendedSystemPrompt = resolveSessionSystemPrompt(input);
		if (input.autonomousModeEnabled) {
			// Auto mode is gated behind this env var on Bedrock/Vertex/Foundry; the Anthropic API ignores it.
			env.CLAUDE_CODE_ENABLE_AUTO_MODE = "1";
		}
		if (
			input.autonomousModeEnabled &&
			!input.startInPlanMode &&
			!hasCliOption(args, "--permission-mode") &&
			!hasCliOption(args, "--dangerously-skip-permissions")
		) {
			args.push("--permission-mode", "auto");
		}
		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}
		if (input.startInPlanMode) {
			const withoutImmediateBypass = args.filter((arg) => arg !== "--dangerously-skip-permissions");
			args.length = 0;
			args.push(...withoutImmediateBypass);
			args.push("--permission-mode", "plan");
		}

		const hooks = resolveHookContext(input);
		const guardrails = getSessionGuardrails(input);
		if (hooks || guardrails) {
			// A session with guardrails gets its own file: the shared one is every unguarded session's.
			const settingsPath = guardrails
				? getClaudeCardSettingsPath(input.taskId)
				: join(getHookAgentDirectory("claude"), "settings.json");
			// Kanban's matcher on every Bash call (agent-guardrails.ts): the deny rules only match the command as written.
			const guardPolicy: CommandGuardPolicy | null = guardrails && {
				deniedCommands: listMatcherDeniedCommands(guardrails),
				...buildIsolationGuardPolicy(guardrails),
			};
			const guardHook = guardPolicy &&
				(guardPolicy.deniedCommands.length > 0 ||
					(guardPolicy.deniedPathRoots ?? []).length > 0 ||
					(guardPolicy.protectedWriteRoots ?? []).length > 0) && {
					matcher: "Bash",
					hooks: [
						{
							type: "command",
							command: buildHooksCommand(["claude-guard", "--policy-base64", encodeGuardPolicy(guardPolicy)]),
						},
					],
				};
			const claudeHooks = hooks && {
				Stop: [{ hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }] }],
				SubagentStop: [
					{ hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }] },
				],
				PreToolUse: [
					{
						matcher: "*",
						hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
					},
				],
				PermissionRequest: [
					{
						matcher: "*",
						hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
					},
				],
				PostToolUse: [
					{
						matcher: "*",
						hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
					},
				],
				PostToolUseFailure: [
					{
						matcher: "*",
						hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
					},
				],
				Notification: [
					{
						matcher: "permission_prompt",
						hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
					},
					{
						matcher: "*",
						hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
					},
				],
				UserPromptSubmit: [
					{
						hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
					},
				],
			};
			const settingsHooks = guardHook
				? { ...claudeHooks, PreToolUse: [guardHook, ...(claudeHooks ? claudeHooks.PreToolUse : [])] }
				: claudeHooks;
			const settings = {
				...(settingsHooks ? { hooks: settingsHooks } : {}),
				...(guardrails ? { permissions: { deny: buildClaudePermissionDeny(guardrails) } } : {}),
			};
			await ensureTextFile(settingsPath, JSON.stringify(settings, null, 2));
			args.push("--settings", settingsPath);
			if (hooks) {
				Object.assign(
					env,
					createHookRuntimeEnv({
						taskId: hooks.taskId,
						workspaceId: hooks.workspaceId,
					}),
				);
			}
		}

		if (
			appendedSystemPrompt &&
			!hasCliOption(args, "--append-system-prompt") &&
			!hasCliOption(args, "--system-prompt")
		) {
			args.push("--append-system-prompt", appendedSystemPrompt);
		}

		// Per-task model/effort overrides, passed verbatim. User/workspace args win.
		// Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
		applyCliOptionOverride(args, input.agentSettings?.modelId, ["--model"]);
		applyCliOptionOverride(args, input.agentSettings?.reasoningEffort, ["--effort"]);

		const withPromptLaunch = withPrompt(args, input.prompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

function codexPromptDetector(data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null {
	if (summary.state !== "awaiting_review") {
		return null;
	}
	if (summary.reviewReason !== "attention" && summary.reviewReason !== "hook") {
		return null;
	}
	const stripped = stripAnsi(data);
	if (/(?:^|\n)\s*›/.test(stripped)) {
		return { type: "agent.prompt-ready" };
	}
	return null;
}

function shouldInspectCodexOutputForTransition(summary: RuntimeTaskSessionSummary): boolean {
	return (
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error")
	);
}

const CODEX_SANDBOX_FLAGS = [
	"--dangerously-bypass-approvals-and-sandbox",
	"--sandbox",
	"-s",
	"--ask-for-approval",
	"-a",
	"--full-auto",
] as const;

/**
 * Whether an autonomous Codex card runs in the workspace-write sandbox instead of the bypass: only when writes are
 * confined, the user/workspace args chose no sandbox or approval mode, and Codex's sandbox runs on this host.
 */
async function shouldConfineCodexWrites(input: AgentAdapterLaunchInput, guardrails: TaskGuardrails): Promise<boolean> {
	if (!input.autonomousModeEnabled || !guardrails.confineWrites) {
		return false;
	}
	if (CODEX_SANDBOX_FLAGS.some((flag) => hasCliOption(input.args, flag))) {
		return false;
	}
	return await probeCodexSandbox(input.binary);
}

const codexAdapter: AgentSessionAdapter = {
	recovery: { clearContextCommand: "/new", cancelTurnInput: ESCAPE },
	async prepare(input) {
		logWorkspacePreTrustError("codex", await ensureCodexWorkspaceTrusted(input.cwd));
		const codexArgs = [...input.args];
		const env: Record<string, string | undefined> = {};
		const binary = input.binary;
		let deferredStartupInput: string | undefined;
		const appendedSystemPrompt = resolveSessionSystemPrompt(input);

		if (!hasCodexConfigOverride(codexArgs, "check_for_update_on_startup")) {
			codexArgs.push("-c", "check_for_update_on_startup=false");
		}

		const guardrails = getSessionGuardrails(input);
		if (guardrails && guardrails.role === "card") {
			// Forbidden prefix rules hold even with --dangerously-bypass-approvals-and-sandbox (agent-guardrails.ts).
			await ensureTextFile(
				join(input.cwd, ...CODEX_GUARDRAIL_RULES_RELATIVE_PATH.split("/")),
				buildCodexRulesFile(guardrails.deniedCommands),
			);
			await addToWorktreeGitExclude(input.cwd, `/${CODEX_GUARDRAIL_RULES_RELATIVE_PATH}`);
		} else {
			// Guardrails off (or the orchestrator, which has no command denies): a rules file an earlier launch wrote
			// would still forbid commands.
			await removeKanbanManagedFile(
				join(input.cwd, ...CODEX_GUARDRAIL_RULES_RELATIVE_PATH.split("/")),
				CODEX_GUARDRAIL_RULES_MARKER,
			);
		}

		if (guardrails && (await shouldConfineCodexWrites(input, guardrails))) {
			// Writes confined to the worktree, its git dir and the shared dirs; reads and the network stay open
			// (fetch and rebase onto the base branch need both).
			codexArgs.push("--sandbox", "workspace-write", "--ask-for-approval", "never");
			codexArgs.push("-c", "sandbox_workspace_write.network_access=true");
			for (const dir of listCodexWritableDirs(guardrails)) {
				codexArgs.push("--add-dir", dir);
			}
		} else if (
			input.autonomousModeEnabled &&
			!hasCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox")
		) {
			codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
		}

		if (input.resumeFromTrash) {
			if (!codexArgs.includes("resume")) {
				codexArgs.push("resume");
			}
			if (!hasCliOption(codexArgs, "--last")) {
				codexArgs.push("--last");
			}
		}

		if (appendedSystemPrompt && !hasCodexConfigOverride(codexArgs, "developer_instructions")) {
			codexArgs.push("-c", `developer_instructions=${JSON.stringify(appendedSystemPrompt)}`);
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			configureCodexHooks(codexArgs);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		// Per-task model/effort overrides, passed verbatim. User/workspace args win.
		// Codex CLI reference: https://developers.openai.com/codex/cli/reference
		applyCliOptionOverride(codexArgs, input.agentSettings?.modelId, ["-m", "--model"]);
		if (input.agentSettings?.reasoningEffort && !hasCodexConfigOverride(codexArgs, "model_reasoning_effort")) {
			codexArgs.push("-c", `model_reasoning_effort=${input.agentSettings.reasoningEffort}`);
		}

		const trimmed = input.prompt.trim();
		if (input.startInPlanMode) {
			const planCommand = trimmed ? `/plan ${trimmed}` : "/plan";
			deferredStartupInput = toBracketedPasteSubmission(planCommand);
		} else if (trimmed) {
			codexArgs.push(trimmed);
		}

		if (hooks) {
			return {
				binary,
				args: codexArgs,
				env,
				deferredStartupInput,
				detectOutputTransition: codexPromptDetector,
				shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
			};
		}

		return {
			binary,
			args: codexArgs,
			env,
			deferredStartupInput,
			detectOutputTransition: codexPromptDetector,
			shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
		};
	},
};

const geminiAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.autonomousModeEnabled && !hasCliOption(args, "--yolo")) {
			args.push("--yolo");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--resume")) {
			args.push("--resume", "latest");
		}

		if (input.startInPlanMode) {
			args.push("--approval-mode=plan");
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const configPath = join(getHookAgentDirectory("gemini"), "settings.json");
			const geminiHookCommand = buildHooksCommand(["gemini-hook"]);

			const config = {
				hooks: {
					BeforeTool: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					AfterTool: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					AfterAgent: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					BeforeAgent: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					Notification: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
				},
			};
			await ensureTextFile(configPath, JSON.stringify(config, null, 2));
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
			env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = configPath;
		}

		// Per-task model override, passed verbatim. User/workspace args win. Gemini CLI has no
		// launch-time reasoning-effort flag. Reference:
		// https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md
		applyCliOptionOverride(args, input.agentSettings?.modelId, ["-m", "--model"]);

		const trimmed = input.prompt.trim();
		if (trimmed) {
			args.push("-i", trimmed);
			return {
				args,
				env,
			};
		}

		return {
			args,
			env,
		};
	},
};

async function resolveOpenCodeBaseConfigPath(explicitPath: string | undefined): Promise<string | null> {
	const candidates = getOpenCodeConfigPathCandidates({ explicitPath });
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Keep searching.
		}
	}
	return null;
}

function hasOpenCodeModelArg(args: string[]): boolean {
	for (const arg of args) {
		if (arg === "--model" || arg === "-m") {
			return true;
		}
		if (arg.startsWith("--model=") || arg.startsWith("-m=")) {
			return true;
		}
	}
	return false;
}

function hasOpenCodeAgentArg(args: string[]): boolean {
	for (const arg of args) {
		if (arg === "--agent") {
			return true;
		}
		if (arg.startsWith("--agent=")) {
			return true;
		}
	}
	return false;
}

function normalizeOpenCodeModel(providerId: string, modelId: string): string {
	if (modelId.startsWith(`${providerId}/`)) {
		return modelId;
	}
	return `${providerId}/${modelId}`;
}

function stripJsonComments(input: string): string {
	let output = "";
	let inString = false;
	let escaped = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < input.length; i += 1) {
		const current = input[i];
		const next = i + 1 < input.length ? input[i + 1] : "";

		if (inLineComment) {
			if (current === "\n") {
				inLineComment = false;
				output += current;
			}
			continue;
		}
		if (inBlockComment) {
			if (current === "*" && next === "/") {
				inBlockComment = false;
				i += 1;
			}
			continue;
		}
		if (!inString && current === "/" && next === "/") {
			inLineComment = true;
			i += 1;
			continue;
		}
		if (!inString && current === "/" && next === "*") {
			inBlockComment = true;
			i += 1;
			continue;
		}

		output += current;
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (current === "\\") {
				escaped = true;
			} else if (current === '"') {
				inString = false;
			}
			continue;
		}
		if (current === '"') {
			inString = true;
		}
	}
	return output;
}

function tryExtractOpenCodeModelFromConfig(rawConfig: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawConfig);
	} catch {
		try {
			parsed = JSON.parse(stripJsonComments(rawConfig));
		} catch {
			return null;
		}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const root = parsed as Record<string, unknown>;

	const directModel = root.model;
	if (typeof directModel === "string" && directModel.trim()) {
		return directModel.trim();
	}

	const mode = root.mode;
	if (mode && typeof mode === "object" && !Array.isArray(mode)) {
		const build = (mode as Record<string, unknown>).build;
		if (build && typeof build === "object" && !Array.isArray(build)) {
			const model = (build as Record<string, unknown>).model;
			if (typeof model === "string" && model.trim()) {
				return model.trim();
			}
		}
	}

	const agent = root.agent;
	if (agent && typeof agent === "object" && !Array.isArray(agent)) {
		const build = (agent as Record<string, unknown>).build;
		if (build && typeof build === "object" && !Array.isArray(build)) {
			const model = (build as Record<string, unknown>).model;
			if (typeof model === "string" && model.trim()) {
				return model.trim();
			}
		}
	}

	return null;
}

async function resolveOpenCodePreferredModelArg(configPath: string | null): Promise<string | null> {
	if (configPath) {
		try {
			const rawConfig = await readFile(configPath, "utf8");
			const modelFromConfig = tryExtractOpenCodeModelFromConfig(rawConfig);
			if (modelFromConfig) {
				return modelFromConfig;
			}
		} catch {
			// Fall through to state-based fallback.
		}
	}

	const modelStateCandidates = getOpenCodeModelStatePathCandidates();
	let recentModels: Array<{ providerID?: unknown; modelID?: unknown }> = [];
	for (const modelStatePath of modelStateCandidates) {
		try {
			const raw = await readFile(modelStatePath, "utf8");
			const parsed = JSON.parse(raw) as { recent?: Array<{ providerID?: unknown; modelID?: unknown }> };
			if (Array.isArray(parsed.recent)) {
				recentModels = parsed.recent;
				break;
			}
		} catch {
			// Keep searching through candidate state paths.
		}
	}
	if (recentModels.length === 0) {
		return null;
	}

	const configuredProviders = new Set<string>();
	for (const authPath of getOpenCodeAuthPathCandidates()) {
		try {
			const raw = await readFile(authPath, "utf8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			for (const [provider, value] of Object.entries(parsed)) {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					continue;
				}
				const key = (value as Record<string, unknown>).key;
				if (typeof key === "string" && key.trim()) {
					configuredProviders.add(provider);
				}
			}
			break;
		} catch {
			// Keep searching through candidate auth paths.
		}
	}

	const candidates: Array<{ providerId: string; model: string }> = [];
	for (const entry of recentModels) {
		const providerId = typeof entry.providerID === "string" ? entry.providerID.trim() : "";
		const modelId = typeof entry.modelID === "string" ? entry.modelID.trim() : "";
		if (!providerId || !modelId) {
			continue;
		}
		candidates.push({ providerId, model: normalizeOpenCodeModel(providerId, modelId) });
	}
	if (candidates.length === 0) {
		return null;
	}

	const preferredProviderOrder = ["openrouter", "anthropic", "openai", "opencode", "google", "amazon-bedrock"];
	for (const providerId of preferredProviderOrder) {
		const match = candidates.find((candidate) => candidate.providerId === providerId);
		if (!match) {
			continue;
		}
		if (configuredProviders.size === 0 || configuredProviders.has(providerId)) {
			return match.model;
		}
	}

	const configuredMatch = candidates.find((candidate) => configuredProviders.has(candidate.providerId));
	if (configuredMatch) {
		return configuredMatch.model;
	}

	return candidates[0].model;
}

const opencodeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};
		const baseConfigPath = await resolveOpenCodeBaseConfigPath(input.env?.OPENCODE_CONFIG);
		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}

		if (input.startInPlanMode) {
			env.OPENCODE_EXPERIMENTAL_PLAN_MODE = "true";
			if (!hasOpenCodeAgentArg(args)) {
				args.push("--agent", "plan");
			}
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const pluginPath = join(getHookAgentDirectory("opencode"), "kanban.js");
			const configPath = join(getHookAgentDirectory("opencode"), "opencode.json");

			const pluginContent = buildOpenCodePluginContent(
				buildHookCommand("to_review", { source: "opencode" }),
				buildHookCommand("to_in_progress", { source: "opencode" }),
				buildHookCommand("activity", { source: "opencode" }),
			);
			await ensureTextFile(pluginPath, pluginContent);
			const pluginFileUrl = pathToFileURL(pluginPath).href;
			const config = {
				plugin: [pluginFileUrl],
			};
			await ensureTextFile(configPath, JSON.stringify(config));
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
			env.OPENCODE_CONFIG = configPath;
		}

		// Workaround: with --prompt, OpenCode can pick an unexpected provider/model.
		// Per-task model overrides win; otherwise explicitly pass the user's preferred model.
		// Values are passed verbatim. OpenCode CLI reference: https://opencode.ai/docs/cli/
		if (!hasOpenCodeModelArg(args)) {
			const settingsModelId = input.agentSettings?.modelId?.trim();
			if (settingsModelId) {
				const settingsProviderId = input.agentSettings?.providerId?.trim();
				args.push(
					"--model",
					settingsProviderId ? normalizeOpenCodeModel(settingsProviderId, settingsModelId) : settingsModelId,
				);
			} else {
				const preferredModel = await resolveOpenCodePreferredModelArg(baseConfigPath);
				if (preferredModel) {
					args.push("--model", preferredModel);
				}
			}
		}

		const trimmed = input.prompt.trim();
		if (trimmed) {
			args.push("--prompt", trimmed);
			return {
				args,
				env,
			};
		}

		return {
			args,
			env,
		};
	},
};

const droidAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.resumeFromTrash && !hasCliOption(args, "--resume") && !hasCliOption(args, "-r")) {
			args.push("--resume");
		}

		const hooks = resolveHookContext(input);
		const shouldWriteSettings = Boolean(hooks) || input.startInPlanMode || input.autonomousModeEnabled !== undefined;
		if (shouldWriteSettings) {
			const settingsPath = join(getHookAgentDirectory("droid"), "settings.json");
			const settings: Record<string, unknown> = {
				autonomyMode: input.startInPlanMode ? "spec" : input.autonomousModeEnabled ? "auto-high" : "normal",
			};

			if (hooks) {
				const droidActiveToolMatcher = "Read|Grep|Glob|FetchUrl|WebSearch|Execute|Task|Edit|Create";
				const reviewNotifyCommand = buildHooksCommand(["notify", "--event", "to_review", "--source", "droid"]);
				const inProgressNotifyCommand = buildHooksCommand([
					"notify",
					"--event",
					"to_in_progress",
					"--source",
					"droid",
				]);
				const activityNotifyCommand = buildHooksCommand(["notify", "--event", "activity", "--source", "droid"]);
				settings.hooks = {
					Stop: [{ hooks: [{ type: "command", command: reviewNotifyCommand }] }],
					Notification: [
						{ hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ hooks: [{ type: "command", command: reviewNotifyCommand }] },
					],
					PreToolUse: [
						{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ matcher: droidActiveToolMatcher, hooks: [{ type: "command", command: inProgressNotifyCommand }] },
						{ matcher: "AskUser", hooks: [{ type: "command", command: reviewNotifyCommand }] },
					],
					PostToolUse: [
						{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ matcher: "AskUser", hooks: [{ type: "command", command: inProgressNotifyCommand }] },
					],
					PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] }],
					UserPromptSubmit: [{ hooks: [{ type: "command", command: inProgressNotifyCommand }] }],
				};

				Object.assign(
					env,
					createHookRuntimeEnv({
						taskId: hooks.taskId,
						workspaceId: hooks.workspaceId,
					}),
				);
			}

			await ensureTextFile(settingsPath, JSON.stringify(settings, null, 2));
			if (!hasCliOption(args, "--settings")) {
				args.push("--settings", settingsPath);
			}
		}

		const appendedSystemPrompt = resolveSessionSystemPrompt(input);
		if (
			appendedSystemPrompt &&
			!hasCliOption(args, "--append-system-prompt") &&
			!hasCliOption(args, "--system-prompt")
		) {
			args.push("--append-system-prompt", appendedSystemPrompt);
		}

		// Per-task model/effort overrides, passed verbatim. Long-form flags only: in droid's
		// interactive chat mode -r means --resume. Reference:
		// https://docs.factory.ai/droid-cli/cli-reference
		applyCliOptionOverride(args, input.agentSettings?.modelId, ["--model"]);
		applyCliOptionOverride(args, input.agentSettings?.reasoningEffort, ["--reasoning-effort"]);

		const withPromptLaunch = withPrompt(args, input.prompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

const kiroAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.autonomousModeEnabled && !hasCliOption(args, "--trust-all-tools")) {
			args.push("--trust-all-tools");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--resume") && !hasCliOption(args, "-r")) {
			args.push("--resume");
		}

		const hooks = resolveHookContext(input);
		const appendedSystemPrompt = resolveSessionSystemPrompt(input);
		if (hooks || appendedSystemPrompt) {
			const configPath = getKiroAgentConfigPath();
			const config: Record<string, unknown> = {
				name: KIRO_KANBAN_AGENT_NAME,
				description: "Kanban-managed Kiro agent with hook forwarding.",
				tools: ["*"],
			};

			if (hooks) {
				config.hooks = {
					agentSpawn: [
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "agentSpawn",
							}),
						},
					],
					userPromptSubmit: [
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "userPromptSubmit",
							}),
						},
					],
					preToolUse: [
						{
							command: buildHookCommand("activity", {
								source: "kiro",
								hookEventName: "preToolUse",
							}),
						},
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "preToolUse",
							}),
						},
					],
					postToolUse: [
						{
							command: buildHookCommand("activity", {
								source: "kiro",
								hookEventName: "postToolUse",
							}),
						},
					],
					stop: [
						{
							command: buildHookCommand("to_review", {
								source: "kiro",
								hookEventName: "stop",
								activityText: "Waiting for review",
							}),
						},
					],
				};
				Object.assign(
					env,
					createHookRuntimeEnv({
						taskId: hooks.taskId,
						workspaceId: hooks.workspaceId,
					}),
				);
			}

			if (appendedSystemPrompt) {
				config.prompt = appendedSystemPrompt;
			}

			await ensureTextFile(configPath, JSON.stringify(config, null, 2));
			if (!hasCliOption(args, "--agent")) {
				args.push("--agent", KIRO_KANBAN_AGENT_NAME);
			}
		}

		const trimmedPrompt = input.prompt.trim();
		const planPrompt = input.startInPlanMode
			? [
					"First, inspect the codebase and produce a clear implementation plan only.",
					"Do not modify files, do not use write tools, and do not implement anything yet.",
					"After you present the plan, ask for approval before making changes.",
					trimmedPrompt
						? `\n\nTask:\n${trimmedPrompt}`
						: " Ask the user what they want planned if the task is unclear.",
				].join(" ")
			: input.prompt;
		const withPromptLaunch = withPrompt(args, planPrompt, "append");
		// Kiro has no launch-time model/effort mechanism (see agent catalog capabilities).
		// Never drop silently: surface a visible warning in the session output instead.
		const hasTaskAgentSettings = Boolean(
			input.agentSettings?.providerId || input.agentSettings?.modelId || input.agentSettings?.reasoningEffort,
		);
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
			...(hasTaskAgentSettings
				? {
						sessionWarning:
							"kiro ignores launch-time model settings; the task's provider/model/effort overrides were stored but not applied to this session.",
					}
				: {}),
		};
	},
};

// Cline (the `cline` 3.x CLI) as a PTY-driven task agent. Runs the interactive TUI so card
// terminals stay open for follow-ups after the first turn completes. (The embedded Cline SDK
// agent was removed in this fork; "cline-cli", the old id of this agent, is an alias of "cline".)
const clineCliAdapter: AgentSessionAdapter = {
	// Some providers end a turn without Cline's TaskComplete hook; the session files show it (cline-turn-outcome.ts).
	turnEndSource: "cline-session-files",
	// The TUI shows "esc to cancel" while a request runs (archive/devteam-kit:services/kanban-autoland.mjs@0261b20).
	recovery: { clearContextCommand: "/clear", cancelTurnInput: ESCAPE },
	async prepare(input) {
		// --worktree/--zen/--kanban/--update would detach, recurse, or exit
		// instead of running the task session Kanban launched.
		let args = stripCliOptions([...input.args], ["--worktree", "--zen", "-z", "--kanban", "--update"]);
		const env: Record<string, string | undefined> = {};
		let sessionWarning: string | undefined;

		if (input.startInPlanMode) {
			// Plan mode must not inherit approval-bypass flags.
			args = stripCliOptions(args, ["--auto-approve", "--yolo", "-y"]);
			if (!hasCliOption(args, "--plan") && !hasCliOption(args, "-p")) {
				args.push("--plan");
			}
		} else if (
			input.autonomousModeEnabled &&
			!hasCliOption(args, "--auto-approve") &&
			!hasCliOption(args, "--yolo") &&
			!hasCliOption(args, "-y")
		) {
			// Never pass --yolo here: yolo mode disables the CLI's hook dispatch
			// entirely, which would freeze Kanban card state tracking.
			args.push("--auto-approve", "true");
		} else if (
			!input.autonomousModeEnabled &&
			!hasCliOption(args, "--auto-approve") &&
			!hasCliOption(args, "--yolo") &&
			!hasCliOption(args, "-y")
		) {
			// Cline CLI auto-approves every tool by default; opt out explicitly so
			// non-autonomous sessions actually prompt in the terminal.
			args.push("--auto-approve", "false");
		}

		// Cline CLI has no `--continue`; resume requires `--id <session-id>` and
		// Kanban does not persist Cline session ids, so trash-restore relaunches
		// with the original prompt instead of resuming.

		const hooks = resolveHookContext(input);
		const card: ClineHookCard | null = hooks && { ...hooks, workspaceRoot: input.cwd };
		const guardrails = getSessionGuardrails(input);
		const guardCommand = guardrails ? buildClineGuardCommandParts(guardrails) : undefined;
		// The hooks and rules written below are this card's: never a .cline directory shared with other cards.
		await ensureCardOwnedClineDir(input.cwd);
		if (hooks || guardCommand) {
			const hooksDir = join(input.cwd, ".cline", "hooks");
			const executable = process.platform !== "win32";
			const hookFiles: Array<{ name: ClineCliHookName; content: string }> = [
				{ name: "TaskStart", content: buildClineCliHookScriptContent("to_in_progress", "TaskStart", card) },
				{ name: "TaskResume", content: buildClineCliHookScriptContent("to_in_progress", "TaskResume", card) },
				{ name: "TaskCancel", content: buildClineCliHookScriptContent("to_review", "TaskCancel", card) },
				{ name: "TaskComplete", content: buildClineCliHookScriptContent("to_review", "TaskComplete", card) },
				{ name: "TaskError", content: buildClineCliHookScriptContent("to_review", "TaskError", card) },
				{ name: "PreToolUse", content: buildClineCliPreToolUseHookScriptContent(card, guardCommand) },
				{ name: "PostToolUse", content: buildClineCliPostToolUseHookScriptContent(card) },
				{
					name: "UserPromptSubmit",
					content: buildClineCliHookScriptContent("to_in_progress", "UserPromptSubmit", card),
				},
			];
			const skippedHooks: string[] = [];
			for (const hookFile of hookFiles) {
				const hookPath = getClineCliHookScriptPath(hooksDir, hookFile.name);
				const written = await ensureKanbanManagedHookFile(hookPath, hookFile.content, executable);
				if (!written) {
					skippedHooks.push(hookFile.name);
					continue;
				}
				// Kanban's hooks (the PreToolUse one embeds the card's guard policy) never land with the card's work.
				await addToWorktreeGitExclude(input.cwd, `/${relative(input.cwd, hookPath).split("\\").join("/")}`);
			}
			if (skippedHooks.length > 0) {
				sessionWarning = `Cline hooks not installed for ${skippedHooks.join(", ")}: a user-owned .cline/hooks file already exists. Kanban card state will not track those events.${
					guardCommand && skippedHooks.includes("PreToolUse")
						? " This card's guardrails are not enforced either."
						: ""
				}`;
			}

			if (hooks) {
				Object.assign(
					env,
					createHookRuntimeEnv({
						taskId: hooks.taskId,
						workspaceId: hooks.workspaceId,
					}),
				);
			}
		}

		// Kanban writes nothing under ~/.cline: its rules are workspace rules and the notices are off per launch.
		Object.assign(env, CLINE_LAUNCH_ENV);
		const skippedRules = await installClineLaunchRules(input.cwd);
		if (skippedRules.length > 0) {
			const ruleWarning = `Kanban's Cline rules not installed for ${skippedRules.join(", ")}: a user-owned .cline/rules/kanban-* file already exists.`;
			sessionWarning = sessionWarning ? `${sessionWarning} ${ruleWarning}` : ruleWarning;
		}

		const appendedSystemPrompt = resolveSessionSystemPrompt(input);
		if (appendedSystemPrompt) {
			// `-s/--system` would replace Cline's system prompt entirely; a project
			// rules file appends instead and is auto-loaded from `.cline/rules/`.
			const rulesPath = join(input.cwd, ".cline", "rules", KANBAN_HOME_AGENT_CLINE_RULE_FILE);
			await ensureTextFile(rulesPath, `${appendedSystemPrompt}\n`);
		}

		// Per-task provider/model/effort overrides, passed verbatim. Cline CLI
		// accepts -P/--provider, -m/--model, and --thinking. User/workspace args win.
		applyCliOptionOverride(args, input.agentSettings?.providerId, ["--provider", "-P"]);
		applyCliOptionOverride(args, input.agentSettings?.modelId, ["--model", "-m"]);
		applyCliOptionOverride(args, input.agentSettings?.reasoningEffort, ["--thinking"]);

		// A bare prompt runs one-shot and exits, killing the card terminal after
		// the first turn. Force the interactive TUI unless the caller explicitly
		// chose another output mode.
		if (
			input.prompt.trim() &&
			!hasCliOption(args, "--tui") &&
			!hasCliOption(args, "-i") &&
			!hasCliOption(args, "--json") &&
			!hasCliOption(args, "--acp")
		) {
			args.push("--tui");
		}

		const withPromptLaunch = withPrompt(args, input.prompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
			...(sessionWarning ? { sessionWarning } : {}),
		};
	},
};

/** Deletes a file Kanban wrote (its first line has `marker`); a user's file of the same name is left alone. */
async function removeKanbanManagedFile(path: string, marker: string): Promise<void> {
	const content = await readFile(path, "utf8").catch(() => null);
	if (content?.split("\n", 1)[0]?.includes(marker)) {
		await rm(path, { force: true }).catch(() => undefined);
	}
}

async function addToWorktreeGitExclude(worktreePath: string, pattern: string): Promise<void> {
	try {
		// Use git itself to resolve the correct info/exclude path, which correctly
		// handles linked worktrees by following the commondir pointer.
		const excludePathOutput = await getGitStdout(["rev-parse", "--git-path", "info/exclude"], worktreePath);
		if (!excludePathOutput) {
			return;
		}
		const excludePath = isAbsolute(excludePathOutput) ? excludePathOutput : join(worktreePath, excludePathOutput);
		await mkdir(join(excludePath, ".."), { recursive: true });
		let existing = "";
		try {
			existing = await readFile(excludePath, "utf8");
		} catch {
			// file doesn't exist yet
		}
		if (!existing.split("\n").some((line) => line.trim() === pattern)) {
			const separator = existing !== "" && !existing.endsWith("\n") ? "\n" : "";
			await writeFile(excludePath, `${existing}${separator}${pattern}\n`, "utf8");
		}
	} catch {
		// best-effort
	}
}

// Copilot writes ~/.copilot/config.json as JSONC (a `// ...` header) and keeps the login in it (authTokens,
// loggedInUsers, lastLoggedInUser). Returns null unless the content is a JSON(C) object, so callers never
// write back a file they couldn't fully read.
export function parseCopilotConfig(content: string): { header: string; config: Record<string, unknown> } | null {
	const header = /^(?:[ \t]*(?:\/\/[^\n]*)?\r?\n)*/u.exec(content)?.[0] ?? "";
	if (content.trim() === "") {
		return { header: "", config: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(content));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	return { header, config: parsed as Record<string, unknown> };
}

function joinWarnings(...warnings: Array<string | null | undefined>): string | undefined {
	return warnings.filter(Boolean).join(" ") || undefined;
}

/** Copilot's own dir (`$COPILOT_HOME`, else `~/.copilot`): config.json (JSONC, holds the login) and session-state/. */
export function getCopilotHomePath(): string {
	return process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
}

// Returns a warning for the session output when the worktree could not be pre-trusted.
async function addCopilotTrustedFolder(folderPath: string): Promise<string | null> {
	try {
		const copilotHome = getCopilotHomePath();
		const configPath = join(copilotHome, "config.json");
		let content = "";
		try {
			content = await readFile(configPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
		const parsed = parseCopilotConfig(content);
		if (!parsed) {
			// Copilot asks for folder trust itself; rewriting would drop every key we couldn't read (the login).
			return `Did not pre-trust the worktree for Copilot: ${configPath} is not a JSON(C) object, so it was left untouched.`;
		}
		const { header, config } = parsed;
		const normalizedPath = folderPath.replace(/\/+$/u, "");
		let changed = false;
		// Copilot CLI 1.x documents the key as `trustedFolders`; earlier builds read `trusted_folders`.
		for (const key of ["trustedFolders", "trusted_folders"]) {
			const trusted = Array.isArray(config[key]) ? [...(config[key] as string[])] : [];
			if (!trusted.includes(normalizedPath)) {
				trusted.push(normalizedPath);
				config[key] = trusted;
				changed = true;
			}
		}
		if (changed) {
			await mkdir(copilotHome, { recursive: true });
			// Temp file + rename, so Copilot never reads a half-written config.
			const tempPath = `${configPath}.kanban-${process.pid}.tmp`;
			await writeFile(tempPath, `${header}${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			await rename(tempPath, configPath);
		}
		return null;
	} catch (error) {
		// best-effort
		return `Could not pre-trust the worktree for Copilot: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * Find the most recent Copilot CLI session ID for a given working directory.
 * Scans `~/.copilot/session-state/` workspace manifests to match by cwd.
 */
export async function findCopilotSessionIdForCwd(cwd: string): Promise<string | null> {
	try {
		const copilotHome = getCopilotHomePath();
		const sessionStateDir = join(copilotHome, "session-state");
		const entries = await readdir(sessionStateDir);
		const normalizedCwd = cwd.replace(/\/+$/u, "");
		const results = await Promise.all(
			entries.map(async (entry) => {
				try {
					const content = await readFile(join(sessionStateDir, entry, "workspace.yaml"), "utf8");
					const cwdMatch = content.match(/^cwd:\s*(.+)$/mu);
					if (cwdMatch?.[1]?.replace(/\/+$/u, "") !== normalizedCwd) {
						return null;
					}
					const updatedMatch = content.match(/^updated_at:\s*(.+)$/mu);
					return { id: entry, updated: updatedMatch?.[1] ?? "" };
				} catch {
					return null;
				}
			}),
		);
		let bestId: string | null = null;
		let bestUpdated = "";
		for (const result of results) {
			if (result && result.updated > bestUpdated) {
				bestUpdated = result.updated;
				bestId = result.id;
			}
		}
		return bestId;
	} catch {
		return null;
	}
}

function buildCopilotHookEntry(
	event: RuntimeHookEvent,
	metadata?: HookCommandMetadata,
): { type: "command"; bash: string; powershell: string } {
	const parts = buildHookCommandParts(event, metadata);
	return {
		type: "command",
		bash: parts.map(quoteShellArg).join(" "),
		powershell: parts.map(powerShellQuote).join(" "),
	};
}

// Copilot CLI shows an "(Esc to cancel" status bar while the agent is
// actively working.  Track its presence: when it appears the agent is
// busy (In Progress), when it disappears for long enough the agent is
// idle (Review).  Uses a real timer so the transition fires even if the
// TUI stops producing output chunks when idle.
const COPILOT_IDLE_TIMEOUT_MS = 3_000;

interface CopilotDetector {
	detect: AgentOutputTransitionDetector;
	dispose: () => void;
}

function createCopilotTaskCompleteDetector(onIdleTimeout: () => void): CopilotDetector {
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let statusBarWasActive = false;

	function clearIdleTimer(): void {
		if (idleTimer !== null) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	}

	function startIdleTimer(): void {
		if (idleTimer !== null) {
			return;
		}
		idleTimer = setTimeout(() => {
			idleTimer = null;
			onIdleTimeout();
		}, COPILOT_IDLE_TIMEOUT_MS);
	}

	const detect: AgentOutputTransitionDetector = (data, summary) => {
		if (summary.state !== "running" && summary.state !== "awaiting_review") {
			clearIdleTimer();
			return null;
		}
		// Only strip ANSI on the tail — the full output can be large and
		// stripAnsi iterates character-by-character.  The active status bar
		// is always at the bottom of the TUI (end of output).
		const tail = stripAnsi(data.slice(-200));
		const isWorking = tail.includes("(Esc to cancel");
		const isAskingUser = tail.includes("Enter to confirm") || tail.includes("Enter to submit");

		if (isWorking && !isAskingUser) {
			clearIdleTimer();
			statusBarWasActive = true;
			if (summary.state === "awaiting_review") {
				return { type: "hook.to_in_progress" };
			}
			return null;
		}

		// Agent is asking a question — move to review immediately.
		if (isAskingUser && summary.state === "running") {
			clearIdleTimer();
			return { type: "hook.to_review" };
		}

		// Status bar gone — start idle timer if we previously saw it active.
		if (statusBarWasActive && summary.state === "running") {
			startIdleTimer();
		}
		return null;
	};

	return { detect, dispose: clearIdleTimer };
}

function shouldInspectCopilotOutputForTransition(summary: RuntimeTaskSessionSummary): boolean {
	return summary.state === "running" || summary.state === "awaiting_review";
}

// Per-card provider for Copilot cards: agentSettings.providerId "github" (or unset) uses the user's
// Copilot subscription (copilot login / COPILOT_GITHUB_TOKEN). Any other id names a BYOK profile in
// <runtime home>/copilot-providers.json, mapped to Copilot's COPILOT_PROVIDER_* env vars. Profiles hold
// no secrets: keys come from an env var name or a command the CLI runs per request.
export const COPILOT_SUBSCRIPTION_PROVIDER_ID = "github";

export interface CopilotProviderProfile {
	baseUrl: string;
	type?: "openai" | "azure" | "anthropic";
	apiKeyEnv?: string;
	apiKeyCommand?: string;
	bearerTokenEnv?: string;
	wireApi?: "completions" | "responses";
	transport?: "http" | "websockets";
	azureApiVersion?: string;
	headers?: Record<string, string>;
	maxPromptTokens?: number;
	maxOutputTokens?: number;
}

export function getCopilotProvidersPath(): string {
	return join(getRuntimeHomePath(), "copilot-providers.json");
}

async function readCopilotProviderProfile(providerId: string): Promise<CopilotProviderProfile | null> {
	try {
		const parsed = JSON.parse(await readFile(getCopilotProvidersPath(), "utf8")) as {
			providers?: Record<string, CopilotProviderProfile>;
		};
		const profile = parsed.providers?.[providerId];
		return profile && typeof profile.baseUrl === "string" && profile.baseUrl.trim() ? profile : null;
	} catch {
		return null;
	}
}

export function buildCopilotProviderEnv(
	profile: CopilotProviderProfile,
	sourceEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const env: Record<string, string> = { COPILOT_PROVIDER_BASE_URL: profile.baseUrl };
	if (profile.type) env.COPILOT_PROVIDER_TYPE = profile.type;
	if (profile.apiKeyCommand) env.COPILOT_PROVIDER_API_KEY_COMMAND = profile.apiKeyCommand;
	else if (profile.apiKeyEnv && sourceEnv[profile.apiKeyEnv])
		env.COPILOT_PROVIDER_API_KEY = sourceEnv[profile.apiKeyEnv] as string;
	if (profile.bearerTokenEnv && sourceEnv[profile.bearerTokenEnv]) {
		env.COPILOT_PROVIDER_BEARER_TOKEN = sourceEnv[profile.bearerTokenEnv] as string;
	}
	if (profile.wireApi) env.COPILOT_PROVIDER_WIRE_API = profile.wireApi;
	if (profile.transport) env.COPILOT_PROVIDER_TRANSPORT = profile.transport;
	if (profile.azureApiVersion) env.COPILOT_PROVIDER_AZURE_API_VERSION = profile.azureApiVersion;
	if (profile.headers && Object.keys(profile.headers).length > 0) {
		env.COPILOT_PROVIDER_HEADERS = Object.entries(profile.headers)
			.map(([name, value]) => `${name}: ${value}`)
			.join("\n");
	}
	if (profile.maxPromptTokens) env.COPILOT_PROVIDER_MAX_PROMPT_TOKENS = String(profile.maxPromptTokens);
	if (profile.maxOutputTokens) env.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS = String(profile.maxOutputTokens);
	return env;
}

// GitHub Copilot CLI (`copilot`, npm @github/copilot) as a PTY task agent. Based on upstream #286, ported
// onto per-task agentSettings (#592): --model / --reasoning-effort / provider come from the card.
const copilotAdapter: AgentSessionAdapter = {
	// GitHub Copilot's TUI drops input while the terminal is unfocused (fork/copilot, from #286).
	inputDelivery: { focusInBeforeInput: true },
	async prepare(input) {
		let args = [...input.args];
		const env: Record<string, string | undefined> = {};
		let sessionWarning: string | undefined;
		const allowFlags = ["--allow-all", "--allow-all-tools", "--allow-all-paths", "--allow-all-urls", "--yolo"];
		const guardrails = getSessionGuardrails(input);

		if (input.startInPlanMode) {
			// Plan mode must not inherit approval-bypass flags.
			args = stripCliOptions(args, allowFlags);
			if (!hasCliOption(args, "--plan") && !hasCliOption(args, "--mode")) {
				args.push("--plan");
			}
		} else if (input.autonomousModeEnabled) {
			// Autonomous: allow tools and paths, and start in autopilot (a trial at the user's request,
			// 2026-10-07, to see whether it causes problems; before that the agent stopped for questions).
			// Autopilot sends up to --max-autopilot-continues (Copilot's default 5) continuations itself.
			// Copilot 1.0.92 opens a blocking "Enable autopilot mode" dialog unless all permissions are granted,
			// so autopilot also needs --allow-all-urls.
			const startsAutopilot = !hasCliOption(args, "--autopilot") && !hasCliOption(args, "--mode");
			if (!hasCliOption(args, "--allow-all") && !hasCliOption(args, "--yolo")) {
				if (!hasCliOption(args, "--allow-all-tools")) args.push("--allow-all-tools");
				if (!hasCliOption(args, "--allow-all-paths")) args.push("--allow-all-paths");
				if (startsAutopilot && !hasCliOption(args, "--allow-all-urls")) args.push("--allow-all-urls");
			}
			if (startsAutopilot) {
				args.push("--autopilot");
			}
		}

		if (guardrails) {
			// Deny rules win over --allow-all-tools and autopilot (`copilot help permissions`).
			// Writes into the main checkout and the other worktrees are denied for the file tools; Copilot can't allow
			// only the worktree without dropping --allow-all-paths, and autopilot needs all permissions (agent-guardrails.ts).
			for (const denyTool of [
				...buildCopilotDenyTools(guardrails.deniedCommands).denyTools,
				...buildCopilotWriteDenyTools(guardrails),
			]) {
				args.push("--deny-tool", denyTool);
			}
		}

		applyCliOptionOverride(args, input.agentSettings?.modelId, ["--model"]);
		applyCliOptionOverride(args, input.agentSettings?.reasoningEffort, ["--reasoning-effort"]);

		const providerId = input.agentSettings?.providerId?.trim();
		if (providerId && providerId !== COPILOT_SUBSCRIPTION_PROVIDER_ID) {
			const profile = await readCopilotProviderProfile(providerId);
			if (profile) {
				Object.assign(env, buildCopilotProviderEnv(profile));
			} else {
				sessionWarning = `Copilot provider "${providerId}" is not defined in ${getCopilotProvidersPath()}; using the Copilot subscription.`;
			}
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--resume") && !hasCliOption(args, "-r")) {
			// --continue resumes the most recent global session, not this task's, so look it up by worktree.
			const sessionId = await findCopilotSessionIdForCwd(input.cwd);
			if (sessionId) {
				args.push(`--resume=${sessionId}`);
			}
		}

		if (!hasCliOption(args, "--add-dir")) {
			args.push("--add-dir", input.cwd);
		}

		const hooks = resolveHookContext(input);
		const hooksFilePath: string | null = hooks ? join(input.cwd, ".github", "hooks", "kanban.json") : null;
		// Pre-trust the worktree so Copilot doesn't show a folder trust dialog on launch.
		const trustPromise = addCopilotTrustedFolder(input.cwd);
		if (hooks && hooksFilePath) {
			const hooksConfig = {
				version: 1,
				hooks: {
					agentStop: [buildCopilotHookEntry("to_review", { source: "copilot" })],
					subagentStop: [buildCopilotHookEntry("activity", { source: "copilot" })],
					preToolUse: [buildCopilotHookEntry("activity", { source: "copilot" })],
					permissionRequest: [buildCopilotHookEntry("activity", { source: "copilot" })],
					postToolUse: [buildCopilotHookEntry("activity", { source: "copilot" })],
					postToolUseFailure: [buildCopilotHookEntry("activity", { source: "copilot" })],
					userPromptSubmitted: [buildCopilotHookEntry("to_in_progress", { source: "copilot" })],
					notification: [buildCopilotHookEntry("activity", { source: "copilot" })],
				},
			};
			const [, trustWarning] = await Promise.all([
				ensureTextFile(hooksFilePath, JSON.stringify(hooksConfig, null, 2)),
				trustPromise,
			]);
			sessionWarning = joinWarnings(sessionWarning, trustWarning);
			await addToWorktreeGitExclude(input.cwd, ".github/hooks/kanban.json");
			Object.assign(env, createHookRuntimeEnv({ taskId: hooks.taskId, workspaceId: hooks.workspaceId }));
		} else {
			sessionWarning = joinWarnings(sessionWarning, await trustPromise);
		}

		// Skip the prompt when resuming: --interactive with --resume makes Copilot treat it as a new
		// instruction and exit.
		const isResuming = hasCliOption(args, "--resume") || args.some((arg) => arg.startsWith("--resume="));
		const withPromptLaunch =
			!isResuming && input.prompt.trim()
				? withPrompt(args, input.prompt, "flag", "--interactive")
				: { args, env: {} };

		const copilotDetector = createCopilotTaskCompleteDetector(() => {
			// Fire the idle transition through the hooks ingest pipeline (no session-manager changes needed).
			const [cmd, ...cmdArgs] = buildHookCommandParts("to_review", { source: "copilot" });
			if (cmd) {
				const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true, env: { ...process.env, ...env } });
				child.unref();
			}
		});

		return {
			...withPromptLaunch,
			env: { ...withPromptLaunch.env, ...env },
			detectOutputTransition: copilotDetector.detect,
			shouldInspectOutputForTransition: shouldInspectCopilotOutputForTransition,
			cleanup: async () => {
				copilotDetector.dispose();
				if (hooksFilePath) {
					try {
						await unlink(hooksFilePath);
					} catch {
						// best-effort cleanup
					}
				}
			},
			...(sessionWarning ? { sessionWarning } : {}),
		};
	},
};

const ADAPTERS: Record<RuntimeAgentId, AgentSessionAdapter> = {
	claude: claudeAdapter,
	codex: codexAdapter,
	gemini: geminiAdapter,
	opencode: opencodeAdapter,
	droid: droidAdapter,
	kiro: kiroAdapter,
	cline: clineCliAdapter,
	copilot: copilotAdapter,
};

export function getAgentInputDeliveryProfile(agentId: RuntimeAgentId | null): AgentInputDeliveryProfile {
	return (agentId ? ADAPTERS[agentId].inputDelivery : undefined) ?? DEFAULT_INPUT_DELIVERY_PROFILE;
}

export function getAgentRecoveryProfile(agentId: RuntimeAgentId | null): AgentRecoveryProfile {
	return (agentId ? ADAPTERS[agentId].recovery : undefined) ?? DEFAULT_RECOVERY_PROFILE;
}

export function getAgentTurnEndSource(agentId: RuntimeAgentId | null): AgentTurnEndSource | null {
	return (agentId ? ADAPTERS[agentId].turnEndSource : undefined) ?? null;
}

/**
 * The launch prompt plus the guardrail note, when the agent's CLI leaves some of the card's guardrails unenforced,
 * and the isolation note under project isolation `enforce` (it says what the CLI doesn't block).
 */
async function withGuardrailPromptNote(input: AgentAdapterLaunchInput, prompt: string): Promise<string> {
	const guardrails = getSessionGuardrails(input);
	if (!guardrails || !prompt.trim()) {
		return prompt;
	}
	// Isolation-only guardrails (the orchestrator's, or a card's with guardrails off) have no card rules to state.
	const hasCardRules =
		guardrails.role === "card" && (guardrails.deniedCommands.length > 0 || guardrails.confineWrites);
	const cardNote = hasCardRules ? await buildCardGuardrailNote(input, guardrails) : null;
	const isolationNote = guardrails.isolation
		? buildIsolationPromptNote(guardrails.isolation, describeAgentIsolation(input.agentId).unenforced)
		: null;
	const notes = [cardNote, isolationNote].filter((note): note is string => Boolean(note));
	return notes.length > 0 ? `${prompt.trimEnd()}\n\n${notes.join("\n\n")}` : prompt;
}

async function buildCardGuardrailNote(
	input: AgentAdapterLaunchInput,
	guardrails: TaskGuardrails,
): Promise<string | null> {
	const report = describeAgentGuardrails(input.agentId, {
		deniedCommands: guardrails.deniedCommands,
		confineWrites: guardrails.confineWrites,
		codexSandbox: ADAPTERS[input.agentId] === codexAdapter ? await shouldConfineCodexWrites(input, guardrails) : null,
	});
	if (report.unenforced.length === 0) {
		return null;
	}
	// Agents whose guard runs Kanban's matcher let a PR card push its own branch; the others keep the push deny.
	const rules = usesKanbanCommandMatcher(input.agentId)
		? listMatcherDeniedCommands(guardrails)
		: guardrails.deniedCommands;
	return buildGuardrailPromptNote(guardrails, report.unenforced, rules);
}

export async function prepareAgentLaunch(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> {
	const preparedPrompt = await prepareTaskPromptWithImages({
		prompt: input.prompt,
		images: input.images,
	});
	return await ADAPTERS[input.agentId].prepare({
		...input,
		prompt: await withGuardrailPromptNote(input, preparedPrompt),
	});
}
