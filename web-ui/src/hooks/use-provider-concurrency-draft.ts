import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeConfigResponse } from "@/runtime/types";
import { useLatest } from "@/utils/react-use";

type Limits = NonNullable<RuntimeConfigResponse["providerConcurrency"]>;
const canonical = (value: Limits) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

/** Installation settings draft participates in the dialog's single Save; never writes from a section button. */
export function useProviderConcurrencyDraft(open: boolean, config: RuntimeConfigResponse | null) {
	const [limits, setLimits] = useState<Limits>({});
	const initial = useLatest(config?.providerConcurrency ?? {});
	const initialKey = canonical(initial.current);
	const baseline = useRef<Limits>({});
	const wasOpen = useRef(false);
	useEffect(() => {
		const opening = open && !wasOpen.current;
		const previous = baseline.current;
		const nextInitial = { ...initial.current };
		baseline.current = nextInitial;
		wasOpen.current = open;
		setLimits((current) => {
			if (!open) return {};
			if (opening) return nextInitial;
			// Refetches preserve edits/tombstones, while picking up unrelated newly saved caps instead of relaxing them.
			const merged = { ...nextInitial };
			for (const provider of new Set([...Object.keys(previous), ...Object.keys(current)])) {
				if (current[provider] === previous[provider]) continue;
				if (current[provider] === undefined) delete merged[provider];
				else merged[provider] = current[provider];
			}
			return merged;
		});
	}, [open, initialKey, initial]);
	const providers = useMemo(
		() =>
			[
				...new Set([
					"cline-pass",
					...(config?.clineModelRecords?.map((record) => record.providerId) ?? []),
					...(config?.agents
						.filter((agent) => getRuntimeAgentCatalogEntry(agent.id)?.capabilities.providerOverride !== "flag")
						.map((agent) => `agent:${agent.id}`) ?? []),
					...Object.values(config?.agentDefaults ?? {}).flatMap((settings) =>
						settings?.providerId ? [settings.providerId] : [],
					),
					...Object.keys(limits),
				]),
			].sort(),
		[config?.clineModelRecords, config?.agents, config?.agentDefaults, limits],
	);
	return {
		limits,
		providers,
		dirty: canonical(limits) !== canonical(config?.providerConcurrency ?? {}),
		set: (provider: string, value: string) =>
			setLimits((current) => {
				const next = { ...current };
				if (value) next[provider] = Number(value);
				else delete next[provider];
				return next;
			}),
	};
}
