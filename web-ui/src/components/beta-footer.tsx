import { ExternalLink, Info } from "lucide-react";

const GITHUB_ISSUES_URL = "https://github.com/vombor/kanban/issues";

/** The app-wide beta notice: a thin bar below the board and the sidebar. The layout reserves its height. */
export function BetaFooter(): React.ReactElement {
	return (
		<footer className="flex h-7 shrink-0 items-center gap-2 border-t border-border bg-surface-1 px-3 text-xs text-text-secondary">
			<Info size={12} className="shrink-0 text-text-tertiary" />
			<p className="m-0 min-w-0 flex-1 truncate">Kanban is in beta. Help us improve by sharing your experience.</p>
			<a
				href={GITHUB_ISSUES_URL}
				target="_blank"
				rel="noreferrer"
				className="flex shrink-0 items-center gap-1 rounded-sm font-semibold text-text-secondary no-underline hover:text-text-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-focus"
			>
				Report issue <ExternalLink size={11} />
			</a>
		</footer>
	);
}
