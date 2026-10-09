import type { RuntimeProjectShortcut } from "../core/api-contract";

export function areRuntimeProjectShortcutsEqual(
	left: RuntimeProjectShortcut[],
	right: RuntimeProjectShortcut[],
): boolean {
	if (left.length !== right.length) {
		return false;
	}
	for (let index = 0; index < left.length; index += 1) {
		const leftItem = left[index];
		const rightItem = right[index];
		if (!leftItem || !rightItem) {
			return false;
		}
		if (
			leftItem.label !== rightItem.label ||
			leftItem.command !== rightItem.command ||
			(leftItem.icon ?? "") !== (rightItem.icon ?? "")
		) {
			return false;
		}
	}
	return true;
}

/** The icons a shortcut can name (the board's SHORTCUT_ICON_DEFINITIONS keys, web-ui/src/components/shared). */
export const RUNTIME_SHORTCUT_ICON_IDS = [
	"play",
	"console",
	"bug",
	"download",
	"upload",
	"build",
	"code",
	"rocket",
	"settings",
	"plus",
] as const;
export type RuntimeShortcutIconId = (typeof RUNTIME_SHORTCUT_ICON_IDS)[number];

export function isRuntimeShortcutIconId(value: string): value is RuntimeShortcutIconId {
	return (RUNTIME_SHORTCUT_ICON_IDS as readonly string[]).includes(value);
}

// Placeholders Kanban fills in when a shortcut runs (docs/fork/shortcuts.md): `{port}` is a free TCP port handed out
// for that run, `{url}` is where the browser reaches that port through the Kanban server
// (`<origin>/api/shortcut-port/<port>/`, with the trailing slash). Any shortcut may use them; a command without
// them is typed as it is.
export const SHORTCUT_PORT_PLACEHOLDER = "{port}";
export const SHORTCUT_URL_PLACEHOLDER = "{url}";

export function shortcutNeedsPort(command: string): boolean {
	return command.includes(SHORTCUT_PORT_PLACEHOLDER) || command.includes(SHORTCUT_URL_PLACEHOLDER);
}

export function expandShortcutCommand(command: string, values: { port: number; url: string }): string {
	return command
		.replaceAll(SHORTCUT_PORT_PLACEHOLDER, String(values.port))
		.replaceAll(SHORTCUT_URL_PLACEHOLDER, values.url);
}
