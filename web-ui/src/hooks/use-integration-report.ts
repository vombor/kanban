import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { IntegrationManifest, IntegrationReport } from "../../../src/trpc/integration-contract";
import { useKnowledgeQuery } from "./use-knowledge-query";

/** One explicit execution per selected preview. Uncertain delivery retains its id and never replays a mutation. */
export function useIntegrationReport(workspaceId: string) {
	const [manifest, setManifest] = useState<IntegrationManifest | null>(null),
		[report, setReport] = useState<IntegrationReport | null>(null),
		[requestId, setRequestId] = useState<string | null>(null),
		[busy, setBusy] = useState(false),
		[error, setError] = useState(""),
		[generation, setGeneration] = useState(0);
	const alive = useRef(false),
		writing = useRef(false);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	const historyFn = useCallback(
		() => getRuntimeTrpcClient(workspaceId).integration.list.query({ offset: 0 }),
		[workspaceId],
	);
	const history = useKnowledgeQuery(JSON.stringify([workspaceId, generation]), historyFn);
	const perform = async (operation: () => Promise<void>) => {
		if (writing.current) return;
		writing.current = true;
		setBusy(true);
		setError("");
		try {
			await operation();
		} catch {
			if (alive.current)
				setError(
					"The operation is unavailable or unconfirmed. Retain the request id and read its report/history; no execution was automatically retried.",
				);
		} finally {
			writing.current = false;
			if (alive.current) {
				setBusy(false);
				setGeneration((n) => n + 1);
			}
		}
	};
	const unresolved = Boolean(requestId && (!report || ["reserved", "running", "uncertain"].includes(report.status)));
	return {
		manifest,
		report,
		requestId,
		busy,
		error,
		history,
		unresolved,
		preview: (taskIds: string[], planTaskId?: string) =>
			perform(async () => {
				if (unresolved) throw new Error("Inspect unresolved submission first");
				if (alive.current) {
					setManifest(null);
					setReport(null);
					setRequestId(null);
				}
				const value = await getRuntimeTrpcClient(workspaceId).integration.preview.query({ taskIds, planTaskId });
				if (alive.current) setManifest(value);
			}),
		run: () =>
			perform(async () => {
				if (!manifest || requestId) throw new Error("Preview exactly once before explicit execution");
				const id = crypto.randomUUID();
				setRequestId(id);
				const value = await getRuntimeTrpcClient(workspaceId).integration.run.mutate({
					...manifest.selection,
					requestId: id,
					fingerprint: manifest.fingerprint,
				});
				if (alive.current) setReport(value);
			}),
		read: (id: string) =>
			perform(async () => {
				const value = await getRuntimeTrpcClient(workspaceId).integration.read.query({ id });
				if (alive.current) {
					setReport(value);
					setRequestId(id);
					setManifest(value.manifest);
				}
			}),
		refresh: () => setGeneration((n) => n + 1),
	};
}
