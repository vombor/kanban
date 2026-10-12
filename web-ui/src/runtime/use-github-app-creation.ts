import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useInterval, useUnmount } from "@/utils/react-use";

type GitHubAppStatus = Awaited<ReturnType<ReturnType<typeof getRuntimeTrpcClient>["github"]["appStatus"]["query"]>>;
export type GitHubAppInfo = NonNullable<GitHubAppStatus["app"]>;

/** How often the browser asks whether GitHub sent the new app back (the CLI waits the same way). */
export const GITHUB_APP_WAIT_POLL_MS = 3_000;
/** The start link's lifetime on the server (app-manifest.ts STATE_TTL_MS): no point waiting longer. */
export const GITHUB_APP_WAIT_LIMIT_MS = 60 * 60 * 1000;

export type GitHubAppCreationPhase = "idle" | "starting" | "waiting" | "created" | "error";

export interface UseGitHubAppCreationResult {
	/** The machine's app as the server knows it (null: none yet, or not loaded). */
	app: GitHubAppInfo | null;
	phase: GitHubAppCreationPhase;
	/** The start page on this page's origin, while waiting (a link in case the new tab was blocked). */
	startUrl: string | null;
	error: string | null;
	/** Starts the app manifest flow on this page's origin; call it from the click itself (it opens a tab). */
	start: () => void;
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The browser's way to create the Kanban GitHub App (docs/fork/github-bots.md): the same route as
 * `kanban github bot create` (tRPC github.startAppCreation, the user's only), on the origin this page is open on, so
 * GitHub sends the user back to an address their browser reaches. The tab is opened in the click, before the
 * server answers, because Safari blocks a window.open that comes after an await.
 */
export function useGitHubAppCreation(enabled: boolean): UseGitHubAppCreationResult {
	const [app, setApp] = useState<GitHubAppInfo | null>(null);
	const [phase, setPhase] = useState<GitHubAppCreationPhase>("idle");
	const [startUrl, setStartUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const sinceRef = useRef(0);
	const mountedRef = useRef(true);
	useUnmount(() => {
		mountedRef.current = false;
	});

	useEffect(() => {
		if (!enabled) {
			return;
		}
		let cancelled = false;
		void getRuntimeTrpcClient(null)
			.github.appStatus.query()
			.then((status) => {
				if (!cancelled && status.ok) {
					setApp(status.app);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [enabled]);

	useInterval(
		() => {
			if (Date.now() - sinceRef.current > GITHUB_APP_WAIT_LIMIT_MS) {
				setPhase("error");
				setError("No app was created while the link was valid. Start again.");
				return;
			}
			void getRuntimeTrpcClient(null)
				.github.appStatus.query()
				.then((status) => {
					if (!mountedRef.current || !status.app || Date.parse(status.app.createdAt) < sinceRef.current) {
						return;
					}
					setApp(status.app);
					setPhase("created");
					setStartUrl(null);
				})
				.catch(() => undefined);
		},
		phase === "waiting" ? GITHUB_APP_WAIT_POLL_MS : null,
	);

	const start = useCallback(() => {
		const tab = window.open("", "_blank");
		sinceRef.current = Date.now();
		setPhase("starting");
		setError(null);
		setStartUrl(null);
		void getRuntimeTrpcClient(null)
			.github.startAppCreation.mutate({ origin: window.location.origin, org: null })
			.then((started) => {
				if (!started.ok || !started.startUrl) {
					throw new Error(started.error ?? "The server refused to start the app creation.");
				}
				if (tab) {
					tab.opener = null;
					tab.location.href = started.startUrl;
				}
				if (mountedRef.current) {
					setStartUrl(started.startUrl);
					setPhase("waiting");
				}
			})
			.catch((startError: unknown) => {
				tab?.close();
				if (mountedRef.current) {
					setPhase("error");
					setError(toMessage(startError));
				}
			});
	}, []);

	return { app, phase, startUrl, error, start };
}
