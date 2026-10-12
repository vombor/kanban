// The origin a browser page reaches Kanban on (`window.location.origin`), which only the page knows: behind a tunnel
// or a forwarded port the server's own Host and Origin headers still say localhost. The web UI sends it with the
// WebSocket connections it opens anyway (the state stream, every terminal), and the server keeps the ones from the
// user's browser in memory (src/server/browser-origins.ts), so a command run in a Kanban terminal can print links
// the user's browser opens (`kanban github bot create`).
export const BROWSER_PAGE_ORIGIN_QUERY_PARAM = "pageOrigin";

/** An http(s) origin (`scheme://host[:port]`, no path), or null for anything else. */
export function normalizeBrowserPageOrigin(value: string | null | undefined): string | null {
	if (!value?.trim()) {
		return null;
	}
	try {
		const url = new URL(value.trim());
		return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
	} catch {
		return null;
	}
}
