// Built-in kits that were renamed, old name → the kit (and preset) that replaced it. A workspace whose config still
// names the old kit runs on the new one (workspaceKitRefSchema reads it as the new pair), doctor warns and `--fix`
// (and import-kit) rewrite it through migrateLegacyConfigKeys(); a command given the old name (kit apply, kit create
// --from, ...) is told the new one. An old name stays reserved, so no user kit can take it. No imports: config parsing
// reads this too.

/** A kit as a workspace selects it: the kit's name and, for the `team` kit, its preset (null = a custom team). */
export interface KitSelection {
	name: string;
	preset: string | null;
}

export const RENAMED_BUILT_IN_KITS: ReadonlyMap<string, KitSelection> = new Map([
	// User request 2026-10-12: one `team` kit holds the workflow, presets hold the models.
	["team-cloud", { name: "team", preset: "cloud" }],
	["team-local", { name: "team", preset: "lemonade" }],
	["team-cline", { name: "team", preset: "cline" }],
]);

/** The kit (and preset) that replaced a renamed built-in kit, or null. */
export function getRenamedKit(name: string): KitSelection | null {
	return RENAMED_BUILT_IN_KITS.get(name) ?? null;
}

/** A kit selection as `kit apply` takes it: `team --preset cloud`, `team --custom`, or the kit's name. */
export function formatKitSelectionArgs(selection: KitSelection): string {
	if (selection.preset !== null) {
		return `${selection.name} --preset ${selection.preset}`;
	}
	return selection.name === "team" ? "team --custom" : selection.name;
}

/** A kit selection for messages: `team (cloud)`, `team (custom)`, or the kit's name. */
export function formatKitSelection(selection: KitSelection): string {
	if (selection.preset !== null) {
		return `${selection.name} (${selection.preset})`;
	}
	return selection.name === "team" ? "team (custom)" : selection.name;
}

/** The answer to a command that names a renamed kit. */
export function describeRenamedKit(oldName: string, selection: KitSelection): string {
	return `kit "${oldName}" is now ${formatKitSelection(selection)} (2026-10-12); use ${formatKitSelectionArgs(selection)}`;
}
