// One issue sync of one workspace: the pipeline worker's periodic job (issue-job.ts) and `kanban issues sync` both run
// this. It resolves the project's own repository (issue-repo.ts), the auth (issue-auth.ts) and waits out a rate
// limit; lists the issues updated since the cursor (conditional requests through the HTTP cache), fetches the
// comments of the issues that may become or already are cards, and then
//
//   report: plans against the board and logs what it would do (stage `issues` in the decision log); the cursor
//           doesn't move, so turning `on` later still sees every issue;
//   on:     hands the issues to the apply step (the server's `applyIssues` request, or in-process for the CLI),
//           moves the cursor, keeps started cards' updates for the orchestrator's next wake and wakes the
//           orchestrator with "N new issue card(s)" through `kanban orchestrator wake`'s request file.
import type { IssueProviderId, ParsedPipelineConfig, WorkspaceIssuesSettings } from "../config/pipeline-config";
import { getWorkspacePipelineSettings, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeBoardData } from "../core/api-contract";
import { type KitCatalog, loadKitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import {
	createPipelineDecisionLog,
	type PipelineDecisionLog,
	type PipelineDecisionRecord,
} from "../pipeline/decision-log";
import { addWakeRequest } from "../pipeline/watchdog/wake-requests";
import { getIssueWorkspacePaths, getWatchdogWorkspacePaths } from "../state/kanban-home";
import { createGitHubIssueProvider, createMemoryIssueHttpCache, type IssueFetch } from "./github-provider";
import {
	collectKnownIssueKeys,
	describeIssueSyncActions,
	type IssueApplyInput,
	type IssueApplyResult,
	isPlanRoleEnabled,
} from "./issue-apply";
import { type IssueAuth, resolveGitHubAuth } from "./issue-auth";
import { type FetchedIssue, type IssueProvider, IssueProviderRateLimitError, issueKey } from "./issue-provider";
import { type GitRemote, listGitRemotes, resolvePinnedIssueRepo } from "./issue-repo";
import {
	type IssueLastSync,
	IssueStateCorruptError,
	type IssueSyncState,
	type PinnedIssueRepo,
	readIssueHttpCache,
	readIssueSyncState,
	updateIssueSyncState,
	writeIssueHttpCache,
} from "./issue-state";
import { planIssueSync } from "./issue-sync-plan";
import { evaluateIssueTrust } from "./issue-trust";

const MIN = 60_000;
/** A rate limit backs off at least 1, 2, 4, ... minutes per consecutive hit, up to an hour. */
const MAX_BACKOFF_MIN = 60;

export type IssueSyncMode = "report" | "on";

export interface IssueSyncDependencies {
	readConfig?: () => Promise<ParsedPipelineConfig>;
	loadCatalog?: () => Promise<KitCatalog>;
	listRemotes?: (repoPath: string) => Promise<GitRemote[]>;
	resolveAuth?: (provider: IssueProviderId) => Promise<IssueAuth>;
	/** Builds the provider (tests pass a fake GitHub through `fetch` or a whole provider). */
	createProvider?: (input: {
		provider: IssueProviderId;
		auth: IssueAuth;
		cache: ReturnType<typeof createMemoryIssueHttpCache>;
	}) => IssueProvider;
	fetch?: IssueFetch;
	apiOrigin?: string;
	getPaths?: (workspaceId: string) => { state: string; httpCache: string; wakeRequests: string };
	decisionLog?: PipelineDecisionLog;
	now?: () => number;
}

export interface IssueSyncInput {
	workspaceId: string;
	workspacePath: string;
	mode: IssueSyncMode;
	/** The workspace's board as it is now (report mode plans against it; both use it to pick comment fetches). */
	readBoard: () => Promise<RuntimeBoardData>;
	/** Mode `on`: applies the fetched issues (the server's `applyIssues`, or applyIssueSync in-process). */
	apply: (input: IssueApplyInput) => Promise<IssueApplyResult>;
	/** Wakes the orchestrator for new cards (mode `on`); default: a `kanban orchestrator wake` request. */
	wake?: (text: string) => Promise<void>;
}

export interface IssueSyncOutcome {
	ok: boolean;
	mode: IssueSyncMode;
	repo: string | null;
	authSource: IssueAuth["source"] | null;
	summary: string;
	error: string | null;
	result: IssueApplyResult | null;
	backoffUntil: string | null;
}

function defaultPaths(workspaceId: string) {
	return { ...getIssueWorkspacePaths(workspaceId), wakeRequests: getWatchdogWorkspacePaths(workspaceId).wakeRequests };
}

/** What the cursor is valid for: a new repository, filter or plan label starts a full scan of the open issues. */
export function buildIssueSourceKey(
	provider: IssueProviderId,
	repo: string,
	settings: Pick<WorkspaceIssuesSettings, "filter" | "planLabel">,
): string {
	return JSON.stringify({
		provider,
		repo: repo.toLowerCase(),
		filter: settings.filter,
		planLabel: settings.planLabel,
	});
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const item of items) {
		counts[key(item)] = (counts[key(item)] ?? 0) + 1;
	}
	return counts;
}

export function summarizeIssueResult(result: IssueApplyResult, mode: IssueSyncMode): string {
	const verb = mode === "report" ? "would " : "";
	const skipped = countBy(result.skipped, (entry) => entry.reason);
	return [
		`${verb}create ${result.created.length}`,
		`${verb}update ${result.updated.length}`,
		`${result.notes.length} note(s)`,
		`skipped ${result.skipped.length}${
			result.skipped.length
				? ` (${Object.entries(skipped)
						.map(([reason, count]) => `${reason} ${count}`)
						.join(", ")})`
				: ""
		}`,
		...(result.deduped.length ? [`already on the board ${result.deduped.length}`] : []),
	].join(", ");
}

export function buildNewIssueCardsWakeText(repo: string, created: IssueApplyResult["created"]): string {
	const list = created.map((card) => `#${card.number} → ${card.taskId}${card.plan ? " (plan card)" : ""}`).join(", ");
	return `${created.length} new issue card(s) from ${repo} in Backlog (${list}); decide which to start (they are never started automatically)`;
}

export async function runIssueSync(input: IssueSyncInput, deps: IssueSyncDependencies = {}): Promise<IssueSyncOutcome> {
	const now = deps.now ?? Date.now;
	const readConfig = deps.readConfig ?? (async () => await readPipelineConfig());
	const loadCatalog = deps.loadCatalog ?? (async () => await loadKitCatalog());
	const paths = (deps.getPaths ?? defaultPaths)(input.workspaceId);
	const decisionLog = deps.decisionLog ?? createPipelineDecisionLog();
	const startedAt = now();
	const at = new Date(startedAt).toISOString();

	const [{ config }, catalog] = await Promise.all([readConfig(), loadCatalog()]);
	const workspace = getWorkspacePipelineSettings(config, input.workspaceId);
	const settings = workspace.issues;
	const kitName = resolveWorkspaceKit(config, input.workspaceId, catalog).kitName;

	const decision = (
		entry: Pick<PipelineDecisionRecord, "taskId" | "outcome" | "note"> & {
			role?: PipelineDecisionRecord["role"];
			answer?: unknown;
		},
	): PipelineDecisionRecord => ({
		at,
		workspaceId: input.workspaceId,
		taskId: entry.taskId,
		stage: "issues",
		kit: kitName,
		landingMode: workspace.landing.mode,
		shadow: workspace.pipeline.shadow,
		effectiveAgent: null,
		model: null,
		role: entry.role ?? null,
		answer: entry.answer ?? null,
		outcome: entry.outcome,
		note: entry.note,
	});

	const finish = async (
		outcome: Omit<IssueSyncOutcome, "mode">,
		extra: {
			records?: PipelineDecisionRecord[];
			skippedCounts?: Record<string, number>;
			/** issues-state.json can't be parsed: nothing may be written to it. */
			stateUnreadable?: boolean;
		} = {},
	): Promise<IssueSyncOutcome> => {
		const lastSync: IssueLastSync = {
			at,
			ok: outcome.ok,
			mode: input.mode,
			repo: outcome.repo,
			authSource: outcome.authSource,
			summary: outcome.summary,
			error: outcome.error,
			created: input.mode === "on" ? (outcome.result?.created.length ?? 0) : 0,
			updated: input.mode === "on" ? (outcome.result?.updated.length ?? 0) : 0,
			closed:
				input.mode === "on"
					? (outcome.result?.updated.filter((entry) => entry.change === "closed").length ?? 0)
					: 0,
			skipped: extra.skippedCounts ?? {},
		};
		if (!extra.stateUnreadable) {
			await updateIssueSyncState(paths.state, (state) => ({ state: { ...state, lastSync }, value: null }), now());
		}
		await decisionLog
			.append([
				...(extra.records ?? []),
				decision({
					taskId: null,
					outcome: !outcome.ok ? "failed" : input.mode === "report" ? "report" : "acted",
					note: `issue sync (${input.mode}) ${outcome.repo ?? "?"} via ${outcome.authSource ?? "?"}: ${outcome.error ?? outcome.summary}`,
				}),
			])
			.catch(() => {});
		return { ...outcome, mode: input.mode };
	};

	let state: IssueSyncState;
	try {
		state = await readIssueSyncState(paths.state);
	} catch (error) {
		return await finish(
			{
				ok: false,
				repo: null,
				authSource: null,
				summary: "state unreadable",
				error: error instanceof Error ? error.message : String(error),
				result: null,
				backoffUntil: null,
			},
			{ stateUnreadable: error instanceof IssueStateCorruptError },
		);
	}
	const remotes = await (deps.listRemotes ?? listGitRemotes)(input.workspacePath);
	const repo = resolvePinnedIssueRepo({
		provider: settings.provider,
		configured: settings.repo,
		remotes,
		pinned: state.pinnedRepo,
	});
	if (!repo.ok) {
		return await finish({
			ok: false,
			repo: null,
			authSource: null,
			summary: "refused",
			error: repo.error,
			result: null,
			backoffUntil: null,
		});
	}

	if (repo.pin) {
		const pinnedRepo: PinnedIssueRepo = { provider: settings.provider, repo: repo.repo, at, source: repo.source };
		await updateIssueSyncState(paths.state, (current) => ({ state: { ...current, pinnedRepo }, value: null }), now());
	}
	const backoffUntil = state.backoff.until ? Date.parse(state.backoff.until) : 0;
	if (backoffUntil > startedAt) {
		// Nothing is sent while the provider asked us to wait; this isn't logged as a sync.
		return {
			ok: true,
			mode: input.mode,
			repo: repo.repo,
			authSource: null,
			summary: `rate limited: waiting until ${state.backoff.until}`,
			error: null,
			result: null,
			backoffUntil: state.backoff.until,
		};
	}

	const auth = await (deps.resolveAuth ?? (async () => await resolveGitHubAuth()))(settings.provider);
	const cache = createMemoryIssueHttpCache(await readIssueHttpCache(paths.httpCache), now);
	const provider = deps.createProvider
		? deps.createProvider({ provider: settings.provider, auth, cache })
		: createGitHubIssueProvider({ token: auth.token, cache, fetch: deps.fetch, apiOrigin: deps.apiOrigin, now });
	const sourceKey = buildIssueSourceKey(settings.provider, repo.repo, settings);
	const since = state.sourceKey === sourceKey ? state.since : null;

	let fetched: FetchedIssue[];
	const reportSeen: Record<string, string> = {};
	let board: RuntimeBoardData;
	try {
		const listed = await provider.listIssues({ repo: repo.repo, state: since ? "all" : "open", since });
		board = await input.readBoard();
		const known = collectKnownIssueKeys(board, state.issues);
		fetched = [];
		for (const issue of listed) {
			if (issue.isPullRequest) {
				continue;
			}
			const key = issueKey({ provider: settings.provider, repo: repo.repo, number: issue.number });
			const isKnown = known.has(key);
			let wanted = isKnown || evaluateIssueTrust(issue, settings.filter).import;
			// Report doesn't move the cursor, so it sees the same issues every poll: it fetches an issue's comments
			// only when the issue changed since it last did.
			if (wanted && input.mode === "report") {
				const seen = state.issues[key]?.seenUpdatedAt ?? state.reportSeen[key];
				wanted = !seen || Date.parse(issue.updatedAt) > Date.parse(seen);
				reportSeen[key] = issue.updatedAt;
			}
			const comments = wanted && issue.commentCount > 0 ? await provider.listComments(repo.repo, issue.number) : [];
			fetched.push({ ...issue, comments });
		}
	} catch (error) {
		if (cache.changed()) {
			await writeIssueHttpCache(paths.httpCache, cache.entries(), now()).catch(() => {});
		}
		const rateLimited = error instanceof IssueProviderRateLimitError;
		const step = rateLimited ? state.backoff.step + 1 : state.backoff.step;
		const until = rateLimited
			? new Date(Math.max(error.until, startedAt + Math.min(2 ** (step - 1), MAX_BACKOFF_MIN) * MIN)).toISOString()
			: null;
		if (rateLimited) {
			await updateIssueSyncState(paths.state, (current) => ({
				state: { ...current, backoff: { until, step } },
				value: null,
			}));
		}
		return await finish({
			ok: false,
			repo: repo.repo,
			authSource: auth.source,
			summary: rateLimited ? "rate limited" : "fetch failed",
			error: `${error instanceof Error ? error.message : String(error)}${until ? ` (backing off until ${until})` : ""}`,
			result: null,
			backoffUntil: until,
		});
	}
	if (cache.changed()) {
		await writeIssueHttpCache(paths.httpCache, cache.entries(), now());
	}

	const planEnabled = isPlanRoleEnabled(config, input.workspaceId, catalog);
	let result: IssueApplyResult;
	if (input.mode === "report") {
		result = describeIssueSyncActions(
			planIssueSync({
				provider: settings.provider,
				repo: repo.repo,
				settings,
				planEnabled,
				board,
				records: state.issues,
				issues: fetched,
			}),
		);
	} else {
		try {
			result = await input.apply({
				workspaceId: input.workspaceId,
				workspacePath: input.workspacePath,
				provider: settings.provider,
				repo: repo.repo,
				issues: fetched,
			});
		} catch (error) {
			return await finish({
				ok: false,
				repo: repo.repo,
				authSource: auth.source,
				summary: "apply failed",
				error: error instanceof Error ? error.message : String(error),
				result: null,
				backoffUntil: null,
			});
		}
	}

	const outcome = input.mode === "report" ? "report" : "acted";
	const previouslySkipped = state.skipped;
	const records: PipelineDecisionRecord[] = [
		...result.created.map((card) =>
			decision({
				taskId: card.taskId || null,
				role: card.plan ? "plan" : "dev",
				outcome,
				answer: { issue: card.number, action: "create", plan: card.plan },
				note: `${input.mode === "report" ? "would import" : "imported"} issue #${card.number} as ${card.plan ? "a plan" : "a dev"} card${card.taskId ? ` ${card.taskId}` : ""} in Backlog: ${card.title}${card.note ? ` (${card.note})` : ""}`,
			}),
		),
		...result.updated.map((entry) =>
			decision({
				taskId: entry.taskId,
				outcome,
				answer: { issue: entry.number, action: entry.change },
				note: input.mode === "report" ? `would: ${entry.note}` : entry.note,
			}),
		),
		...result.notes.map((entry) =>
			decision({
				taskId: entry.taskId || null,
				outcome: "none",
				answer: { issue: entry.number, action: "note", wake: entry.wake },
				note: entry.note,
			}),
		),
		// A skipped issue is logged once per version of it, not on every poll.
		...result.skipped
			.filter((entry) => {
				const key = issueKey({ provider: settings.provider, repo: repo.repo, number: entry.number });
				const issue = fetched.find((candidate) => candidate.number === entry.number);
				return (
					previouslySkipped[key]?.updatedAt !== issue?.updatedAt || previouslySkipped[key]?.reason !== entry.reason
				);
			})
			.map((entry) =>
				decision({
					taskId: null,
					outcome: "none",
					answer: { issue: entry.number, action: "skip", reason: entry.reason },
					note: `skipped issue #${entry.number} (${entry.reason}): ${entry.detail}`,
				}),
			),
	];

	if (input.mode === "on") {
		// The cursor moves past everything handled; a new issue that wasn't created (its routing wasn't resolved
		// before the board changed) keeps the cursor before it, so the next sync sees it again.
		const handled = new Set([...result.created.map((card) => card.number), ...result.deduped]);
		const pending = fetched.filter(
			(issue) =>
				!handled.has(issue.number) &&
				!state.issues[issueKey({ provider: settings.provider, repo: repo.repo, number: issue.number })] &&
				!result.skipped.some((entry) => entry.number === issue.number) &&
				!result.updated.some((entry) => entry.number === issue.number) &&
				!result.notes.some((entry) => entry.number === issue.number),
		);
		const times = (pending.length > 0 ? pending : fetched).map((issue) => Date.parse(issue.updatedAt));
		const nextSince =
			times.length === 0
				? since
				: new Date(pending.length > 0 ? Math.min(...times) : Math.max(...times)).toISOString();
		const wakeNotes = result.notes.filter((entry) => entry.wake).map((entry) => `- ${entry.note}`);
		await updateIssueSyncState(
			paths.state,
			(current) => ({
				state: {
					...current,
					sourceKey,
					since: nextSince,
					backoff: { until: null, step: 0 },
					wakeNotes: [...current.wakeNotes, ...wakeNotes],
				},
				value: null,
			}),
			now(),
		);
		if (result.created.length > 0) {
			const text = buildNewIssueCardsWakeText(repo.repo, result.created);
			await (
				input.wake ??
				(async (issue: string) => void (await addWakeRequest(paths.wakeRequests, { issue, when: null })))
			)(text);
		}
	} else {
		await updateIssueSyncState(
			paths.state,
			(current) => ({
				state: {
					...current,
					backoff: { until: null, step: 0 },
					reportSeen: { ...current.reportSeen, ...reportSeen },
				},
				value: null,
			}),
			now(),
		);
	}

	return await finish(
		{
			ok: true,
			repo: repo.repo,
			authSource: auth.source,
			summary: summarizeIssueResult(result, input.mode),
			error: null,
			result,
			backoffUntil: null,
		},
		{ records, skippedCounts: countBy(result.skipped, (entry) => entry.reason) },
	);
}
