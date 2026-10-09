// A project's shortcuts (the top bar's script runner: a label, a command typed into a terminal, an icon) changed
// without the settings dialog: `kanban shortcut add|remove` through the runtime route src/trpc/shortcuts-api.ts,
// which decides who may (the user and that project's own orchestrator). Shortcuts stay where the dialog keeps them
// (getProjectKanbanConfigPath); every change made here is appended to getShortcutHistoryPath(workspaceId).
// Any label, command and icon: a shortcut that needs a port uses the `{port}` / `{url}` placeholders
// (shortcut-utils.ts), which Kanban fills in for each run.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { updateProjectShortcuts } from "../config/runtime-config";
import { isRuntimeShortcutIconId, RUNTIME_SHORTCUT_ICON_IDS } from "../config/shortcut-utils";
import type { RuntimeProjectShortcut } from "../core/api-contract";
import type { KitSettingsActor } from "../kits/project-settings";
import { getShortcutHistoryPath } from "../state/kanban-home";

/** Thrown for a change that doesn't validate (not for I/O failures). */
export class ShortcutRefusedError extends Error {}

export interface ShortcutHistoryEntry {
	at: string;
	workspaceId: string;
	label: string;
	/** Absent: the shortcut is new. */
	from?: RuntimeProjectShortcut;
	/** Absent: the shortcut is removed. */
	to?: RuntimeProjectShortcut;
	by: KitSettingsActor;
	via: "shortcut add" | "shortcut remove";
}

export interface ShortcutChangeResult {
	shortcuts: RuntimeProjectShortcut[];
	change: ShortcutHistoryEntry | null;
}

export interface ShortcutChangeInput {
	workspaceId: string;
	repoPath: string;
	by: KitSettingsActor;
	historyPath?: string;
	now?: () => Date;
}

function sameLabel(left: string, right: string): boolean {
	return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export function normalizeShortcutInput(input: {
	label: string;
	command: string;
	icon?: string | null;
}): RuntimeProjectShortcut {
	const label = input.label.trim();
	const command = input.command.trim();
	const icon = input.icon?.trim().toLowerCase() || undefined;
	if (!label) {
		throw new ShortcutRefusedError("a shortcut needs a label");
	}
	if (!command) {
		throw new ShortcutRefusedError("a shortcut needs a command");
	}
	if (command.includes("\n") || command.includes("\r")) {
		throw new ShortcutRefusedError(
			"a shortcut's command is one line (it is typed into a terminal); join steps with && or ;",
		);
	}
	if (icon !== undefined && !isRuntimeShortcutIconId(icon)) {
		throw new ShortcutRefusedError(`unknown icon "${icon}" (icons: ${RUNTIME_SHORTCUT_ICON_IDS.join(", ")})`);
	}
	return { label, command, ...(icon ? { icon } : {}) };
}

async function appendHistory(entry: ShortcutHistoryEntry, path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

async function change(
	input: ShortcutChangeInput,
	via: ShortcutHistoryEntry["via"],
	label: string,
	plan: (current: RuntimeProjectShortcut[]) => {
		next: RuntimeProjectShortcut[];
		from?: RuntimeProjectShortcut;
		to?: RuntimeProjectShortcut;
	},
): Promise<ShortcutChangeResult> {
	let from: RuntimeProjectShortcut | undefined;
	let to: RuntimeProjectShortcut | undefined;
	const { before, after } = await updateProjectShortcuts(input.repoPath, (current) => {
		const planned = plan(current);
		from = planned.from;
		to = planned.to;
		return planned.next;
	});
	if (JSON.stringify(before) === JSON.stringify(after)) {
		return { shortcuts: after, change: null };
	}
	const entry: ShortcutHistoryEntry = {
		at: (input.now?.() ?? new Date()).toISOString(),
		workspaceId: input.workspaceId,
		// The stored label (a remove may name it in another case).
		label: (to ?? from)?.label ?? label,
		...(from ? { from } : {}),
		...(to ? { to } : {}),
		by: input.by,
		via,
	};
	await appendHistory(entry, input.historyPath ?? getShortcutHistoryPath(input.workspaceId));
	return { shortcuts: after, change: entry };
}

/** Adds a shortcut, or replaces the one with the same label (case-insensitive) in its place. */
export async function upsertProjectShortcut(
	input: ShortcutChangeInput & { shortcut: { label: string; command: string; icon?: string | null } },
): Promise<ShortcutChangeResult> {
	const shortcut = normalizeShortcutInput(input.shortcut);
	return await change(input, "shortcut add", shortcut.label, (current) => {
		const index = current.findIndex((item) => sameLabel(item.label, shortcut.label));
		if (index < 0) {
			return { next: [...current, shortcut], to: shortcut };
		}
		const next = [...current];
		next[index] = shortcut;
		return { next, from: current[index], to: shortcut };
	});
}

export async function removeProjectShortcut(
	input: ShortcutChangeInput & { label: string },
): Promise<ShortcutChangeResult> {
	return await change(input, "shortcut remove", input.label.trim(), (current) => {
		const existing = current.find((item) => sameLabel(item.label, input.label));
		if (!existing) {
			throw new ShortcutRefusedError(
				`${input.workspaceId} has no shortcut "${input.label}" (shortcuts: ${current.map((item) => item.label).join(", ") || "none"})`,
			);
		}
		return { next: current.filter((item) => item !== existing), from: existing };
	});
}
