// Built-in kits that were renamed, old name → new name. A workspace whose config still names the old kit runs on the
// new one (resolveWorkspaceKit), doctor warns and `--fix` (and import-kit) rewrite it through
// migrateLegacyConfigKeys(); a command given the old name (kit apply, kit create --from, ...) is told the new one.
// An old name stays reserved, so no user kit can take it. No imports: config parsing reads this too.

export const RENAMED_BUILT_IN_KITS: ReadonlyMap<string, string> = new Map([
	// User request 2026-10-12, next to team-local, team-cline and team-triton.
	["team", "team-cloud"],
]);

/** The new name of a renamed built-in kit, or null. */
export function getRenamedKitName(name: string): string | null {
	return RENAMED_BUILT_IN_KITS.get(name) ?? null;
}

/** The answer to a command that names a renamed kit. */
export function describeRenamedKit(oldName: string, newName: string): string {
	return `kit "${oldName}" was renamed to ${newName} (2026-10-12); use ${newName}`;
}
