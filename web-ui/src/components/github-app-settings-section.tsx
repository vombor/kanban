import { ExternalLink, Github } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { type GitHubAppInfo, useGitHubAppCreation } from "@/runtime/use-github-app-creation";

function TextLink({ href, children }: { href: string; children: string }): ReactElement {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-1 text-accent hover:text-accent-hover"
		>
			{children}
			<ExternalLink size={12} />
		</a>
	);
}

function AppSummary({ app }: { app: GitHubAppInfo }): ReactElement {
	return (
		<div className="text-[13px] text-text-secondary space-y-1">
			<p className="m-0">
				Agents file and comment on GitHub issues as <span className="text-text-primary">{app.slug}[bot]</span>{" "}
				(owner {app.ownerLogin}).
			</p>
			<p className="m-0 flex flex-wrap gap-x-4 gap-y-1">
				<TextLink href={app.installUrl}>Install (All repositories)</TextLink>
				<TextLink href={app.settingsUrl}>App settings (logo)</TextLink>
			</p>
		</div>
	);
}

/**
 * The machine's Kanban GitHub App in the settings dialog (docs/fork/github-bots.md): the app if there is one, and
 * the user's way to create it from the browser, on the address this page is open on, so GitHub's redirects come
 * back to it.
 */
export function GitHubAppSettingsSection({ enabled }: { enabled: boolean }): ReactElement {
	const { app, phase, startUrl, error, start } = useGitHubAppCreation(enabled);
	const busy = phase === "starting" || phase === "waiting";
	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
			{app ? (
				<AppSummary app={app} />
			) : (
				<p className="text-[13px] text-text-secondary m-0">
					No Kanban GitHub App on this machine yet: agents' issues and comments go out with the user's PAT.
				</p>
			)}
			{phase === "created" && app ? (
				<p className="text-[13px] text-status-green mt-2 mb-0">
					Created {app.slug}. Install it on your repositories to finish.
				</p>
			) : null}
			<div className="flex items-center gap-2 mt-3">
				<Button size="sm" icon={<Github size={14} />} onClick={start} disabled={busy}>
					{app ? "Create a new Kanban GitHub App" : "Create Kanban GitHub App"}
				</Button>
				{busy ? <Spinner size={14} /> : null}
			</div>
			{app && !busy ? (
				<p className="text-text-tertiary text-[12px] mt-1 mb-0">
					A new app replaces {app.slug} in Kanban; delete the old one on GitHub.
				</p>
			) : null}
			{phase === "waiting" && startUrl ? (
				<p className="text-[13px] text-text-secondary mt-2 mb-0">
					Waiting for GitHub: click <b>Create GitHub App</b> in the new tab. No tab?{" "}
					<TextLink href={startUrl}>Open GitHub</TextLink>
				</p>
			) : null}
			{phase === "error" && error ? <p className="text-[13px] text-status-red mt-2 mb-0">{error}</p> : null}
			<p className="text-text-tertiary text-[12px] mt-2 mb-0">
				GitHub sends you back to {window.location.origin}. Issues read/write and Metadata read only, no webhook.
			</p>
		</div>
	);
}
