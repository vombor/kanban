import { ExternalLink, Info } from "lucide-react";

const GITHUB_ISSUES_URL = "https://github.com/vombor/kanban/issues";

/**
 * The app-wide footer: a thin bar below the board and the sidebar. The layout reserves its height.
 * Left: the beta notice and the Report issue link right after it; right: the Kanban version.
 * On a narrow screen the notice truncates first, so the link and the version stay visible.
 */
export function BetaFooter(): React.ReactElement {
	return (
		<footer className="flex h-7 shrink-0 items-center gap-2 border-t border-border bg-surface-1 px-3 text-xs text-text-secondary">
			<Info size={12} className="shrink-0 text-text-tertiary" />
			<p className="m-0 min-w-0 truncate">Kanban is in beta. Help us improve by sharing your experience.</p>
			<a
				href={GITHUB_ISSUES_URL}
				target="_blank"
				rel="noreferrer"
				className="flex shrink-0 items-center gap-1 rounded-sm font-semibold text-text-secondary no-underline hover:text-text-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-focus"
			>
				Report issue <ExternalLink size={11} />
			</a>
			<span className="ml-auto shrink-0 pl-2 text-[11px] text-text-tertiary" data-testid="app-version">
				v{__APP_VERSION__}
			</span>
		</footer>
	);
}
