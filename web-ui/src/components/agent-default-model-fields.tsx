// The selected agent's install-specific defaults. Options come from that CLI/configuration, never routing policy.
import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { useId } from "react";
import { patchAgentSettings } from "@/components/task-agent-settings-state";
import { NativeSelect } from "@/components/ui/native-select";
import { fetchAgentSettingsOptions } from "@/runtime/runtime-config-query";
import type {
	AgentModelOption,
	RuntimeAgentId,
	RuntimeClineModelRecord,
	RuntimeTaskAgentSettings,
} from "@/runtime/types";
import { useAsync } from "@/utils/react-use";

const SEPARATOR = "\u001f";
const modelValue = (model: Pick<AgentModelOption, "providerId" | "modelId">) =>
	`${model.providerId ?? ""}${SEPARATOR}${model.modelId}`;

function withStoredOption(options: Array<{ value: string; label: string }>, value: string | undefined) {
	return value && !options.some((option) => option.value === value)
		? [...options, { value, label: `${value} (saved default)` }]
		: options;
}

export function AgentDefaultModelFields({
	agentId,
	agentLabel,
	settings,
	clineModelRecords,
	workspaceId = null,
	disabled,
	onChange,
}: {
	agentId: RuntimeAgentId;
	agentLabel: string;
	settings: RuntimeTaskAgentSettings | undefined;
	clineModelRecords: readonly RuntimeClineModelRecord[];
	workspaceId?: string | null;
	disabled: boolean;
	onChange: (settings: RuntimeTaskAgentSettings | undefined) => void;
}): React.ReactElement {
	const capabilities = getRuntimeAgentCatalogEntry(agentId)?.capabilities;
	const takesModel = (capabilities?.modelOverride ?? "none") !== "none";
	const takesEffort = (capabilities?.effortOverride ?? "none") !== "none";
	const takesProvider = (capabilities?.providerOverride ?? "none") !== "none";
	const fieldId = useId();
	const discovery = useAsync(
		async () => (takesModel ? await fetchAgentSettingsOptions(workspaceId, agentId) : null),
		[agentId, workspaceId, takesModel],
	);
	const fallbackModels: AgentModelOption[] =
		agentId === "cline"
			? clineModelRecords.flatMap((record) =>
					record.models.map((modelId) => ({
						providerId: record.providerId,
						modelId,
						label: modelId,
						reasoningEfforts: [],
					})),
				)
			: [];
	const available = discovery.value?.models.length ? discovery.value.models : fallbackModels;
	const models = available.filter(
		(model) => !settings?.providerId || !model.providerId || model.providerId === settings.providerId,
	);
	const selected = settings?.modelId
		? models.find(
				(model) =>
					model.modelId === settings.modelId && (!settings.providerId || model.providerId === settings.providerId),
			)
		: undefined;
	const selectedValue = settings?.modelId
		? modelValue(selected ?? { modelId: settings.modelId, providerId: settings.providerId })
		: "";
	const modelOptions = models.map((model) => ({
		value: modelValue(model),
		label: model.providerId && !settings?.providerId ? `${model.providerId} · ${model.label}` : model.label,
	}));
	const displayedModels =
		settings?.modelId && !selected
			? [...modelOptions, { value: selectedValue, label: `${settings.modelId} (saved default)` }]
			: modelOptions;
	const providerOptions = withStoredOption(
		[
			...new Map(
				[
					...(discovery.value?.providers ?? []),
					...fallbackModels.flatMap((model) =>
						model.providerId ? [{ value: model.providerId, label: model.providerId }] : [],
					),
				].map((option) => [option.value, option]),
			).values(),
		],
		settings?.providerId,
	);
	const effortOptions = withStoredOption(
		selected ? selected.reasoningEfforts.map((value) => ({ value, label: value })) : (discovery.value?.efforts ?? []),
		settings?.reasoningEffort,
	);
	const setField = (field: keyof RuntimeTaskAgentSettings, value: string) =>
		onChange(
			patchAgentSettings(
				settings,
				(next) => {
					if (value) next[field] = value;
					else delete next[field];
					if (field === "providerId" && value !== settings?.providerId) delete next.modelId;
				},
				false,
			),
		);
	const selectModel = (value: string) => {
		const [providerId = "", modelId = ""] = value.split(SEPARATOR);
		onChange(
			patchAgentSettings(
				settings,
				(next) => {
					if (modelId) next.modelId = modelId;
					else delete next.modelId;
					if (providerId && takesProvider) next.providerId = providerId;
				},
				false,
			),
		);
	};
	const loading = discovery.loading && available.length === 0;
	return (
		<div className="pt-2" data-testid={`agent-default-${agentId}`}>
			<p className="text-[13px] text-text-primary m-0 mb-2">{agentLabel}</p>
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				{takesProvider ? (
					<label htmlFor={`${fieldId}-provider`} className="min-w-0 block">
						<span className="text-[11px] text-text-secondary block mb-1">Provider</span>
						<NativeSelect
							id={`${fieldId}-provider`}
							size="sm"
							fill
							aria-label={`${agentLabel} default provider`}
							value={settings?.providerId ?? ""}
							disabled={disabled || loading}
							onChange={(event) => setField("providerId", event.currentTarget.value)}
						>
							<option value="">CLI's own provider</option>
							{providerOptions.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</NativeSelect>
					</label>
				) : null}
				<label htmlFor={`${fieldId}-model`} className="min-w-0 block">
					<span className="text-[11px] text-text-secondary block mb-1">Model</span>
					<NativeSelect
						id={`${fieldId}-model`}
						size="sm"
						fill
						aria-label={`${agentLabel} default model`}
						value={selectedValue}
						disabled={disabled || loading || !takesModel}
						onChange={(event) => selectModel(event.currentTarget.value)}
					>
						<option value="">{takesModel ? "CLI's own model" : "Configured in the CLI"}</option>
						{displayedModels.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</NativeSelect>
				</label>
				{takesEffort && takesModel ? (
					<label htmlFor={`${fieldId}-effort`} className="min-w-0 block">
						<span className="text-[11px] text-text-secondary block mb-1">Reasoning effort</span>
						<NativeSelect
							id={`${fieldId}-effort`}
							size="sm"
							fill
							aria-label={`${agentLabel} default reasoning effort`}
							value={settings?.reasoningEffort ?? ""}
							disabled={disabled || loading}
							onChange={(event) => setField("reasoningEffort", event.currentTarget.value)}
						>
							<option value="">CLI's own effort</option>
							{effortOptions.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</NativeSelect>
					</label>
				) : null}
			</div>
			{!takesModel ? (
				<p className="text-text-secondary text-[12px] mt-2 mb-0">
					{agentLabel} takes no model at launch: set it in its own config.
				</p>
			) : (
				<p className="text-text-secondary text-[11px] mt-2 mb-0">
					{discovery.loading
						? "Loading this agent's choices…"
						: (discovery.value?.error ??
							(discovery.error
								? "Could not load this agent's choices. Its saved default is kept."
								: discovery.value?.source))}
				</p>
			)}
		</div>
	);
}
