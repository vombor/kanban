// What one sync does with the fetched issues, as pure decisions against the board and the imported records:
//
//   - a new issue (no card with its provider+repo+number anywhere on the board, Done included, and no import record,
//     since prune-done deletes old Done cards) that passes the trust filter becomes one Backlog card; with the plan
//     label and the kit's plan role on, a plan card;
//   - an imported issue that changed since the last sync: while its card is in Backlog, its prompt gets an
//     "Update <date>" section (and a "closed upstream" marker when it was closed); once the card was started, its
//     prompt is never touched: the change is a note for the log and the orchestrator's next wake;
//   - nothing is ever deleted, and no card is ever started.
//
// The apply step (issue-apply.ts) runs this again under the board lock, so a card created meanwhile is never doubled.
import { createHash } from "node:crypto";

import type { IssueProviderId, WorkspaceIssuesSettings } from "../config/pipeline-config";
import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeBoardData, RuntimeTaskIssue } from "../core/api-contract";
import {
	appendIssueSection,
	buildIssueCardPrompt,
	buildIssueCardTitle,
	buildIssueClosedSection,
	buildIssueReopenedSection,
	buildIssueUpdateSection,
	CLOSED_UPSTREAM_TITLE_PREFIX,
	hasIssueUpdateContent,
	type IssueUpdateChanges,
	splitTrustedComments,
} from "./issue-prompt";
import { type FetchedIssue, issueKey } from "./issue-provider";
import type { ImportedIssueRecord } from "./issue-state";
import { evaluateIssueTrust, type IssueSkipReason, isIssueStillTrusted, isTrustedAssociation } from "./issue-trust";

export function hashIssueBody(body: string): string {
	return createHash("sha256").update(body.replace(/\r\n?/gu, "\n").trim()).digest("hex");
}

export interface IssueSyncPlanInput {
	provider: IssueProviderId;
	repo: string;
	settings: Pick<WorkspaceIssuesSettings, "filter" | "planLabel">;
	/** Whether the project's kit makes plan cards (its plan role is enabled). */
	planEnabled: boolean;
	board: RuntimeBoardData;
	records: Readonly<Record<string, ImportedIssueRecord>>;
	issues: readonly FetchedIssue[];
}

interface ActionBase {
	key: string;
	issue: FetchedIssue;
}

export type IssueSyncAction =
	| (ActionBase & {
			kind: "create";
			title: string;
			prompt: string;
			asPlan: boolean;
			cardIssue: RuntimeTaskIssue;
			/** Why the plan label didn't make a plan card, if it didn't. */
			planNote: string | null;
			via: string;
	  })
	/** A Backlog card's prompt (and maybe title) changes: an update, closed upstream or reopened. */
	| (ActionBase & {
			kind: "update";
			change: "updated" | "closed" | "reopened";
			taskId: string;
			title: string;
			prompt: string;
			cardIssue: RuntimeTaskIssue;
			record: ImportedIssueRecord;
			note: string;
	  })
	/** A started (or Done, or pruned) card's issue changed: logged, and for started cards a wake note. */
	| (ActionBase & {
			kind: "note";
			taskId: string;
			column: RuntimeBoardColumnId | null;
			record: ImportedIssueRecord;
			note: string;
			wake: boolean;
	  })
	| (ActionBase & { kind: "skip"; reason: IssueSkipReason; detail: string });

export function toCardIssue(
	issue: Pick<FetchedIssue, "number" | "url" | "updatedAt">,
	context: { provider: IssueProviderId; repo: string },
	closedAt: string | null = null,
): RuntimeTaskIssue {
	return {
		provider: context.provider,
		repo: context.repo,
		number: issue.number,
		url: issue.url,
		updatedAt: issue.updatedAt,
		...(closedAt ? { closedAt } : {}),
	};
}

export function buildImportedRecord(
	issue: FetchedIssue,
	context: { provider: IssueProviderId; repo: string; taskId: string; importedAt: string; plan: boolean },
): ImportedIssueRecord {
	return {
		number: issue.number,
		repo: context.repo,
		provider: context.provider,
		taskId: context.taskId,
		importedAt: context.importedAt,
		seenUpdatedAt: issue.updatedAt,
		title: issue.title,
		bodySha: hashIssueBody(issue.body),
		commentIds: issue.comments.map((comment) => comment.id),
		closed: issue.state === "closed",
		plan: context.plan,
	};
}

/** Every card that came from an issue, by issueKey(). */
export function indexIssueCards(
	board: RuntimeBoardData,
): Map<string, { card: RuntimeBoardCard; column: RuntimeBoardColumnId }> {
	const cards = new Map<string, { card: RuntimeBoardCard; column: RuntimeBoardColumnId }>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.issue) {
				cards.set(issueKey(card.issue), { card, column: column.id });
			}
		}
	}
	return cards;
}

function hasLabel(issue: FetchedIssue, label: string): boolean {
	return issue.labels.some((candidate) => candidate.toLowerCase() === label.toLowerCase());
}

function isNewer(issue: FetchedIssue, seen: string): boolean {
	return Date.parse(issue.updatedAt) > Date.parse(seen);
}

const COLUMN_LABELS: Record<RuntimeBoardColumnId, string> = {
	backlog: "Backlog",
	in_progress: "In Progress",
	review: "Review",
	trash: "Done",
};

function describeChanges(changes: IssueUpdateChanges): string {
	const parts = [
		...(changes.title !== null ? ["retitled"] : []),
		...(changes.body !== null ? ["description edited"] : []),
		...(changes.untrustedEdit ? ["edited by its untrusted author (not copied)"] : []),
		...(changes.comments.length > 0 ? [`${changes.comments.length} new comment(s)`] : []),
		...(changes.omittedComments > 0 ? [`${changes.omittedComments} new untrusted comment(s) omitted`] : []),
	];
	return parts.join(", ") || "updated (no change Kanban shows)";
}

export function planIssueSync(input: IssueSyncPlanInput): IssueSyncAction[] {
	const context = { provider: input.provider, repo: input.repo };
	const cards = indexIssueCards(input.board);
	const actions: IssueSyncAction[] = [];
	for (const issue of input.issues) {
		if (issue.isPullRequest) {
			continue;
		}
		const key = issueKey({ ...context, number: issue.number });
		const onBoard = cards.get(key) ?? null;
		const recorded = input.records[key] ?? null;

		if (!onBoard && !recorded) {
			const trust = evaluateIssueTrust(issue, input.settings.filter);
			if (!trust.import) {
				actions.push({ kind: "skip", key, issue, reason: trust.reason, detail: trust.detail });
				continue;
			}
			const labelled = hasLabel(issue, input.settings.planLabel);
			const asPlan = labelled && input.planEnabled;
			actions.push({
				kind: "create",
				key,
				issue,
				title: buildIssueCardTitle(issue, input.settings.filter),
				prompt: buildIssueCardPrompt(issue, { ...context, filter: input.settings.filter }),
				asPlan,
				cardIssue: toCardIssue(issue, context),
				planNote:
					labelled && !asPlan
						? `has the plan label "${input.settings.planLabel}" but this project's kit has no plan role: created as a dev card`
						: null,
				via: trust.detail,
			});
			continue;
		}

		// A card without an import record (the state file was lost): its `issue` field is the baseline.
		const baseline: ImportedIssueRecord = recorded ?? {
			number: issue.number,
			repo: input.repo,
			provider: input.provider,
			taskId: onBoard?.card.id ?? "",
			importedAt: onBoard?.card.issue?.updatedAt ?? issue.createdAt,
			seenUpdatedAt: onBoard?.card.issue?.updatedAt ?? issue.updatedAt,
			title: issue.title,
			bodySha: hashIssueBody(issue.body),
			commentIds: issue.comments
				.filter((comment) => Date.parse(comment.createdAt) <= Date.parse(onBoard?.card.issue?.updatedAt ?? ""))
				.map((comment) => comment.id),
			closed: Boolean(onBoard?.card.issue?.closedAt),
			plan: onBoard?.card.role === "plan",
		};
		if (!isNewer(issue, baseline.seenUpdatedAt)) {
			continue;
		}
		const taskId = onBoard?.card.id ?? baseline.taskId;
		const known = new Set(baseline.commentIds);
		const filter = input.settings.filter;
		// No text at all once the issue lost its trust (its trust label was removed); a trusted author's own edits are
		// copied, an untrusted author's only noted (GitHub doesn't say who edited), and only trusted people's comments.
		const stillTrusted = isIssueStillTrusted(issue, filter);
		const authorTrusted = isTrustedAssociation(issue.authorAssociation, filter);
		const titleChanged = issue.title !== baseline.title;
		const bodyChanged = hashIssueBody(issue.body) !== baseline.bodySha;
		const fresh = splitTrustedComments(
			issue.comments.filter((comment) => !known.has(comment.id)),
			filter,
		);
		const changes: IssueUpdateChanges = stillTrusted
			? {
					title: authorTrusted && titleChanged ? issue.title : null,
					body: authorTrusted && bodyChanged ? issue.body : null,
					untrustedEdit: !authorTrusted && (titleChanged || bodyChanged),
					comments: fresh.trusted,
					omittedComments: fresh.omitted,
				}
			: { title: null, body: null, untrustedEdit: false, comments: [], omittedComments: 0 };
		const untrustedNow = !stillTrusted && (titleChanged || bodyChanged || fresh.trusted.length + fresh.omitted > 0);
		const closed = issue.state === "closed";
		const closedNow = closed && !baseline.closed;
		const reopened = !closed && baseline.closed;
		const record: ImportedIssueRecord = {
			...baseline,
			taskId,
			seenUpdatedAt: issue.updatedAt,
			title: issue.title,
			bodySha: hashIssueBody(issue.body),
			commentIds: [...new Set([...baseline.commentIds, ...issue.comments.map((comment) => comment.id)])],
			closed,
		};
		const hasContent = hasIssueUpdateContent(changes);
		const what = [
			...(hasContent ? [describeChanges(changes)] : []),
			...(untrustedNow ? ["changed, but it is no longer trusted (no trust label): its text is not copied"] : []),
			...(closedNow ? ["closed upstream"] : []),
			...(reopened ? ["reopened upstream"] : []),
		].join("; ");

		if (onBoard?.column === "backlog") {
			let prompt = onBoard.card.prompt;
			if (hasContent) {
				prompt = appendIssueSection(prompt, buildIssueUpdateSection(issue, changes, input.provider));
			}
			if (closedNow) {
				prompt = appendIssueSection(prompt, buildIssueClosedSection(issue));
			}
			if (reopened) {
				prompt = appendIssueSection(prompt, buildIssueReopenedSection(issue));
			}
			// The title follows the issue only while nobody renamed the card.
			const currentTitle = onBoard.card.title ?? "";
			const previous = { number: issue.number, title: baseline.title, authorAssociation: issue.authorAssociation };
			const generated = new Set([
				buildIssueCardTitle(previous, filter, false),
				buildIssueCardTitle(previous, filter, true),
			]);
			const baseTitle = generated.has(currentTitle)
				? buildIssueCardTitle(stillTrusted ? issue : previous, filter, false)
				: currentTitle.startsWith(CLOSED_UPSTREAM_TITLE_PREFIX)
					? currentTitle.slice(CLOSED_UPSTREAM_TITLE_PREFIX.length)
					: currentTitle;
			const title = (closed ? `${CLOSED_UPSTREAM_TITLE_PREFIX}${baseTitle}` : baseTitle).slice(0, 200);
			if (prompt === onBoard.card.prompt && title === currentTitle) {
				// Only the timestamp moved (a label change, a reaction): remember it, change nothing on the card.
				actions.push({
					kind: "note",
					key,
					issue,
					taskId,
					column: "backlog",
					record,
					note: untrustedNow
						? `issue #${issue.number} (card ${taskId}, Backlog) ${what}`
						: `issue #${issue.number} (card ${taskId}, Backlog) changed upstream without new text`,
					wake: false,
				});
				continue;
			}
			actions.push({
				kind: "update",
				key,
				issue,
				change: closedNow ? "closed" : reopened ? "reopened" : "updated",
				taskId,
				title,
				prompt,
				cardIssue: toCardIssue(issue, context, closed ? (issue.closedAt ?? issue.updatedAt) : null),
				record,
				note: `issue #${issue.number} (card ${taskId}, Backlog): ${what}; prompt updated`,
			});
			continue;
		}

		const column = onBoard?.column ?? null;
		const where = column
			? `card ${taskId}, ${COLUMN_LABELS[column]}`
			: `card ${taskId || "?"}, no longer on the board`;
		// A Done card's issue closing is the expected end (Fixes #N); anything else on a Done or started card is news.
		const onlyClosedAfterDone = column === "trash" && closedNow && !hasContent;
		actions.push({
			kind: "note",
			key,
			issue,
			taskId,
			column,
			record,
			note: `issue #${issue.number} (${where}) ${what || "changed"} upstream: ${issue.url}`,
			wake: column !== null && !onlyClosedAfterDone && (column !== "trash" || hasContent || reopened),
		});
	}
	return actions;
}
