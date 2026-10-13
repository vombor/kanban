// One agent's default model in the settings dialog (config.json `agentDefaults`): the model, and where the CLI takes
// them, the provider and reasoning effort a launch passes when a card names no model (resolveLaunchAgentSettings).
// Values are free text passed verbatim; Kanban keeps no model list. For Cline, whose own models.json records are its
// allow list, the model is a select of those records, with "Other" for a provider Cline knows without a record.
import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { useMemo, useState } from "react";

import { patchAgentSettings } from "@/components/task-agent-settings-state";
import { NativeSelect } from "@/components/ui/native-select";
import type { RuntimeAgentId, RuntimeClineModelRecord, RuntimeTaskAgentSettings } from "@/runtime/types";

const INPUT_CLASS_NAME =
	"w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-40";
const OTHER_MODEL_VALUE = "__other__";
const RECORD_VALUE_SEPARATOR = "\u001f";

type AgentSettingsField = keyof RuntimeTaskAgentSettings;

function toRecordValue(providerId: string, modelId: string): string {
	return `${providerId}${RECORD_VALUE_SEPARATOR}${modelId}`;
}

function isInRecords(
	records: readonly RuntimeClineModelRecord[],
	settings: RuntimeTaskAgentSettings | undefined,
): boolean {
	const { providerId, modelId } = settings ?? {};
	return Boolean(
		providerId &&
			modelId &&
			records.some((record) => record.providerId === providerId && record.models.includes(modelId)),
	);
}

function TextField({
	label,
	value,
	placeholder,
	disabled,
	onChange,
}: {
	label: string;
	value: string;
	placeholder: string;
	disabled: boolean;
	onChange: (value: string) => void;
}): React.ReactElement {
	return (
		<label className="min-w-0 block">
			<span className="text-[11px] text-text-secondary block mb-1">{label}</span>
			<input
				type="text"
				value={value}
				onChange={(event) => onChange(event.currentTarget.value)}
				placeholder={placeholder}
				disabled={disabled}
				className={INPUT_CLASS_NAME}
			/>
		</label>
	);
}

function ClineModelRecordSelect({
	agentLabel,
	records,
	settings,
	showOther,
	disabled,
	onSelect,
}: {
	agentLabel: string;
	records: readonly RuntimeClineModelRecord[];
	settings: RuntimeTaskAgentSettings | undefined;
	showOther: boolean;
	disabled: boolean;
	onSelect: (value: string) => void;
}): React.ReactElement {
	const selectedValue = showOther
		? OTHER_MODEL_VALUE
		: settings?.providerId && settings.modelId
			? toRecordValue(settings.providerId, settings.modelId)
			: "";
	return (
		<div className="min-w-0">
			<span className="text-[11px] text-text-secondary block mb-1">Model</span>
			<NativeSelect
				size="sm"
				fill
				value={selectedValue}
				disabled={disabled}
				aria-label={`${agentLabel} default model`}
				onChange={(event) => onSelect(event.currentTarget.value)}
			>
				<option value="">Cline's own default</option>
				{records.map((record) => (
					<optgroup key={record.providerId} label={record.providerId}>
						{record.models.map((model) => (
							<option key={model} value={toRecordValue(record.providerId, model)}>
								{model}
							</option>
						))}
					</optgroup>
				))}
				<option value={OTHER_MODEL_VALUE}>Other (type provider and model)</option>
			</NativeSelect>
		</div>
	);
}

export function AgentDefaultModelFields({
	agentId,
	agentLabel,
	settings,
	clineModelRecords,
	disabled,
	onChange,
}: {
	agentId: RuntimeAgentId;
	agentLabel: string;
	settings: RuntimeTaskAgentSettings | undefined;
	/** Cline's models.json records; only Cline's fields use them. */
	clineModelRecords: readonly RuntimeClineModelRecord[];
	disabled: boolean;
	onChange: (settings: RuntimeTaskAgentSettings | undefined) => void;
}): React.ReactElement {
	const capabilities = getRuntimeAgentCatalogEntry(agentId)?.capabilities;
	const takesModel = (capabilities?.modelOverride ?? "none") !== "none";
	const takesEffort = (capabilities?.effortOverride ?? "none") !== "none";
	const takesProvider = (capabilities?.providerOverride ?? "none") !== "none";
	const records = useMemo(
		() => (agentId === "cline" ? clineModelRecords.filter((record) => record.models.length > 0) : []),
		[agentId, clineModelRecords],
	);
	const [otherChosen, setOtherChosen] = useState(false);
	const usesRecordSelect = takesModel && records.length > 0;
	const showOther =
		usesRecordSelect && (otherChosen || (Boolean(settings?.modelId) && !isInRecords(records, settings)));

	const setField = (field: AgentSettingsField, rawValue: string) => {
		const value = rawValue.trim();
		onChange(
			patchAgentSettings(
				settings,
				(next) => {
					if (value) {
						next[field] = value;
					} else {
						delete next[field];
					}
				},
				false,
			),
		);
	};
	const selectRecord = (value: string) => {
		setOtherChosen(value === OTHER_MODEL_VALUE);
		if (value === OTHER_MODEL_VALUE) {
			return;
		}
		const [providerId = "", modelId = ""] = value ? value.split(RECORD_VALUE_SEPARATOR) : [];
		onChange(
			patchAgentSettings(
				settings,
				(next) => {
					delete next.providerId;
					delete next.modelId;
					if (providerId && modelId) {
						next.providerId = providerId;
						next.modelId = modelId;
					}
				},
				false,
			),
		);
	};

	return (
		<div className="py-2 border-t border-border first:border-t-0" data-testid={`agent-default-${agentId}`}>
			<p className="text-[13px] text-text-primary m-0 mb-1">{agentLabel}</p>
			{takesModel ? (
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					{usesRecordSelect ? (
						<ClineModelRecordSelect
							agentLabel={agentLabel}
							records={records}
							settings={settings}
							showOther={showOther}
							disabled={disabled}
							onSelect={selectRecord}
						/>
					) : null}
					{takesProvider && (!usesRecordSelect || showOther) ? (
						<TextField
							label="Provider"
							value={settings?.providerId ?? ""}
							placeholder="The CLI's own provider"
							disabled={disabled}
							onChange={(value) => setField("providerId", value)}
						/>
					) : null}
					{!usesRecordSelect || showOther ? (
						<TextField
							label={usesRecordSelect ? "Model ID" : "Model"}
							value={settings?.modelId ?? ""}
							placeholder="The CLI's own model"
							disabled={disabled}
							onChange={(value) => setField("modelId", value)}
						/>
					) : null}
					{takesEffort ? (
						<TextField
							label="Reasoning effort"
							value={settings?.reasoningEffort ?? ""}
							placeholder="The CLI's own effort"
							disabled={disabled}
							onChange={(value) => setField("reasoningEffort", value)}
						/>
					) : null}
				</div>
			) : (
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					<label className="min-w-0 block">
						<span className="text-[11px] text-text-secondary block mb-1">Model</span>
						<input
							type="text"
							value=""
							disabled
							aria-label={`${agentLabel} default model`}
							placeholder="Not available"
							className={INPUT_CLASS_NAME}
						/>
					</label>
					<p className="text-text-secondary text-[12px] m-0 self-end pb-1.5">
						{agentLabel} takes no model at launch: set it in its own config.
					</p>
				</div>
			)}
		</div>
	);
}
