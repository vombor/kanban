// PTY-backed runtime for non-Cline task sessions and the workspace shell terminal.
// It owns process lifecycle, terminal protocol filtering, and summary updates
// for command-driven agents such as Claude Code, Codex, Gemini, and shell sessions.
import type {
	RuntimeTaskAgentSettings,
	RuntimeTaskHookActivity,
	RuntimeTaskImage,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
	RuntimeTaskTurnEnd,
	RuntimeTaskTypedInput,
} from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import {
	isTaskExecutionBlockWarning,
	readTaskExecutionBlock,
	TASK_EXECUTION_BLOCK_PREFIX,
} from "../core/task-execution-block";
import { accumulateRunningTime } from "../core/task-running-time";
import {
	type AgentAdapterLaunchInput,
	type AgentOutputTransitionDetector,
	type AgentOutputTransitionInspectionPredicate,
	prepareAgentLaunch,
} from "./agent-session-adapters";
import {
	CLAUDE_WORKSPACE_TRUST_KEY_DELAY_MS,
	CLAUDE_WORKSPACE_TRUST_MAX_NAVIGATION_KEYS,
	getClaudeWorkspaceTrustConfirmInput,
	hasClaudeWorkspaceTrustPrompt,
	shouldAutoConfirmClaudeWorkspaceTrust,
	stopWorkspaceTrustTimers,
	WORKSPACE_TRUST_CONFIRM_DELAY_MS,
} from "./claude-workspace-trust";
import { hasCodexWorkspaceTrustPrompt, shouldAutoConfirmCodexWorkspaceTrust } from "./codex-workspace-trust";
import { stripAnsi } from "./output-utils";
import { PtySession } from "./pty-session";
import { reduceSessionTransition, type SessionTransitionEvent } from "./session-state-machine";
import {
	createTerminalProtocolFilterState,
	disableOscColorQueryIntercept,
	filterTerminalProtocolOutput,
	type TerminalProtocolFilterState,
} from "./terminal-protocol-filter";
import type { TerminalSessionListener, TerminalSessionService } from "./terminal-session-service";
import { TerminalStateMirror } from "./terminal-state-mirror";
import { readTypedInput } from "./typed-input-text";

const MAX_WORKSPACE_TRUST_BUFFER_CHARS = 16_384;
const AUTO_RESTART_WINDOW_MS = 5_000;
const MAX_AUTO_RESTARTS_PER_WINDOW = 3;
// TUI apps (Codex, OpenCode) can query OSC 10/11 before the browser terminal is attached
// and ready to answer. We intercept those startup probes during early PTY output, synthesize
// foreground/background color replies, then disable the filter once a live terminal listener
// has attached.
const OSC_FOREGROUND_QUERY_REPLY = "\u001b]10;rgb:e6e6/eded/f3f3\u001b\\";
const OSC_BACKGROUND_QUERY_REPLY = "\u001b]11;rgb:1717/1717/2121\u001b\\";

type RestartableSessionRequest =
	| { kind: "task"; request: StartTaskSessionRequest }
	| { kind: "shell"; request: StartShellSessionRequest };

interface ActiveProcessState {
	session: PtySession;
	workspaceTrustBuffer: string | null;
	cols: number;
	rows: number;
	terminalProtocolFilter: TerminalProtocolFilterState;
	onSessionCleanup: (() => Promise<void>) | null;
	deferredStartupInput: string | null;
	detectOutputTransition: AgentOutputTransitionDetector | null;
	shouldInspectOutputForTransition: AgentOutputTransitionInspectionPredicate | null;
	awaitingCodexPromptAfterEnter: boolean;
	/**
	 * Printable text was typed into the TUI since the last Enter, Ctrl-C or Ctrl-U (writeInput): the input box may
	 * hold a draft, so nothing may type into it and press Enter (orchestrator message notices,
	 * src/isolation/message-notices.ts). `since`: its first text, `typedAt`: its last; it counts for DRAFT_MAX_AGE_MS
	 * after `typedAt`.
	 */
	draft: { since: number; typedAt: number } | null;
	/**
	 * When the user last pressed Enter in the session's terminal (writeInput `fromViewer`): an answer to whatever the
	 * agent asked, for agents that report no hook on it (src/terminal/user-input-wait.ts).
	 */
	viewerSubmittedAt: number | null;
	/** When the user last typed text (Enter included) into the session's terminal (writeInput `fromViewer`). */
	viewerTypedAt: number | null;
	autoConfirmedWorkspaceTrust: boolean;
	workspaceTrustNavigationKeys: number;
	workspaceTrustConfirmTimer: NodeJS.Timeout | null;
}

interface SessionEntry {
	summary: RuntimeTaskSessionSummary;
	active: ActiveProcessState | null;
	terminalStateMirror: TerminalStateMirror | null;
	restoreGeneration: number;
	listenerIdCounter: number;
	listeners: Map<number, TerminalSessionListener>;
	restartRequest: RestartableSessionRequest | null;
	suppressAutoRestartOnExit: boolean;
	autoRestartTimestamps: number[];
	pendingAutoRestart: Promise<void> | null;
	/** When summary.state last changed (null until it does). */
	stateChangedAt: number | null;
}

export interface StartTaskSessionRequest {
	/** In-process dispatch receipt identity; never parsed from an external launch body or an authorization bypass. */
	admissionId?: string;
	taskId: string;
	agentId: AgentAdapterLaunchInput["agentId"];
	binary: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	cols?: number;
	rows?: number;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	agentSettings?: RuntimeTaskAgentSettings;
	/** The task card's guardrails (null for the orchestrator), see AgentAdapterLaunchInput. */
	guardrails?: AgentAdapterLaunchInput["guardrails"];
}

export interface StartShellSessionRequest {
	taskId: string;
	cwd: string;
	cols?: number;
	rows?: number;
	binary: string;
	args?: string[];
	env?: Record<string, string | undefined>;
}

function now(): number {
	return Date.now();
}

/** How long after the user's last keystroke in a terminal Kanban still counts them as typing there. */
export const VIEWER_TYPING_QUIET_MS = 10_000;

/**
 * How long a draft counts after the last text typed into it (issue #39): Kanban can't see a TUI's input box, so a
 * draft it misread, or one the user abandoned, must not refuse every delivery into that terminal forever.
 */
export const DRAFT_MAX_AGE_MS = 30 * 60_000;

function createDefaultSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		lastTurnEnd: null,
		warningMessage: null,
		modelId: null,
		reasoningEffort: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

function cloneSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return {
		...summary,
	};
}

export interface HookActivityOptions {
	/** The hook moves the session to Review (hook ingest's `to_review`): its final message is the turn's. */
	turnEnd?: boolean;
}

/**
 * The summary's turn end after a hook: a `to_review` hook with a final message, while the session is in Review through
 * a hook, records it; any other hook (Claude Code's idle Notification after Stop) keeps it. A second turn-end hook in
 * the same Review (Codex reports final_answer, then task_complete) keeps the first one's `at`, so it is one turn end.
 */
function resolveLastTurnEnd(
	summary: RuntimeTaskSessionSummary,
	activity: Partial<RuntimeTaskHookActivity>,
	options: HookActivityOptions,
): RuntimeTaskTurnEnd | null {
	const current = summary.lastTurnEnd ?? null;
	const finalMessage = activity.finalMessage?.trim() ?? "";
	if (!options.turnEnd || !finalMessage || summary.state !== "awaiting_review" || summary.reviewReason !== "hook") {
		return current;
	}
	if (current?.finalMessage === finalMessage) {
		return current;
	}
	return { at: current?.at ?? now(), finalMessage };
}

function updateSummary(entry: SessionEntry, patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	const updatedAt = now();
	const stateChanged = patch.state !== undefined && patch.state !== entry.summary.state;
	if (stateChanged) {
		entry.stateChangedAt = updatedAt;
	}
	// The card's running time (src/core/task-running-time.ts): a running span this patch ends is added here, the one
	// writer of state changes.
	const runningTime = accumulateRunningTime(entry.summary, patch, updatedAt, { live: entry.active !== null });
	entry.summary = {
		...entry.summary,
		// A turn end holds only for the Review it was reported in.
		...(stateChanged ? { lastTurnEnd: null } : {}),
		...(stateChanged && patch.state === "running" && isTaskExecutionBlockWarning(entry.summary.warningMessage)
			? { warningMessage: null }
			: {}),
		...runningTime,
		...patch,
		...(stateChanged ? { stateChangedAt: updatedAt } : {}),
		updatedAt,
	};
	return entry.summary;
}

function isActiveState(state: RuntimeTaskSessionState): boolean {
	return state === "running" || state === "awaiting_review";
}

function cloneStartTaskSessionRequest(request: StartTaskSessionRequest): StartTaskSessionRequest {
	return {
		...request,
		args: [...request.args],
		images: request.images ? request.images.map((image) => ({ ...image })) : undefined,
		env: request.env ? { ...request.env } : undefined,
		agentSettings: request.agentSettings ? { ...request.agentSettings } : undefined,
	};
}

function cloneStartShellSessionRequest(request: StartShellSessionRequest): StartShellSessionRequest {
	return {
		...request,
		args: request.args ? [...request.args] : undefined,
		env: request.env ? { ...request.env } : undefined,
	};
}

function formatSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found. Install a supported agent CLI and select it in Settings.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

function formatShellSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found on this system.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

// A source's `undefined` removes the variable (node-pty would pass it on as the string "undefined"). No adapter
// removes one today; the env type allows it, so the filter stays.
export function buildTerminalEnvironment(
	...sources: Array<Record<string, string | undefined> | undefined>
): Record<string, string> {
	const merged: Record<string, string | undefined> = {
		...process.env,
		...Object.assign({}, ...sources),
		COLORTERM: "truecolor",
		TERM: "xterm-256color",
		TERM_PROGRAM: "kanban",
	};
	return Object.fromEntries(
		Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

function hasCodexInteractivePrompt(text: string): boolean {
	const stripped = stripAnsi(text);
	return /(?:^|[\n\r])\s*›\s*/u.test(stripped);
}

function hasCodexStartupUiRendered(text: string): boolean {
	const stripped = stripAnsi(text).toLowerCase();
	return stripped.includes("openai codex (v");
}

export class TerminalSessionManager implements TerminalSessionService {
	constructor(private readonly options: { onOutput?: (taskId: string, chunk: Buffer) => void } = {}) {}
	private readonly entries = new Map<string, SessionEntry>();
	private readonly summaryListeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	private readonly viewerSubmitListeners = new Set<(taskId: string) => void>();

	private trySendDeferredCodexStartupInput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active || entry.summary.agentId !== "codex") {
			return false;
		}
		if (active.deferredStartupInput === null) {
			return false;
		}
		const trustPromptVisible =
			active.workspaceTrustBuffer !== null && hasCodexWorkspaceTrustPrompt(active.workspaceTrustBuffer);
		if (trustPromptVisible) {
			return false;
		}
		const deferredInput = active.deferredStartupInput;
		active.deferredStartupInput = null;
		active.session.write(deferredInput);
		return true;
	}

	// Fallback for a Claude Code trust dialog that pre-trust did not prevent. One key per render, read from
	// the dialog's pointer: arrow down off "No, exit", then Enter on "Yes, I trust this folder".
	private scheduleClaudeWorkspaceTrustKey(taskId: string, active: ActiveProcessState): void {
		active.workspaceTrustConfirmTimer = setTimeout(() => {
			active.workspaceTrustConfirmTimer = null;
			if (this.entries.get(taskId)?.active !== active || active.autoConfirmedWorkspaceTrust) {
				return;
			}
			const input =
				active.workspaceTrustBuffer === null
					? null
					: getClaudeWorkspaceTrustConfirmInput(active.workspaceTrustBuffer);
			if (input === "\r") {
				active.autoConfirmedWorkspaceTrust = true;
				active.session.write(input);
				// Trust text can remain in the rolling buffer after we auto-confirm.
				// Clear it so later startup/prompt checks do not match stale trust output.
				active.workspaceTrustBuffer = "";
				return;
			}
			if (input === null || active.workspaceTrustNavigationKeys >= CLAUDE_WORKSPACE_TRUST_MAX_NAVIGATION_KEYS) {
				// Never type into a dialog whose focus we cannot read: its default is "No, exit".
				active.autoConfirmedWorkspaceTrust = true;
				return;
			}
			active.workspaceTrustNavigationKeys += 1;
			active.session.write(input);
		}, CLAUDE_WORKSPACE_TRUST_KEY_DELAY_MS);
	}

	private hasLiveOutputListener(entry: SessionEntry): boolean {
		for (const listener of entry.listeners.values()) {
			if (listener.onOutput) {
				return true;
			}
		}
		return false;
	}

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		this.summaryListeners.add(listener);
		return () => {
			this.summaryListeners.delete(listener);
		};
	}

	/** The user pressed Enter in a session's terminal (no summary changes, so onSummary doesn't tell). */
	onViewerInputSubmitted(listener: (taskId: string) => void): () => void {
		this.viewerSubmitListeners.add(listener);
		return () => {
			this.viewerSubmitListeners.delete(listener);
		};
	}

	hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): void {
		for (const [taskId, summary] of Object.entries(record)) {
			this.entries.set(taskId, {
				summary: cloneSummary(summary),
				active: null,
				terminalStateMirror: null,
				restoreGeneration: 0,
				listenerIdCounter: 1,
				listeners: new Map(),
				restartRequest: null,
				suppressAutoRestartOnExit: false,
				autoRestartTimestamps: [],
				pendingAutoRestart: null,
				stateChangedAt: null,
			});
		}
	}

	/**
	 * Marks every summary that says "running" but has no process in this manager interrupted (pid gone, newer
	 * `updatedAt`, so the summary merge keeps the mark over the stored one), and returns the marked summaries. The
	 * server calls it once, right after hydrating a workspace's summaries at startup: those sessions' PTYs died with
	 * the previous server, and a dead "running" summary misled the QA gate, the watchdog, session sync and the
	 * browser after the 2026-10-07 23:02:56Z restart. Restart recovery counts "interrupted" as an orphan state like
	 * "running" (restart-recovery.ts), so marking before or after it plans changes nothing there.
	 *
	 * A home-agent (sidebar orchestrator) session is marked in Review too: it waits for the user between turns, so a
	 * stop that skipped the shutdown cleanup (the pod's `--skip-shutdown-cleanup`, a crash) leaves it "awaiting_review"
	 * with the dead pid, and the browser restarts its sidebar only on "interrupted" (use-home-agent-session.ts): the
	 * open tab's sidebar stayed blank after the 2026-10-12 09:24:50Z restart. Card sessions in Review keep their state
	 * (restart recovery would resume them as orphans). `cardSessions: false` (session sync off, where the browser
	 * trashes a card whose session turns interrupted) marks only the home-agent sessions, which are no cards.
	 */
	markOrphanedSessionsInterrupted(options: { cardSessions?: boolean } = {}): RuntimeTaskSessionSummary[] {
		const cardSessions = options.cardSessions ?? true;
		const marked: RuntimeTaskSessionSummary[] = [];
		for (const [taskId, entry] of this.entries) {
			const isOrphan = isHomeAgentSessionId(taskId)
				? isActiveState(entry.summary.state)
				: cardSessions && entry.summary.state === "running";
			if (entry.active || !isOrphan) {
				continue;
			}
			marked.push(
				cloneSummary(updateSummary(entry, { state: "interrupted", reviewReason: "interrupted", pid: null })),
			);
			this.emitSummary(entry.summary);
		}
		return marked;
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		return entry ? cloneSummary(entry.summary) : null;
	}

	/** When the session entered its current state: the last state change, or its start if that came later. */
	getStateEnteredAt(taskId: string): number | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const changedAt = entry.stateChangedAt;
		const startedAt = entry.summary.startedAt ?? null;
		if (changedAt === null || startedAt === null) {
			return changedAt ?? startedAt;
		}
		return Math.max(changedAt, startedAt);
	}

	/**
	 * Whether startTaskSession would hand back the live session unchanged (a process in a running or Review state)
	 * instead of starting a new one. Its env (the session credential) then stays the running process's.
	 */
	willReuseLiveSession(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		return Boolean(entry?.active && isActiveState(entry.summary.state));
	}

	/** When the user last pressed Enter in the session's terminal, or null (none since its process started). */
	getViewerInputSubmittedAt(taskId: string): number | null {
		return this.entries.get(taskId)?.active?.viewerSubmittedAt ?? null;
	}

	/** When the user last typed text (Enter included) into the session's terminal, or null (none since it started). */
	getViewerTypedAt(taskId: string): number | null {
		return this.entries.get(taskId)?.active?.viewerTypedAt ?? null;
	}

	/**
	 * Whether nothing may type into the session and press Enter now: text was typed since its last Enter (the input
	 * box may hold a draft), or the user typed into its terminal within VIEWER_TYPING_QUIET_MS (an Enter alone doesn't
	 * end their typing: the next line may follow). The one "is the user typing" rule (orchestrator message notices,
	 * the watchdog's sidebar wakes).
	 */
	hasTypedInputSinceEnter(taskId: string): boolean {
		return this.describeTypedInput(taskId) !== null;
	}

	/** Why hasTypedInputSinceEnter holds (a draft, a recent keystroke), or null when it doesn't. */
	describeTypedInput(taskId: string): RuntimeTaskTypedInput | null {
		const active = this.entries.get(taskId)?.active;
		if (!active) {
			return null;
		}
		const current = now();
		const draft = active.draft && current - active.draft.typedAt < DRAFT_MAX_AGE_MS ? active.draft : null;
		const typingNow = active.viewerTypedAt !== null && current - active.viewerTypedAt < VIEWER_TYPING_QUIET_MS;
		if (!draft && !typingNow) {
			return null;
		}
		return {
			draftSince: draft?.since ?? null,
			draftTypedAt: draft?.typedAt ?? null,
			viewerTypedAt: active.viewerTypedAt,
		};
	}

	/** Whether the task's session has a process now (false for a summary hydrated after a restart). */
	hasLiveProcess(taskId: string): boolean {
		return Boolean(this.entries.get(taskId)?.active);
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return Array.from(this.entries.values()).map((entry) => cloneSummary(entry.summary));
	}

	attach(taskId: string, listener: TerminalSessionListener): (() => void) | null {
		const entry = this.ensureEntry(taskId);

		listener.onState?.(cloneSummary(entry.summary));
		if (entry.active && listener.onOutput) {
			disableOscColorQueryIntercept(entry.active.terminalProtocolFilter);
		}

		const listenerId = entry.listenerIdCounter;
		entry.listenerIdCounter += 1;
		entry.listeners.set(listenerId, listener);

		return () => {
			entry.listeners.delete(listenerId);
		};
	}

	async getRestoreSnapshot(taskId: string) {
		const entry = this.entries.get(taskId);
		if (!entry?.terminalStateMirror) {
			return null;
		}
		const snapshot = await entry.terminalStateMirror.getSnapshot();
		return {
			...snapshot,
			restoreGeneration: entry.restoreGeneration,
		};
	}

	async startTaskSession(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const pending = this.taskStarts.get(request.taskId);
		if (pending) return pending;
		if (this.willReuseLiveSession(request.taskId)) {
			const entry = this.ensureEntry(request.taskId);
			entry.restartRequest = { kind: "task", request: cloneStartTaskSessionRequest(request) };
			return cloneSummary(entry.summary);
		}
		const start = Promise.resolve().then(() =>
			this.taskStartAdmission
				? this.taskStartAdmission(request, () => this.startTaskSessionAdmitted(request))
				: this.startTaskSessionAdmitted(request),
		);
		this.taskStarts.set(request.taskId, start);
		try {
			return await start;
		} finally {
			if (this.taskStarts.get(request.taskId) === start) this.taskStarts.delete(request.taskId);
		}
	}
	private readonly taskStarts = new Map<string, Promise<RuntimeTaskSessionSummary>>();
	private taskStartAdmission:
		| ((
				request: StartTaskSessionRequest,
				start: () => Promise<RuntimeTaskSessionSummary>,
		  ) => Promise<RuntimeTaskSessionSummary>)
		| null = null;
	private taskRestart: ((request: StartTaskSessionRequest) => Promise<void>) | null = null;
	setTaskAdmission(
		admission: NonNullable<TerminalSessionManager["taskStartAdmission"]>,
		restart: NonNullable<TerminalSessionManager["taskRestart"]>,
	): void {
		this.taskStartAdmission = admission;
		this.taskRestart = restart;
	}
	private async startTaskSessionAdmitted(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureEntry(request.taskId);
		entry.restartRequest = {
			kind: "task",
			request: cloneStartTaskSessionRequest(request),
		};
		if (entry.active && isActiveState(entry.summary.state)) {
			return cloneSummary(entry.summary);
		}

		if (entry.active) {
			stopWorkspaceTrustTimers(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.terminalStateMirror?.dispose();
		entry.terminalStateMirror = null;

		const cols = Math.min(
			500,
			Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120,
		);
		const rows = Math.min(
			200,
			Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40,
		);
		const terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!entry.active || this.hasLiveOutputListener(entry)) {
					return;
				}
				entry.active.session.write(data);
			},
		});

		const launch = await prepareAgentLaunch({
			taskId: request.taskId,
			agentId: request.agentId,
			binary: request.binary,
			args: request.args,
			autonomousModeEnabled: request.autonomousModeEnabled,
			cwd: request.cwd,
			prompt: request.prompt,
			images: request.images,
			startInPlanMode: request.startInPlanMode,
			resumeFromTrash: request.resumeFromTrash,
			env: request.env,
			workspaceId: request.workspaceId,
			agentSettings: request.agentSettings,
			guardrails: request.guardrails,
		});

		const env = buildTerminalEnvironment(request.env, launch.env);

		// Adapters can wrap the configured agent binary when they need extra runtime wiring
		// (for example, Codex uses a wrapper script to watch session logs for hook transitions).
		const commandBinary = launch.binary ?? request.binary;
		const commandArgs = [...launch.args];
		const hasCodexLaunchSignature = [commandBinary, ...commandArgs].some((part) =>
			part.toLowerCase().includes("codex"),
		);
		let session: PtySession;
		try {
			session = PtySession.spawn({
				binary: commandBinary,
				args: commandArgs,
				cwd: request.cwd,
				env,
				cols,
				rows,
				onData: (chunk) => {
					if (!entry.active) {
						return;
					}

					const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
						onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
						onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
					});
					if (filteredChunk.byteLength === 0) {
						return;
					}
					entry.terminalStateMirror?.applyOutput(filteredChunk);
					this.options.onOutput?.(request.taskId, filteredChunk);

					const shouldInspect =
						entry.active.detectOutputTransition !== null &&
						(entry.active.shouldInspectOutputForTransition?.(entry.summary) ?? true);
					const needsDecodedOutput = entry.active.workspaceTrustBuffer !== null || shouldInspect;
					const data = needsDecodedOutput ? filteredChunk.toString("utf8") : "";

					if (entry.active.workspaceTrustBuffer !== null) {
						entry.active.workspaceTrustBuffer += data;
						if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
							entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(
								-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
							);
						}
						if (!entry.active.autoConfirmedWorkspaceTrust && entry.active.workspaceTrustConfirmTimer === null) {
							if (hasClaudeWorkspaceTrustPrompt(entry.active.workspaceTrustBuffer)) {
								this.scheduleClaudeWorkspaceTrustKey(request.taskId, entry.active);
							} else if (hasCodexWorkspaceTrustPrompt(entry.active.workspaceTrustBuffer)) {
								entry.active.autoConfirmedWorkspaceTrust = true;
								const trustConfirmDelayMs = WORKSPACE_TRUST_CONFIRM_DELAY_MS;
								entry.active.workspaceTrustConfirmTimer = setTimeout(() => {
									const activeEntry = this.entries.get(request.taskId)?.active;
									if (!activeEntry || !activeEntry.autoConfirmedWorkspaceTrust) {
										return;
									}
									activeEntry.session.write("\r");
									// Trust text can remain in the rolling buffer after we auto-confirm.
									// Clear it so later startup/prompt checks do not match stale trust output.
									if (activeEntry.workspaceTrustBuffer !== null) {
										activeEntry.workspaceTrustBuffer = "";
									}
									activeEntry.workspaceTrustConfirmTimer = null;
								}, trustConfirmDelayMs);
							}
						}
					}
					updateSummary(entry, { lastOutputAt: now() });

					// Codex plan-mode startup input is deferred until we know the TUI rendered.
					// Trigger on either the interactive prompt marker or the startup header text.
					if (
						entry.summary.agentId === "codex" &&
						entry.active.deferredStartupInput !== null &&
						data.length > 0 &&
						(hasCodexInteractivePrompt(data) ||
							hasCodexStartupUiRendered(data) ||
							(entry.active.workspaceTrustBuffer !== null &&
								(hasCodexInteractivePrompt(entry.active.workspaceTrustBuffer) ||
									hasCodexStartupUiRendered(entry.active.workspaceTrustBuffer))))
					) {
						this.trySendDeferredCodexStartupInput(request.taskId);
					}

					const adapterEvent = entry.active.detectOutputTransition?.(data, entry.summary) ?? null;
					if (adapterEvent) {
						const requiresEnterForCodex =
							adapterEvent.type === "agent.prompt-ready" &&
							entry.summary.agentId === "codex" &&
							!entry.active.awaitingCodexPromptAfterEnter;
						if (!requiresEnterForCodex) {
							const summary = this.applySessionEvent(entry, adapterEvent);
							if (adapterEvent.type === "agent.prompt-ready" && entry.summary.agentId === "codex") {
								entry.active.awaitingCodexPromptAfterEnter = false;
							}
							for (const taskListener of entry.listeners.values()) {
								taskListener.onState?.(cloneSummary(summary));
							}
							this.emitSummary(summary);
						}
					}

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
				},
				onExit: (event) => {
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry) {
						return;
					}
					const currentActive = currentEntry.active;
					if (!currentActive) {
						return;
					}
					stopWorkspaceTrustTimers(currentActive);

					const summary = this.applySessionEvent(currentEntry, {
						type: "process.exit",
						exitCode: event.exitCode,
						interrupted: currentActive.session.wasInterrupted(),
					});
					const shouldAutoRestart = this.shouldAutoRestart(currentEntry);

					for (const taskListener of currentEntry.listeners.values()) {
						taskListener.onState?.(cloneSummary(summary));
						taskListener.onExit?.(event.exitCode);
					}
					currentEntry.active = null;
					this.emitSummary(summary);
					if (shouldAutoRestart) {
						this.scheduleAutoRestart(currentEntry);
					}

					const cleanupFn = currentActive.onSessionCleanup;
					currentActive.onSessionCleanup = null;
					if (cleanupFn) {
						cleanupFn().catch(() => {
							// Best effort: cleanup failure is non-critical.
						});
					}
				},
			});
		} catch (error) {
			if (launch.cleanup) {
				void launch.cleanup().catch(() => {
					// Best effort: cleanup failure is non-critical.
				});
			}
			terminalStateMirror.dispose();
			const summary = updateSummary(entry, {
				state: "failed",
				agentId: request.agentId,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				lastTurnEnd: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			this.emitSummary(summary);
			throw new Error(formatSpawnFailure(commandBinary, error));
		}

		const active: ActiveProcessState = {
			session,
			workspaceTrustBuffer:
				shouldAutoConfirmClaudeWorkspaceTrust(request.agentId, request.cwd) ||
				shouldAutoConfirmCodexWorkspaceTrust(request.agentId, request.cwd) ||
				hasCodexLaunchSignature
					? ""
					: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
				suppressDeviceAttributeQueries: request.agentId === "droid",
			}),
			onSessionCleanup: launch.cleanup ?? null,
			deferredStartupInput: launch.deferredStartupInput ?? null,
			detectOutputTransition: launch.detectOutputTransition ?? null,
			shouldInspectOutputForTransition: launch.shouldInspectOutputForTransition ?? null,
			awaitingCodexPromptAfterEnter: false,
			draft: null,
			viewerSubmittedAt: null,
			viewerTypedAt: null,
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustNavigationKeys: 0,
			workspaceTrustConfirmTimer: null,
		};
		entry.active = active;
		entry.terminalStateMirror = terminalStateMirror;
		entry.restoreGeneration += 1;

		if (launch.sessionWarning) {
			const warningOutput = Buffer.from(`\r\n[kanban] ${launch.sessionWarning}\r\n`, "utf8");
			terminalStateMirror.applyOutput(warningOutput);
			for (const taskListener of entry.listeners.values()) {
				taskListener.onOutput?.(warningOutput);
			}
		}

		const startedAt = now();
		// A resume waits for the user (trash restore sends no prompt), unless its launch prompt is the next turn
		// (restart recovery's resume note).
		const awaitingInput = request.resumeFromTrash === true && !request.prompt.trim();
		updateSummary(entry, {
			runCount: (entry.summary.runCount ?? 0) + 1,
			firstRunStartedAt: entry.summary.firstRunStartedAt ?? startedAt,
			state: awaitingInput ? "awaiting_review" : "running",
			agentId: request.agentId,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt,
			dispatchPromptSubmitted: request.prompt.trim().length > 0,
			dispatchPromptSubmittedAt: request.prompt.trim().length > 0 ? startedAt : null,
			lastOutputAt: launch.sessionWarning ? startedAt : null,
			reviewReason: awaitingInput ? "attention" : null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			lastTurnEnd: null,
			warningMessage: launch.sessionWarning ?? null,
			modelId: request.agentSettings?.modelId ?? null,
			reasoningEffort: request.agentSettings?.reasoningEffort ?? null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});
		this.emitSummary(entry.summary);

		return cloneSummary(entry.summary);
	}

	async startShellSession(request: StartShellSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureEntry(request.taskId);
		entry.restartRequest = {
			kind: "shell",
			request: cloneStartShellSessionRequest(request),
		};
		if (entry.active && entry.summary.state === "running") {
			return cloneSummary(entry.summary);
		}

		if (entry.active) {
			stopWorkspaceTrustTimers(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.terminalStateMirror?.dispose();
		entry.terminalStateMirror = null;

		const cols = Math.min(
			500,
			Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120,
		);
		const rows = Math.min(
			200,
			Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40,
		);
		const terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!entry.active || this.hasLiveOutputListener(entry)) {
					return;
				}
				entry.active.session.write(data);
			},
		});
		const env = buildTerminalEnvironment(request.env);

		let session: PtySession;
		try {
			session = PtySession.spawn({
				binary: request.binary,
				args: request.args ?? [],
				cwd: request.cwd,
				env,
				cols,
				rows,
				onData: (chunk) => {
					if (!entry.active) {
						return;
					}

					const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
						onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
						onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
					});
					if (filteredChunk.byteLength === 0) {
						return;
					}
					entry.terminalStateMirror?.applyOutput(filteredChunk);
					this.options.onOutput?.(request.taskId, filteredChunk);

					if (entry.active.workspaceTrustBuffer !== null) {
						entry.active.workspaceTrustBuffer += filteredChunk.toString("utf8");
						if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
							entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(
								-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
							);
						}
					}
					updateSummary(entry, { lastOutputAt: now() });

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
				},
				onExit: (event) => {
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry) {
						return;
					}
					const currentActive = currentEntry.active;
					if (!currentActive) {
						return;
					}
					stopWorkspaceTrustTimers(currentActive);

					const summary = updateSummary(currentEntry, {
						state: currentActive.session.wasInterrupted() ? "interrupted" : "idle",
						reviewReason: currentActive.session.wasInterrupted() ? "interrupted" : null,
						exitCode: event.exitCode,
						pid: null,
					});

					for (const taskListener of currentEntry.listeners.values()) {
						taskListener.onState?.(cloneSummary(summary));
						taskListener.onExit?.(event.exitCode);
					}
					currentEntry.active = null;
					this.emitSummary(summary);
				},
			});
		} catch (error) {
			terminalStateMirror.dispose();
			const summary = updateSummary(entry, {
				state: "failed",
				agentId: null,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				lastTurnEnd: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			this.emitSummary(summary);
			throw new Error(formatShellSpawnFailure(request.binary, error));
		}

		const active: ActiveProcessState = {
			session,
			workspaceTrustBuffer: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
			}),
			onSessionCleanup: null,
			deferredStartupInput: null,
			detectOutputTransition: null,
			shouldInspectOutputForTransition: null,
			awaitingCodexPromptAfterEnter: false,
			draft: null,
			viewerSubmittedAt: null,
			viewerTypedAt: null,
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustNavigationKeys: 0,
			workspaceTrustConfirmTimer: null,
		};
		entry.active = active;
		entry.terminalStateMirror = terminalStateMirror;
		entry.restoreGeneration += 1;

		updateSummary(entry, {
			state: "running",
			agentId: null,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt: now(),
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			lastTurnEnd: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});
		this.emitSummary(entry.summary);

		return cloneSummary(entry.summary);
	}

	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (entry.active || !isActiveState(entry.summary.state)) {
			return cloneSummary(entry.summary);
		}

		// Preserve agentId so the server can route to the correct agent type
		// when a task is restored from trash.
		const summary = updateSummary(entry, {
			state: "idle",
			workspacePath: null,
			pid: null,
			startedAt: null,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			lastTurnEnd: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});

		for (const listener of entry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	/** `fromViewer`: the keys come from the user's terminal, not from Kanban delivering text (deliver-task-input.ts). */
	writeInput(taskId: string, data: Buffer, options: { fromViewer?: boolean } = {}): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return null;
		}
		if (
			entry.summary.agentId === "codex" &&
			entry.summary.state === "awaiting_review" &&
			(entry.summary.reviewReason === "hook" ||
				entry.summary.reviewReason === "attention" ||
				entry.summary.reviewReason === "error") &&
			(data.includes(13) || data.includes(10))
		) {
			entry.active.awaitingCodexPromptAfterEnter = true;
		}
		// Terminal sequences alone (focus-in, arrows, mouse reports, the terminal's replies) don't change whether the
		// input box holds a draft; only printable text does (typed-input-text.ts).
		const typed = readTypedInput(data.toString("utf8"));
		const { submitted } = typed;
		const typedAt = now();
		if (typed.cleared) {
			entry.active.draft = null;
		}
		if (typed.typesDraft) {
			entry.active.draft = { since: entry.active.draft?.since ?? typedAt, typedAt };
		}
		entry.active.session.write(data);
		if (options.fromViewer && typed.hasKeys) {
			entry.active.viewerTypedAt = typedAt;
		}
		if (submitted && options.fromViewer) {
			entry.active.viewerSubmittedAt = now();
			for (const listener of this.viewerSubmitListeners) {
				listener(taskId);
			}
		}
		return cloneSummary(entry.summary);
	}

	resize(taskId: string, cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		const safeCols = Math.min(500, Math.max(1, Math.floor(cols)));
		const safeRows = Math.min(200, Math.max(1, Math.floor(rows)));
		const safePixelWidth = Number.isFinite(pixelWidth ?? Number.NaN) ? Math.floor(pixelWidth as number) : undefined;
		const safePixelHeight = Number.isFinite(pixelHeight ?? Number.NaN)
			? Math.floor(pixelHeight as number)
			: undefined;
		const normalizedPixelWidth = safePixelWidth !== undefined && safePixelWidth > 0 ? safePixelWidth : undefined;
		const normalizedPixelHeight = safePixelHeight !== undefined && safePixelHeight > 0 ? safePixelHeight : undefined;
		entry.active.session.resize(safeCols, safeRows, normalizedPixelWidth, normalizedPixelHeight);
		entry.terminalStateMirror?.resize(safeCols, safeRows);
		entry.active.cols = safeCols;
		entry.active.rows = safeRows;
		return true;
	}

	pauseOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.pause();
		return true;
	}

	resumeOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.resume();
		return true;
	}

	transitionToReview(taskId: string, reason: RuntimeTaskSessionReviewReason): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (reason !== "hook") {
			return cloneSummary(entry.summary);
		}
		const before = entry.summary;
		const summary = this.applySessionEvent(entry, { type: "hook.to_review" });
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}
		return cloneSummary(summary);
	}

	applyHookActivity(
		taskId: string,
		activity: Partial<RuntimeTaskHookActivity>,
		options: HookActivityOptions = {},
	): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const hasActivityUpdate =
			typeof activity.activityText === "string" ||
			typeof activity.toolName === "string" ||
			typeof activity.toolInputSummary === "string" ||
			typeof activity.finalMessage === "string" ||
			typeof activity.hookEventName === "string" ||
			typeof activity.notificationType === "string" ||
			typeof activity.source === "string";
		if (!hasActivityUpdate) {
			return cloneSummary(entry.summary);
		}

		const previous = entry.summary.latestHookActivity;
		const next: RuntimeTaskHookActivity = {
			activityText:
				typeof activity.activityText === "string" ? activity.activityText : (previous?.activityText ?? null),
			toolName: typeof activity.toolName === "string" ? activity.toolName : (previous?.toolName ?? null),
			toolInputSummary:
				typeof activity.toolInputSummary === "string"
					? activity.toolInputSummary
					: (previous?.toolInputSummary ?? null),
			finalMessage:
				typeof activity.finalMessage === "string" ? activity.finalMessage : (previous?.finalMessage ?? null),
			hookEventName:
				typeof activity.hookEventName === "string" ? activity.hookEventName : (previous?.hookEventName ?? null),
			notificationType:
				typeof activity.notificationType === "string"
					? activity.notificationType
					: (previous?.notificationType ?? null),
			source: typeof activity.source === "string" ? activity.source : (previous?.source ?? null),
		};

		const didChange =
			next.activityText !== (previous?.activityText ?? null) ||
			next.toolName !== (previous?.toolName ?? null) ||
			next.toolInputSummary !== (previous?.toolInputSummary ?? null) ||
			next.finalMessage !== (previous?.finalMessage ?? null) ||
			next.hookEventName !== (previous?.hookEventName ?? null) ||
			next.notificationType !== (previous?.notificationType ?? null) ||
			next.source !== (previous?.source ?? null);
		const lastTurnEnd = resolveLastTurnEnd(entry.summary, activity, options);
		const executionBlock = readTaskExecutionBlock(activity);
		if (!didChange && lastTurnEnd === entry.summary.lastTurnEnd) {
			return cloneSummary(entry.summary);
		}

		const summary = updateSummary(entry, {
			lastHookAt: now(),
			latestHookActivity: next,
			lastTurnEnd,
			...(executionBlock
				? {
						warningMessage: `${TASK_EXECUTION_BLOCK_PREFIX}${executionBlock}`,
						reviewReason: "error" as const,
						lastTurnEnd: null,
					}
				: {}),
		});
		if (entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	transitionToRunning(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const before = entry.summary;
		if (entry.summary.dispatchPromptSubmitted === false && entry.active)
			updateSummary(entry, { dispatchPromptSubmitted: true, dispatchPromptSubmittedAt: now() });
		const summary = this.applySessionEvent(entry, { type: "hook.to_in_progress" });
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}
		return cloneSummary(summary);
	}

	recordDispatchProvider(
		taskId: string,
		providerId: string | null,
		promptSubmitted = true,
	): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) return null;
		const submitted = promptSubmitted || entry.summary.dispatchPromptSubmitted === true;
		if (entry.summary.providerId === providerId && entry.summary.dispatchPromptSubmitted === submitted)
			return cloneSummary(entry.summary);
		const summary = updateSummary(entry, {
			providerId,
			dispatchPromptSubmitted: submitted,
			dispatchPromptSubmittedAt: entry.summary.dispatchPromptSubmittedAt ?? (submitted ? now() : null),
		});
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const latestCheckpoint = entry.summary.latestTurnCheckpoint ?? null;
		if (latestCheckpoint?.ref === checkpoint.ref && latestCheckpoint.commit === checkpoint.commit) {
			return cloneSummary(entry.summary);
		}

		const summary = updateSummary(entry, {
			previousTurnCheckpoint: latestCheckpoint,
			latestTurnCheckpoint: checkpoint,
		});
		if (entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	stopTaskSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return entry ? cloneSummary(entry.summary) : null;
		}
		entry.suppressAutoRestartOnExit = true;
		const cleanupFn = entry.active.onSessionCleanup;
		entry.active.onSessionCleanup = null;
		stopWorkspaceTrustTimers(entry.active);
		entry.active.session.stop();
		if (cleanupFn) {
			cleanupFn().catch(() => {
				// Best effort: cleanup failure is non-critical.
			});
		}
		return cloneSummary(entry.summary);
	}

	markInterruptedAndStopAll(): RuntimeTaskSessionSummary[] {
		const activeEntries = Array.from(this.entries.values()).filter((entry) => entry.active != null);
		for (const entry of activeEntries) {
			if (!entry.active) {
				continue;
			}
			stopWorkspaceTrustTimers(entry.active);
			entry.active.session.stop({ interrupted: true });
		}
		return activeEntries.map((entry) => cloneSummary(entry.summary));
	}

	private applySessionEvent(entry: SessionEntry, event: SessionTransitionEvent): RuntimeTaskSessionSummary {
		const transition = reduceSessionTransition(entry.summary, event);
		if (!transition.changed) {
			return entry.summary;
		}
		if (transition.clearAttentionBuffer && entry.active) {
			if (entry.active.workspaceTrustBuffer !== null) {
				entry.active.workspaceTrustBuffer = "";
			}
		}
		if (entry.active && transition.changed && transition.patch.state === "awaiting_review") {
			entry.active.awaitingCodexPromptAfterEnter = false;
		}
		return updateSummary(entry, transition.patch);
	}

	private ensureEntry(taskId: string): SessionEntry {
		const existing = this.entries.get(taskId);
		if (existing) {
			return existing;
		}
		const created: SessionEntry = {
			summary: createDefaultSummary(taskId),
			active: null,
			terminalStateMirror: null,
			restoreGeneration: 0,
			listenerIdCounter: 1,
			listeners: new Map(),
			restartRequest: null,
			suppressAutoRestartOnExit: false,
			autoRestartTimestamps: [],
			pendingAutoRestart: null,
			stateChangedAt: null,
		};
		this.entries.set(taskId, created);
		return created;
	}

	private shouldAutoRestart(entry: SessionEntry): boolean {
		const wasSuppressed = entry.suppressAutoRestartOnExit;
		entry.suppressAutoRestartOnExit = false;
		if (wasSuppressed) {
			return false;
		}
		if (entry.listeners.size === 0 || entry.restartRequest?.kind !== "task") {
			return false;
		}
		const currentTime = now();
		entry.autoRestartTimestamps = entry.autoRestartTimestamps.filter(
			(timestamp) => currentTime - timestamp < AUTO_RESTART_WINDOW_MS,
		);
		if (entry.autoRestartTimestamps.length >= MAX_AUTO_RESTARTS_PER_WINDOW) {
			return false;
		}
		entry.autoRestartTimestamps.push(currentTime);
		return true;
	}

	private scheduleAutoRestart(entry: SessionEntry): void {
		if (entry.pendingAutoRestart) {
			return;
		}
		const restartRequest = entry.restartRequest;
		if (!restartRequest || restartRequest.kind !== "task") {
			return;
		}
		let pendingAutoRestart: Promise<void> | null = null;
		pendingAutoRestart = (async () => {
			try {
				const { admissionId: _receipt, ...request } = cloneStartTaskSessionRequest(restartRequest.request);
				if (this.taskRestart) await this.taskRestart(request);
				else await this.startTaskSession(request);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const summary = updateSummary(entry, {
					warningMessage: message,
				});
				const output = Buffer.from(`\r\n[kanban] ${message}\r\n`, "utf8");
				for (const listener of entry.listeners.values()) {
					listener.onOutput?.(output);
					listener.onState?.(cloneSummary(summary));
				}
				this.emitSummary(summary);
			} finally {
				if (entry.pendingAutoRestart === pendingAutoRestart) {
					entry.pendingAutoRestart = null;
				}
			}
		})();
		entry.pendingAutoRestart = pendingAutoRestart;
	}

	private emitSummary(summary: RuntimeTaskSessionSummary): void {
		const snapshot = cloneSummary(summary);
		for (const listener of this.summaryListeners) {
			listener(snapshot);
		}
	}
}
