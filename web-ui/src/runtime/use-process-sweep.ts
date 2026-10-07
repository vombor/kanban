import { useCallback, useState } from "react";

import { fetchProcessSweep, runProcessSweepNow } from "@/runtime/runtime-config-query";
import type { RuntimeProcessSweepResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseProcessSweepResult {
	status: RuntimeProcessSweepResponse | null;
	isLoading: boolean;
	error: Error | null;
	isSweeping: boolean;
	sweepNow: () => Promise<void>;
}

/** The runtime's last orphan-process sweep (src/server/orphan-process-sweeper.ts), loaded while `enabled`. */
export function useProcessSweep(enabled: boolean): UseProcessSweepResult {
	const query = useTrpcQuery<RuntimeProcessSweepResponse>({
		enabled,
		queryFn: fetchProcessSweep,
		retainDataOnError: true,
	});
	const [isSweeping, setIsSweeping] = useState(false);
	const [sweepError, setSweepError] = useState<Error | null>(null);
	const setData = query.setData;

	const sweepNow = useCallback(async () => {
		setIsSweeping(true);
		setSweepError(null);
		try {
			setData(await runProcessSweepNow());
		} catch (error) {
			setSweepError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			setIsSweeping(false);
		}
	}, [setData]);

	return {
		status: query.data,
		isLoading: query.isLoading,
		error: sweepError ?? query.error,
		isSweeping,
		sweepNow,
	};
}
