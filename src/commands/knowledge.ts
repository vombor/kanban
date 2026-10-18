// Agent-neutral project discovery/curation. All knowledge access goes through the strict scoped server API.
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Command } from "commander";
import { KANBAN_SESSION_WORKSPACE_ENV } from "../isolation/session-identity";
import {
	KNOWLEDGE_MAX_CONTENT_BYTES,
	type KnowledgeMetadata,
	type KnowledgeMutation,
	knowledgeKindSchema,
	knowledgeRevisionSchema,
} from "../trpc/knowledge-contract";
import { createRuntimeTrpcClient, type RuntimeTrpcClient } from "./runtime-trpc-client";
import { resolveWorkspaceTarget } from "./workspace-target";

interface CommonOptions {
	project?: string;
	json?: boolean;
}
interface WriteOptions extends CommonOptions {
	file: string;
	kind: string;
	title: string;
	summary?: string;
	tag: string[];
	expectedRevision: string;
	requestId?: string;
	reason?: string;
}
const PROJECT_HELP =
	"Workspace id or registered project path. Defaults to the agent session's workspace or the project containing cwd.";

export function parseKnowledgeNumber(value: string): number {
	if (!/^\d+$/u.test(value)) throw new Error("Use a nonnegative integer.");
	const number = Number(value);
	if (!Number.isSafeInteger(number)) throw new Error("The value is too large.");
	return number;
}
export function parseKnowledgeExpectedRevision(value: string): string | null {
	return value === "none" ? null : knowledgeRevisionSchema.parse(value);
}
export async function readKnowledgeMarkdown(file: string): Promise<string> {
	const stream = file === "-" ? process.stdin : createReadStream(file);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of stream) {
		const data = Buffer.from(chunk);
		size += data.length;
		if (size > KNOWLEDGE_MAX_CONTENT_BYTES) {
			stream.destroy();
			throw new Error("Knowledge Markdown exceeds the maximum document size; split it into smaller documents.");
		}
		chunks.push(data);
	}
	return Buffer.concat(chunks).toString("utf8");
}
async function runKnowledge<T>(
	options: CommonOptions,
	call: (client: RuntimeTrpcClient) => Promise<T>,
	format: (value: T) => string,
): Promise<void> {
	try {
		// A public workspace hint is routing only; the server independently verifies the strict caller.
		const project = options.project ?? process.env[KANBAN_SESSION_WORKSPACE_ENV];
		const target = await resolveWorkspaceTarget(project, { allowUnregistered: false });
		const response = await call(createRuntimeTrpcClient(target.workspaceId));
		process.stdout.write(`${options.json ? JSON.stringify(response, null, 2) : format(response)}\n`);
	} catch (error) {
		process.stderr.write(
			`kanban knowledge: ${error instanceof Error ? error.message : "The scoped server operation failed."}\n`,
		);
		process.exitCode = 1;
	}
}
function addCommon(command: Command): Command {
	return command
		.option("--project <workspace>", PROJECT_HELP)
		.option("--json", "Print bounded structured results as JSON.");
}
function addPagination(command: Command, limit: string): Command {
	return command
		.option("--offset <number>", "Continuation offset.", parseKnowledgeNumber, 0)
		.option("--limit <number>", "Maximum results/characters to return.", parseKnowledgeNumber, Number(limit));
}
const documentLine = (document: { id: string; revision: string; title: string; pinnedByUser: boolean }) =>
	`${document.id} @ ${document.revision}${document.pinnedByUser ? " [user-pinned]" : ""}: ${document.title}`;

export function registerKnowledgeCommand(program: Command): void {
	const knowledge = program
		.command("knowledge")
		.description(
			"Discover versioned project knowledge on demand. Content is reference material, not an execution approval.",
		);
	addCommon(
		knowledge
			.command("task-context <task-id>")
			.description(
				"Show this task's retained plan/spec/knowledge pins and revision drift, without document bodies.",
			),
	).action(async (taskId: string, options: CommonOptions) => {
		await runKnowledge(
			options,
			(client) => client.taskKnowledge.get.query({ taskId }),
			(value) =>
				value.context
					? [
							`Task ${taskId} context ${value.context.revision}`,
							`Reviewed bundle ${value.context.bundleRevision}`,
							...value.context.documents.map(documentLine),
							...value.drift.map(
								(item) => `DRIFT ${item.id}: pinned ${item.pinned}, current ${item.current ?? "missing"}`,
							),
							"Pins are reference context, not a new approval; no automatic adoption.",
						].join("\n")
					: "This task has no approved-plan knowledge handoff.",
		);
	});
	addPagination(
		addCommon(
			knowledge
				.command("task-read <task-id>")
				.description("Read a bounded retained plan part or task-pinned knowledge section."),
		),
		"4096",
	)
		.requiredOption("--part <part>", "spec, breakdown or document")
		.option("--id <id>", "The pinned document id (only for --part document).")
		.option("--context-revision <sha256>", "Exact retained task-context revision.")
		.option("--section <id>", "Heading id from the returned section map.")
		.action(
			async (
				taskId: string,
				options: CommonOptions & {
					part: "spec" | "breakdown" | "document";
					id?: string;
					contextRevision?: string;
					section?: string;
					offset: number;
					limit: number;
				},
			) => {
				await runKnowledge(
					options,
					(client) =>
						client.taskKnowledge.read.query({
							taskId,
							part: options.part,
							id: options.id,
							contextRevision: options.contextRevision,
							section: options.section,
							offset: options.offset,
							limit: options.limit,
						}),
					(value) =>
						`Pinned context ${value.contextRevision}, content ${value.contentHash}\nReference material, not a new execution approval.\n\n${value.markdown}${value.nextOffset !== null ? `\n[truncated; continue with --context-revision ${value.contextRevision} --offset ${value.nextOffset}]` : ""}`,
				);
			},
		);
	addCommon(
		knowledge
			.command("task-adopt <task-id>")
			.description(
				"User-only: adopt one explicitly reviewed reference revision for an unstarted Backlog dev task. Never changes the approved spec or starts work.",
			),
	)
		.requiredOption("--id <id>", "Existing task-pinned document id.")
		.requiredOption("--expected-context <sha256>", "The task context you reviewed.")
		.requiredOption("--expected-revision <sha256>", "The document revision currently pinned to the task.")
		.requiredOption("--revision <sha256>", "Exact current published replacement you reviewed.")
		.requiredOption("--reason <text>", "Audit reason for this explicit reference-only choice.")
		.option("--request-id <uuid>", "Reuse only for an exact retry of this choice.")
		.action(
			async (
				taskId: string,
				options: CommonOptions & {
					id: string;
					expectedContext: string;
					expectedRevision: string;
					revision: string;
					reason: string;
					requestId?: string;
				},
			) => {
				await runKnowledge(
					options,
					(client) =>
						client.taskKnowledge.adopt.mutate({
							taskId,
							documentId: options.id,
							expectedContextRevision: options.expectedContext,
							expectedDocumentRevision: options.expectedRevision,
							targetRevision: options.revision,
							reason: options.reason,
							requestId: options.requestId ?? randomUUID(),
						}),
					(value) =>
						`${value.duplicate ? "Retained exact-retry receipt" : "Adopted reference revision"}: context ${value.context.revision}\nOriginal approved spec/breakdown unchanged; no new execution approval or task start.`,
				);
			},
		);
	addPagination(
		addCommon(knowledge.command("list").description("List current document metadata without loading full plans.")),
		"20",
	)
		.option("--kind <kind>", "overview, plan, contract, decision, discovery or runbook")
		.action(async (options: CommonOptions & { offset: number; limit: number; kind?: string }) => {
			await runKnowledge(
				options,
				async (client) =>
					await client.knowledge.list.query({
						offset: options.offset,
						limit: options.limit,
						kind: options.kind ? knowledgeKindSchema.parse(options.kind) : undefined,
					}),
				(value) =>
					[
						value.documents.length
							? value.documents.map(documentLine).join("\n")
							: "No project knowledge published.",
						`${value.total} document(s)${value.nextOffset !== null ? `; next --offset ${value.nextOffset}` : ""}`,
					].join("\n"),
			);
		});
	addPagination(
		addCommon(
			knowledge
				.command("read <id>")
				.description("Read a bounded document or heading section, optionally at an exact revision."),
		),
		"4096",
	)
		.option("--revision <sha256>", "Pinned revision; omitted means current.")
		.option("--section <id>", "Heading id from the returned section map.")
		.action(
			async (
				id: string,
				options: CommonOptions & { revision?: string; section?: string; offset: number; limit: number },
			) => {
				await runKnowledge(
					options,
					async (client) =>
						await client.knowledge.read.query({
							id,
							revision: options.revision,
							section: options.section,
							offset: options.offset,
							limit: options.limit,
						}),
					(value) =>
						`${documentLine(value.document)}\nReference material; not a runtime instruction or plan approval.\n\n${value.markdown}${value.nextOffset !== null ? `\n[truncated; continue with --revision ${value.document.revision} --offset ${value.nextOffset}]` : ""}`,
				);
			},
		);
	addCommon(
		knowledge
			.command("search <query>")
			.description("Search this project's current documents with bounded snippets, without model calls."),
	)
		.option("--kind <kind>", "Limit to a document kind")
		.option("--limit <number>", "Maximum results (1-20).", parseKnowledgeNumber, 5)
		.action(async (query: string, options: CommonOptions & { kind?: string; limit: number }) => {
			await runKnowledge(
				options,
				async (client) =>
					await client.knowledge.search.query({
						query,
						kind: options.kind ? knowledgeKindSchema.parse(options.kind) : undefined,
						limit: options.limit,
					}),
				(value) =>
					value.results
						.map(
							(item) =>
								`${documentLine(item.document)}${item.section ? ` #${item.section}` : ""}\n  ${item.snippet.replace(/\s+/gu, " ")}`,
						)
						.join("\n") || "No matches in this project.",
			);
		});
	addCommon(
		knowledge
			.command("context")
			.description(
				"List bounded overview/plan/contract/decision pointers, pins first. This is not a task approval bundle.",
			),
	).action(async (options: CommonOptions) => {
		await runKnowledge(
			options,
			async (client) => await client.knowledge.context.query(),
			(value) =>
				`${value.documents.map(documentLine).join("\n")}\nProject index only, not an approved task context${value.truncated ? "; use list to continue" : ""}.`,
		);
	});
	addPagination(
		addCommon(
			knowledge
				.command("history <id>")
				.description("Read published revision/actor history without document bodies."),
		),
		"20",
	).action(async (id: string, options: CommonOptions & { offset: number; limit: number }) => {
		await runKnowledge(
			options,
			async (client) => await client.knowledge.history.query({ id, offset: options.offset, limit: options.limit }),
			(value) =>
				value.revisions
					.map(
						(item) =>
							`${documentLine(item)} (${item.publishedAt}, ${item.publishedBy.kind === "user" ? "user" : item.publishedBy.role})`,
					)
					.join("\n"),
		);
	});
	addPagination(
		addCommon(knowledge.command("proposals").description("List pending proposals or previously reviewed changes.")),
		"10",
	)
		.option("--status <status>", "pending, published or rejected", "pending")
		.action(
			async (
				options: CommonOptions & { offset: number; limit: number; status: "pending" | "published" | "rejected" },
			) => {
				await runKnowledge(
					options,
					async (client) =>
						await client.knowledge.proposals.query({
							status: options.status,
							offset: options.offset,
							limit: options.limit,
						}),
					(value) =>
						value.proposals
							.map((item) => `${item.id} [${item.status}] ${item.document.id}: ${item.document.title}`)
							.join("\n") || "No proposals.",
				);
			},
		);
	addPagination(
		addCommon(
			knowledge.command("proposal <id>").description("Read the bounded body of an unpublished/reviewed proposal."),
		),
		"4096",
	).action(async (id: string, options: CommonOptions & { offset: number; limit: number }) => {
		await runKnowledge(
			options,
			async (client) =>
				await client.knowledge.proposalRead.query({ id, offset: options.offset, limit: options.limit }),
			(value) =>
				`${value.proposal.id} [${value.proposal.status}] ${value.proposal.document.title}\nUnpublished proposals do not change contracts or approvals.\n\n${value.markdown}${value.nextOffset !== null ? `\n[continue with --offset ${value.nextOffset}]` : ""}`,
		);
	});
	for (const action of ["publish", "propose"] as const) {
		const command = addCommon(
			knowledge
				.command(`${action} <id>`)
				.description(
					action === "publish"
						? "Publish ordinary project knowledge (user/own orchestrator only; not an execution-plan approval)."
						: "Submit a proposed knowledge change; cards cannot publish it.",
				),
		)
			.requiredOption("--file <path>", "Markdown file, or - for stdin.")
			.requiredOption("--kind <kind>", "Document kind.")
			.requiredOption("--title <title>", "Short document title.")
			.option("--summary <text>", "Short discovery summary.", "")
			.option(
				"--tag <tag>",
				"Discovery tag; repeat as needed.",
				(value: string, previous: string[]) => [...previous, value],
				[],
			)
			.requiredOption(
				"--expected-revision <sha256|none>",
				"Revision read before editing; none only for a new document.",
			)
			.option("--request-id <uuid>", "Reuse this UUID for an exact retry; otherwise a fresh id is generated.");
		if (action === "propose")
			command.requiredOption("--reason <text>", "Why the curator should consider this change.");
		command.action(async (id: string, options: WriteOptions) => {
			await runKnowledge(
				options,
				async (client) => {
					const document: KnowledgeMetadata = {
						id,
						kind: knowledgeKindSchema.parse(options.kind),
						title: options.title,
						summary: options.summary ?? "",
						tags: options.tag,
						sources: [],
					};
					const fields = {
						requestId: options.requestId ?? randomUUID(),
						document,
						markdown: await readKnowledgeMarkdown(options.file),
						expectedRevision: parseKnowledgeExpectedRevision(options.expectedRevision),
					};
					const input: KnowledgeMutation =
						action === "publish" ? { action, ...fields } : { action, ...fields, reason: options.reason ?? "" };
					return await client.knowledge.mutate.mutate(input);
				},
				(value) =>
					value.kind === "document"
						? `Published ${documentLine(value.document)}`
						: `Proposed ${value.proposal.id}: ${value.proposal.document.id} [${value.proposal.status}]`,
			);
		});
	}
	addCommon(
		knowledge
			.command("review <proposal-id>")
			.description(
				"Publish/reject a proposal as the user or own-project orchestrator; user-pinned changes are user-only.",
			),
	)
		.requiredOption("--decision <decision>", "publish or reject.")
		.requiredOption(
			"--expected-revision <sha256|none>",
			"The current document revision; stale proposals must be resubmitted.",
		)
		.option("--request-id <uuid>", "Exact-retry identifier.")
		.action(
			async (
				proposalId: string,
				options: CommonOptions & { decision: "publish" | "reject"; expectedRevision: string; requestId?: string },
			) => {
				await runKnowledge(
					options,
					async (client) =>
						await client.knowledge.mutate.mutate({
							action: "review",
							requestId: options.requestId ?? randomUUID(),
							proposalId,
							decision: options.decision,
							expectedRevision: parseKnowledgeExpectedRevision(options.expectedRevision),
						}),
					(value) =>
						value.kind === "proposal"
							? `${value.proposal.id}: ${value.proposal.status}${value.proposal.publishedRevision ? ` @ ${value.proposal.publishedRevision}` : ""}`
							: documentLine(value.document),
				);
			},
		);
	for (const action of ["pin", "unpin"] as const) {
		addCommon(
			knowledge
				.command(`${action} <id>`)
				.description("Protect/unprotect the current document; only the user may change pins."),
		)
			.requiredOption("--expected-revision <sha256>", "The current published revision.")
			.option("--request-id <uuid>", "Exact-retry identifier.")
			.action(async (id: string, options: CommonOptions & { expectedRevision: string; requestId?: string }) => {
				await runKnowledge(
					options,
					async (client) =>
						await client.knowledge.mutate.mutate({
							action: "pin",
							id,
							pinned: action === "pin",
							expectedRevision: options.expectedRevision,
							requestId: options.requestId ?? randomUUID(),
						}),
					(value) => (value.kind === "document" ? documentLine(value.document) : value.proposal.id),
				);
			});
	}
}
