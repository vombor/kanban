import { useCallback, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { KnowledgeDocument, KnowledgeProposal } from "../../../src/trpc/knowledge-contract";
import { useKnowledgeQuery } from "./use-knowledge-query";

export function useKnowledgeBrowser(workspaceId: string) {
	const [tab, setTab] = useState<"documents" | "proposals">("documents"),
		[kind, setKind] = useState<KnowledgeDocument["kind"] | undefined>(),
		[status, setStatus] = useState<KnowledgeProposal["status"]>("pending");
	const [term, setTerm] = useState(""),
		[offset, setOffset] = useState(0),
		[generation, setGeneration] = useState(0),
		[selectedId, setSelectedId] = useState<string | null>(null),
		[notice, setNotice] = useState("");
	const queryFn = useCallback(async () => {
		const api = getRuntimeTrpcClient(workspaceId).knowledge;
		if (tab === "proposals") {
			const result = await api.proposals.query({ status, offset, limit: 10 });
			return {
				...result,
				documents: [] as KnowledgeDocument[],
				snippets: {} as Record<string, string>,
				truncated: false,
			};
		}
		if (term) {
			const result = await api.search.query({ query: term, kind, limit: 20 });
			return {
				documents: result.results.map((item) => item.document),
				snippets: Object.fromEntries(result.results.map((item) => [item.document.id, item.snippet])),
				total: result.total,
				nextOffset: null,
				proposals: [] as KnowledgeProposal[],
				truncated: result.truncated,
			};
		}
		const result = await api.list.query({ kind, offset, limit: 20 });
		return {
			...result,
			proposals: [] as KnowledgeProposal[],
			snippets: {} as Record<string, string>,
			truncated: false,
		};
	}, [workspaceId, tab, kind, status, term, offset]);
	const query = useKnowledgeQuery(JSON.stringify([workspaceId, tab, kind, status, term, offset, generation]), queryFn);
	const permissionsFn = useCallback(
		() => getRuntimeTrpcClient(workspaceId).knowledge.permissions.query(),
		[workspaceId],
	);
	const permissions = useKnowledgeQuery(JSON.stringify([workspaceId, "permissions", generation]), permissionsFn);
	const changed = useCallback(() => {
		setNotice("Curation confirmed. Execution approvals and existing task pins are unchanged.");
		setSelectedId(null);
		setGeneration((value) => value + 1);
	}, []);
	return {
		tab,
		kind,
		status,
		term,
		offset,
		query,
		permissions,
		selectedId,
		select: setSelectedId,
		notice,
		changed,
		setTab: (value: typeof tab) => {
			setTab(value);
			setOffset(0);
			setSelectedId(null);
		},
		setKind: (value: typeof kind) => {
			setKind(value);
			setOffset(0);
			setSelectedId(null);
		},
		setStatus: (value: typeof status) => {
			setStatus(value);
			setOffset(0);
			setSelectedId(null);
		},
		search: (value: string) => {
			setTerm(value);
			setOffset(0);
			setSelectedId(null);
		},
		page: (value: number) => {
			setOffset(value);
			setSelectedId(null);
		},
		reload: () => {
			setSelectedId(null);
			setNotice("");
			setGeneration((value) => value + 1);
		},
	};
}
