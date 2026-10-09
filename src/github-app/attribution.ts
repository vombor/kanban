// The attribution line on every issue and comment Kanban posts for a project. The one Kanban GitHub App posts for
// every project, and an app's name and avatar are fixed (`<app>[bot]`), so the project (and the poster's role, when
// known) goes into the text: one line at the end, `github.attribution` in config.json (default
// "— {project} · {role} (Kanban)"), `github.attributionWithoutRole` when there is no role (Kanban's own comments).
import {
	DEFAULT_GITHUB_ATTRIBUTION,
	DEFAULT_GITHUB_ATTRIBUTION_WITHOUT_ROLE,
	type GitHubSettings,
} from "../config/pipeline-config";
import type { RuntimeCaller } from "../isolation/session-identity";

/** Who posts: the workspace id, and the role (orchestrator, dev, qa, plan, user) or null. */
export interface GitHubPostAuthor {
	project: string;
	role: string | null;
}

type AttributionSettings = Pick<GitHubSettings, "attribution" | "attributionWithoutRole">;

const DEFAULT_SETTINGS: AttributionSettings = {
	attribution: DEFAULT_GITHUB_ATTRIBUTION,
	attributionWithoutRole: DEFAULT_GITHUB_ATTRIBUTION_WITHOUT_ROLE,
};

/** One line: placeholders filled, newlines folded so the line can't grow into more text. */
export function formatAttributionLine(
	author: GitHubPostAuthor,
	settings: AttributionSettings = DEFAULT_SETTINGS,
): string {
	const template = author.role ? settings.attribution : settings.attributionWithoutRole;
	return template
		.replaceAll("{project}", author.project)
		.replaceAll("{role}", author.role ?? "")
		.replace(/\s*[\r\n]+\s*/gu, " ")
		.trim();
}

/** The body with the attribution as its last line (not added twice when the body already ends with it). */
export function appendAttribution(
	body: string,
	author: GitHubPostAuthor,
	settings: AttributionSettings = DEFAULT_SETTINGS,
): string {
	const line = formatAttributionLine(author, settings);
	const trimmed = body.replace(/\s+$/u, "");
	if (trimmed.endsWith(line)) {
		return trimmed;
	}
	return trimmed ? `${trimmed}\n\n${line}` : line;
}

/**
 * The role named in the line for a caller: the orchestrator, a card's role (`cardRole`, from resolveCardRole), or
 * the user; null for anything else.
 */
export function describePosterRole(caller: RuntimeCaller, cardRole: string | null): string | null {
	if (caller.kind === "user") {
		return "user";
	}
	if (caller.kind === "session") {
		return caller.session.role === "orchestrator" ? "orchestrator" : cardRole;
	}
	return null;
}
