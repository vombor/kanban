import { useCallback } from "react";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

/** Private results are usable only for the exact current project/selection, even before effects clear old data. */
export function useKnowledgeQuery<T>(key: string, queryFn: () => Promise<T>, enabled = true) {
	const scoped = useCallback(async () => ({ key, value: await queryFn() }), [key, queryFn]);
	const query = useTrpcQuery({ enabled, queryFn: scoped });
	return { ...query, data: query.data?.key === key && enabled ? query.data.value : null };
}
