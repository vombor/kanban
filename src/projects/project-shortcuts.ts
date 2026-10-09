// A project's shortcuts (the top bar's script runner: a label, a command typed into a terminal, an icon) changed
// through the runtime route src/trpc/shortcuts-api.ts, which decides who may (the user and that project's own
// orchestrator): `kanban shortcut add|remove` and the settings dialog's save. They are kept in the shortcut store
// (src/projects/project-shortcut-store.ts), outside the repo; every change is appended to the shortcut history.
// Any label, command and icon: a shortcut that needs a port uses the `{port}` / `{url}` placeholders
// (shortcut-utils.ts), which Kanban fills in for each run.
import { isRuntimeShortcutIconId, RUNTIME_SHORTCUT_ICON_IDS } from "../config/shortcut-utils";
import type { RuntimeProjectShortcut } from "../core/api-contract";
import type { KitSettingsActor } from "../kits/project-settings";
import {
	appendShortcutHistory,
	type ProjectShortcutStoreInput,
	type ShortcutChangeHistoryEntry,
	type ShortcutChangeVia,
	updateStoredProjectShortcuts,
} from "./project-shortcut-store";

/** Thrown for a change that doesn't validate (not for I/O failures). */
export class ShortcutRefusedError extends Error {}

export interface ShortcutChangeResult {
	shortcuts: RuntimeProjectShortcut[];
	/** One per label that changed (none: nothing did). */
	changes: ShortcutChangeHistoryEntry[];
}

export interface ShortcutChangeInput extends ProjectShortcutStoreInput {
	by: KitSettingsActor;
}

function sameLabel(left: string, right: string): boolean {
	return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function sameShortcut(left: RuntimeProjectShortcut, right: RuntimeProjectShortcut): boolean {
	return left.label === right.label && left.command === right.command && (left.icon ?? "") === (right.icon ?? "");
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

/** What changed between two lists, by label (case-insensitive): one entry per added, changed or removed shortcut. */
function diffShortcuts(
	before: RuntimeProjectShortcut[],
	after: RuntimeProjectShortcut[],
): Array<{ label: string; from?: RuntimeProjectShortcut; to?: RuntimeProjectShortcut }> {
	const changes: Array<{ label: string; from?: RuntimeProjectShortcut; to?: RuntimeProjectShortcut }> = [];
	for (const to of after) {
		const from = before.find((item) => sameLabel(item.label, to.label));
		if (!from) {
			changes.push({ label: to.label, to });
		} else if (!sameShortcut(from, to)) {
			changes.push({ label: to.label, from, to });
		}
	}
	for (const from of before) {
		if (!after.some((item) => sameLabel(item.label, from.label))) {
			changes.push({ label: from.label, from });
		}
	}
	return changes;
}

async function change(
	input: ShortcutChangeInput,
	via: ShortcutChangeVia,
	plan: (current: RuntimeProjectShortcut[]) => RuntimeProjectShortcut[],
): Promise<ShortcutChangeResult> {
	const { before, after } = await updateStoredProjectShortcuts(input, plan);
	const at = (input.now?.() ?? new Date()).toISOString();
	const changes = diffShortcuts(before, after).map(
		(item): ShortcutChangeHistoryEntry => ({
			at,
			workspaceId: input.workspaceId,
			label: item.label,
			...(item.from ? { from: item.from } : {}),
			...(item.to ? { to: item.to } : {}),
			by: input.by,
			via,
		}),
	);
	for (const entry of changes) {
		await appendShortcutHistory(entry, { homePath: input.homePath });
	}
	return { shortcuts: after, changes };
}

/** Adds a shortcut, or replaces the one with the same label (case-insensitive) in its place. */
export async function upsertProjectShortcut(
	input: ShortcutChangeInput & { shortcut: { label: string; command: string; icon?: string | null } },
): Promise<ShortcutChangeResult> {
	const shortcut = normalizeShortcutInput(input.shortcut);
	return await change(input, "shortcut add", (current) => {
		const index = current.findIndex((item) => sameLabel(item.label, shortcut.label));
		if (index < 0) {
			return [...current, shortcut];
		}
		const next = [...current];
		next[index] = shortcut;
		return next;
	});
}

export async function removeProjectShortcut(
	input: ShortcutChangeInput & { label: string },
): Promise<ShortcutChangeResult> {
	return await change(input, "shortcut remove", (current) => {
		const existing = current.find((item) => sameLabel(item.label, input.label));
		if (!existing) {
			throw new ShortcutRefusedError(
				`${input.workspaceId} has no shortcut "${input.label}" (shortcuts: ${current.map((item) => item.label).join(", ") || "none"})`,
			);
		}
		return current.filter((item) => item !== existing);
	});
}

/**
 * The settings dialog's save: the whole list, in its order. Rows without a label or command are dropped, as the
 * dialog always did; the rest validate like `shortcut add`, and labels must differ (case-insensitive).
 */
export async function replaceProjectShortcuts(
	input: ShortcutChangeInput & { shortcuts: Array<{ label: string; command: string; icon?: string | null }> },
): Promise<ShortcutChangeResult> {
	const next = input.shortcuts
		.filter((item) => item.label.trim() && item.command.trim())
		.map((item) => normalizeShortcutInput(item));
	const duplicate = next.find((item, index) => next.findIndex((other) => sameLabel(other.label, item.label)) < index);
	if (duplicate) {
		throw new ShortcutRefusedError(`two shortcuts are labelled "${duplicate.label}"; give each its own label`);
	}
	return await change(input, "settings dialog", () => next);
}
