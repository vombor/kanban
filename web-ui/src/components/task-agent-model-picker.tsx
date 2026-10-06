import * as Collapsible from "@radix-ui/react-collapsible";
import { getRuntimeAgentCatalogEntry, getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import { ChevronDown } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { OpaqueTaskAgentSettingsFields } from "@/components/opaque-task-agent-settings-fields";
import { patchAgentSettings } from "@/components/task-agent-settings-state";
import { cn } from "@/components/ui/cn";
import { NativeSelect } from "@/components/ui/native-select";
import type { RuntimeAgentId, RuntimeTaskAgentSettings } from "@/runtime/types";

// ---------------------------------------------------------------------------
// Hook: the agent override options for a task
// ---------------------------------------------------------------------------

export interface UseTaskAgentModelPickerInput {
	/** The default agent ID from runtimeConfig.selectedAgentId — used to build the first option label */
	defaultAgentId?: RuntimeAgentId | null;
}

export interface UseTaskAgentModelPickerResult {
	agentOptions: Array<{ value: string; label: string }>;
}

export function useTaskAgentModelPicker({
	defaultAgentId,
}: UseTaskAgentModelPickerInput): UseTaskAgentModelPickerResult {
	const agentOptions = useMemo(() => {
		const catalog = getRuntimeLaunchSupportedAgentCatalog();
		let firstLabel = "Default";
		if (defaultAgentId) {
			const defaultAgent = catalog.find((a) => a.id === defaultAgentId);
			if (defaultAgent) {
				firstLabel = defaultAgent.label;
			}
		}
		return [
			{ value: "", label: firstLabel },
			// Exclude the default agent from the explicit list — it's already represented by the first option
			...catalog
				.filter((agent) => agent.id !== defaultAgentId)
				.map((agent) => ({ value: agent.id, label: agent.label })),
		];
	}, [defaultAgentId]);

	return { agentOptions };
}

// ---------------------------------------------------------------------------
// Component: agent override plus the agent's per-task settings. Every agent (Cline included) is a
// CLI, so provider/model/effort are free-text values passed to its flags, shown when its catalog
// entry says it supports them.
// ---------------------------------------------------------------------------

function nextAgentClearsProvider(nextAgentId: RuntimeAgentId | null): boolean {
	if (!nextAgentId) {
		return true;
	}
	return (getRuntimeAgentCatalogEntry(nextAgentId)?.capabilities.providerOverride ?? "none") === "none";
}

export function TaskAgentModelPicker({
	agentId,
	onAgentIdChange,
	agentSettings,
	onAgentSettingsChange,
	agentOptions,
	defaultAgentId,
}: {
	agentId: RuntimeAgentId | undefined;
	onAgentIdChange: (value: RuntimeAgentId | undefined) => void;
	agentSettings?: RuntimeTaskAgentSettings | undefined;
	onAgentSettingsChange?: (value: RuntimeTaskAgentSettings | undefined) => void;
	agentOptions: Array<{ value: string; label: string }>;
	/** The default agent ID from runtimeConfig — the agent whose settings apply when no override is chosen */
	defaultAgentId?: RuntimeAgentId | null;
}): ReactElement {
	const updateTaskAgentSettings = useCallback(
		(updater: (current: RuntimeTaskAgentSettings | undefined) => RuntimeTaskAgentSettings | undefined) => {
			onAgentSettingsChange?.(updater(agentSettings));
		},
		[agentSettings, onAgentSettingsChange],
	);

	const effectiveAgentId = agentId ?? defaultAgentId ?? null;
	const effectiveCapabilities = effectiveAgentId
		? (getRuntimeAgentCatalogEntry(effectiveAgentId)?.capabilities ?? null)
		: null;
	const effectiveAgentLabel = effectiveAgentId ? (getRuntimeAgentCatalogEntry(effectiveAgentId)?.label ?? "") : "";
	const showFreeTextProviderInput = Boolean(effectiveAgentId && effectiveCapabilities?.providerOverride !== "none");
	const showFreeTextModelInput = Boolean(effectiveAgentId && effectiveCapabilities?.modelOverride !== "none");
	const showFreeTextEffortInput = Boolean(effectiveAgentId && effectiveCapabilities?.effortOverride !== "none");

	const updateOpaqueSetting = useCallback(
		(field: "providerId" | "modelId" | "reasoningEffort", rawValue: string) => {
			const value = rawValue.trim();
			updateTaskAgentSettings((currentSettings) => {
				if (currentSettings === undefined && !value) {
					return undefined;
				}
				return patchAgentSettings(currentSettings, (nextSettings) => {
					if (value) {
						nextSettings[field] = value;
					} else {
						delete nextSettings[field];
					}
				});
			});
		},
		[updateTaskAgentSettings],
	);

	const [isSettingsExpanded, setIsSettingsExpanded] = useState(false);

	return (
		<div className="flex flex-col gap-2">
			<Collapsible.Root open={isSettingsExpanded} onOpenChange={setIsSettingsExpanded}>
				<Collapsible.Trigger asChild>
					<button
						type="button"
						className="inline-flex w-fit items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary cursor-pointer bg-transparent border-none p-0"
					>
						<ChevronDown
							size={12}
							className={cn("transition-transform", isSettingsExpanded ? "rotate-0" : "-rotate-90")}
						/>
						Override Agent Settings
					</button>
				</Collapsible.Trigger>
				<Collapsible.Content className="pt-2">
					<div className="flex flex-col gap-2">
						<div className="w-full sm:w-1/2 min-w-0">
							<span className="text-[11px] text-text-secondary block mb-1">Agent</span>
							<NativeSelect
								size="sm"
								fill
								value={agentId ?? ""}
								onChange={(e) => {
									const value = e.currentTarget.value;
									onAgentIdChange(value ? (value as RuntimeAgentId) : undefined);
									// Keep model/effort across agent switches; only clear providerId
									// when the next effective agent has providerOverride === "none".
									const nextEffectiveAgentId = value ? (value as RuntimeAgentId) : (defaultAgentId ?? null);
									if (nextAgentClearsProvider(nextEffectiveAgentId)) {
										updateTaskAgentSettings((currentSettings) => {
											if (currentSettings === undefined) {
												return undefined;
											}
											return patchAgentSettings(currentSettings, (nextSettings) => {
												delete nextSettings.providerId;
											});
										});
									}
								}}
							>
								{agentOptions.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</NativeSelect>
						</div>
						<OpaqueTaskAgentSettingsFields
							agentSettings={agentSettings}
							agentLabel={effectiveAgentLabel}
							docsUrl={effectiveCapabilities?.docsUrl}
							showProviderInput={showFreeTextProviderInput}
							showModelInput={showFreeTextModelInput}
							showEffortInput={showFreeTextEffortInput}
							onProviderChange={(value) => updateOpaqueSetting("providerId", value)}
							onModelChange={(value) => updateOpaqueSetting("modelId", value)}
							onEffortChange={(value) => updateOpaqueSetting("reasoningEffort", value)}
						/>
					</div>
				</Collapsible.Content>
			</Collapsible.Root>
		</div>
	);
}
