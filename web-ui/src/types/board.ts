import { isPendingGitActionStale, PENDING_GIT_ACTION_STALE_AFTER_MS } from "@runtime-task-state";
import type {
	RuntimeAgentId,
	RuntimeBoardColumnId,
	RuntimeTaskAgentSettings,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskImage,
	RuntimeTaskPendingGitAction,
	RuntimeTaskRole,
} from "@/runtime/types";

export { isPendingGitActionStale, PENDING_GIT_ACTION_STALE_AFTER_MS };
export type BoardColumnId = RuntimeBoardColumnId;

export type TaskAutoReviewMode = RuntimeTaskAutoReviewMode;
export type TaskImage = RuntimeTaskImage;

export const DEFAULT_TASK_AUTO_REVIEW_MODE: TaskAutoReviewMode = "commit";

export function resolveTaskAutoReviewMode(mode: TaskAutoReviewMode | null | undefined): TaskAutoReviewMode {
	if (mode === "pr" || mode === "qa") {
		return mode;
	}
	return DEFAULT_TASK_AUTO_REVIEW_MODE;
}

export function getTaskAutoReviewActionLabel(mode: TaskAutoReviewMode | null | undefined): string {
	const resolvedMode = resolveTaskAutoReviewMode(mode);
	if (resolvedMode === "pr") {
		return "PR";
	}
	if (resolvedMode === "qa") {
		return "QA and land";
	}
	return "commit";
}

export function getTaskAutoReviewCancelButtonLabel(mode: TaskAutoReviewMode | null | undefined): string {
	const resolvedMode = resolveTaskAutoReviewMode(mode);
	if (resolvedMode === "pr") {
		return "Cancel Auto-PR";
	}
	if (resolvedMode === "qa") {
		return "Cancel QA and land";
	}
	return "Cancel Auto-commit";
}

/** The auto-review modes a card can pick. "qa" (the pipeline QA-gates the card, Kanban lands it) only on landing mode qa. */
export function getTaskAutoReviewModeOptions(options: {
	qaLandingAvailable: boolean;
	currentMode?: TaskAutoReviewMode;
}): Array<{ value: TaskAutoReviewMode; label: string }> {
	const modes: Array<{ value: TaskAutoReviewMode; label: string }> = [
		{ value: "commit", label: "Make commit" },
		{ value: "pr", label: "Make PR" },
	];
	// A card that already is "qa" keeps showing it, so the select never shows a value it doesn't list.
	if (options.qaLandingAvailable || options.currentMode === "qa") {
		modes.push({ value: "qa", label: "QA, then land" });
	}
	return modes;
}

export type TaskRole = RuntimeTaskRole;

const TASK_ROLES: readonly TaskRole[] = ["dev", "qa", "triage", "calibration"];

/** A card role from untyped data; a missing or unknown role is a dev card (no role). */
export function normalizeTaskRole(value: unknown): TaskRole | undefined {
	return typeof value === "string" && value !== "dev" && (TASK_ROLES as readonly string[]).includes(value)
		? (value as TaskRole)
		: undefined;
}

/** The badge a non-dev card shows on the board, or null for a dev card. */
export function getTaskRoleBadgeLabel(role: TaskRole | null | undefined): string | null {
	if (role === "qa") {
		return "QA";
	}
	if (role === "triage") {
		return "Triage";
	}
	if (role === "calibration") {
		return "Calibration";
	}
	return null;
}

export type TaskPendingGitAction = RuntimeTaskPendingGitAction;

export interface BoardCard {
	id: string;
	title: string;
	prompt: string;
	startInPlanMode: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: TaskAutoReviewMode;
	/** Absent = a dev card. QA, TRIAGE and calibration cards are never QA'd, reworked or auto-reviewed. */
	role?: TaskRole;
	/** On a QA card: the dev card it reviews (written by the pipeline). */
	reviewsTaskId?: string;
	images?: TaskImage[];
	agentId?: RuntimeAgentId;
	agentSettings?: RuntimeTaskAgentSettings;
	baseRef: string;
	createdAt: number;
	updatedAt: number;
	pendingGitAction?: TaskPendingGitAction | null;
}

export interface BoardColumn {
	id: BoardColumnId;
	title: string;
	cards: BoardCard[];
}

export interface BoardDependency {
	id: string;
	fromTaskId: string;
	toTaskId: string;
	createdAt: number;
}

export interface BoardData {
	columns: BoardColumn[];
	dependencies: BoardDependency[];
}

export interface ReviewTaskWorkspaceSnapshot {
	taskId: string;
	path: string;
	branch: string | null;
	isDetached: boolean;
	headCommit: string | null;
	changedFiles: number | null;
	additions: number | null;
	deletions: number | null;
}

export interface CardSelection {
	card: BoardCard;
	column: BoardColumn;
	allColumns: BoardColumn[];
}
