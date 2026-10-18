import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useKnowledgeQuery } from "./use-knowledge-query";

type Client = ReturnType<typeof getRuntimeTrpcClient>["knowledgeDiscovery"];
export function useSourcePolicy(workspaceId: string, onChanged: () => void) {
	const [generation, setGeneration] = useState(0),
		[busy, setBusy] = useState(false),
		[error, setError] = useState("");
	const queryFn = useCallback(
		() => getRuntimeTrpcClient(workspaceId).knowledgeDiscovery.policy.query(),
		[workspaceId],
	);
	const query = useKnowledgeQuery(JSON.stringify([workspaceId, generation]), queryFn);
	const alive = useRef(false),
		writing = useRef(false);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	const save = async (operation: (client: Client) => Promise<unknown>) => {
		if (writing.current || !alive.current) return;
		writing.current = true;
		setBusy(true);
		setError("");
		try {
			await operation(getRuntimeTrpcClient(workspaceId).knowledgeDiscovery);
			if (alive.current) {
				setGeneration((value) => value + 1);
				onChanged();
			}
		} catch {
			if (alive.current)
				setError(
					"Source settings changed or could not be confirmed. Reload the retained policy before retrying; no automatic retry or scope broadening was performed.",
				);
		} finally {
			writing.current = false;
			if (alive.current) setBusy(false);
		}
	};
	return {
		query,
		busy,
		error,
		reload: () => {
			setError("");
			setGeneration((value) => value + 1);
		},
		save,
	};
}
