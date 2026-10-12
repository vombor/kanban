import * as RadixSelect from "@radix-ui/react-select";
import { getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import { describeKitChoiceRole } from "@runtime-kit-choice-display";
import { Check, ChevronDown } from "lucide-react";
import type { ReactElement } from "react";

import { NativeSelect } from "@/components/ui/native-select";
import {
	CUSTOM_PRESET_VALUE,
	CUSTOM_TEAM_ROLES,
	type CustomTeamRole,
	type CustomTeamRoleName,
	type ProjectKitSelection,
} from "@/hooks/use-project-kit-selection";
import type { RuntimeAgentId, RuntimeProjectKitChoice, RuntimeProjectKitPresetChoice } from "@/runtime/types";

const FIELD_CLASS =
	"h-7 min-w-0 rounded-md border border-border bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent disabled:opacity-60";

function KitRoles({
	kit,
	className,
}: {
	kit: Pick<RuntimeProjectKitChoice | RuntimeProjectKitPresetChoice, "roles">;
	className?: string;
}): ReactElement {
	return (
		<dl className={className}>
			{kit.roles.map((role) => (
				<div key={role.role} className="flex min-w-0 gap-1.5">
					<dt className="shrink-0 text-text-tertiary">{role.role}</dt>
					<dd className="m-0 min-w-0 truncate font-mono text-text-secondary" title={describeKitChoiceRole(role)}>
						{describeKitChoiceRole(role)}
					</dd>
				</div>
			))}
		</dl>
	);
}

/** One custom-team role: its agent (required for dev and QA) and, optionally, its provider and model. */
function CustomRoleRow({
	role,
	value,
	required,
	disabled,
	onChange,
}: {
	role: CustomTeamRoleName;
	value: CustomTeamRole;
	required: boolean;
	disabled: boolean;
	onChange: (patch: Partial<CustomTeamRole>) => void;
}): ReactElement {
	const emptyLabel = role === "fallback" ? "the dev agent" : required ? "pick an agent" : "the selected agent";
	return (
		<div className="grid grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-1.5">
			<span className="text-[12px] text-text-tertiary">{role}</span>
			<NativeSelect
				size="sm"
				fill
				aria-label={`${role} agent`}
				value={value.agentId}
				disabled={disabled}
				onChange={(event) => onChange({ agentId: event.target.value as RuntimeAgentId | "" })}
			>
				<option value="">{emptyLabel}</option>
				{getRuntimeLaunchSupportedAgentCatalog().map((agent) => (
					<option key={agent.id} value={agent.id}>
						{agent.label}
					</option>
				))}
			</NativeSelect>
			<input
				aria-label={`${role} provider`}
				className={FIELD_CLASS}
				placeholder="provider"
				value={value.provider}
				disabled={disabled}
				onChange={(event) => onChange({ provider: event.target.value })}
			/>
			<input
				aria-label={`${role} model`}
				className={FIELD_CLASS}
				placeholder="model (agent default)"
				value={value.model}
				disabled={disabled}
				onChange={(event) => onChange({ model: event.target.value })}
			/>
		</div>
	);
}

/** The team kit's models: a preset (its four roles shown) or a custom team (four editable role rows). */
function TeamModelsPicker({
	presets,
	selection,
	disabled,
}: {
	presets: RuntimeProjectKitPresetChoice[];
	selection: ProjectKitSelection;
	disabled: boolean;
}): ReactElement {
	const preset = presets.find((entry) => entry.name === selection.presetValue) ?? null;
	return (
		<div data-testid="add-project-kit-team-models" className="mt-2 flex flex-col gap-1.5">
			<label htmlFor="add-project-kit-preset" className="block text-[12px] text-text-secondary">
				Models
			</label>
			<NativeSelect
				id="add-project-kit-preset"
				size="sm"
				fill
				aria-label="Models"
				value={selection.presetValue}
				disabled={disabled}
				onChange={(event) => selection.setPresetValue(event.target.value)}
			>
				{presets.map((entry) => (
					<option key={entry.name} value={entry.name}>
						{entry.name}
					</option>
				))}
				<option value={CUSTOM_PRESET_VALUE}>custom (your own agents and models)</option>
			</NativeSelect>
			{preset ? (
				<div data-testid="add-project-kit-preset-summary" className="text-[12px]">
					{preset.description ? (
						<p className="m-0 truncate text-text-tertiary" title={preset.description}>
							{preset.description}
						</p>
					) : null}
					<KitRoles kit={preset} className="m-0 mt-0.5 grid grid-cols-2 gap-x-3" />
				</div>
			) : (
				<div data-testid="add-project-kit-custom-roles" className="flex flex-col gap-1">
					{CUSTOM_TEAM_ROLES.map((role) => (
						<CustomRoleRow
							key={role}
							role={role}
							value={selection.customRoles[role]}
							required={role === "dev" || role === "qa"}
							disabled={disabled}
							onChange={(patch) => selection.setCustomRole(role, patch)}
						/>
					))}
					{selection.blockedReason ? (
						<p className="m-0 text-[12px] text-status-orange">{selection.blockedReason}</p>
					) : null}
				</div>
			)}
			<p data-testid="add-project-kit-fallback-note" className="m-0 text-[12px] text-text-tertiary">
				The fallback starts without asking: a paid fallback model runs and costs without approval.
			</p>
		</div>
	);
}

/**
 * The routing kit a new project starts on (`default` preselected), and for the team kit its models: a preset or a
 * custom team. The server applies it through `kanban kit apply`'s code; a project that is already added keeps its
 * own kit.
 */
export function ProjectKitPicker({
	kits,
	teamKitName,
	presets,
	selection,
	error,
	hint,
	disabled = false,
}: {
	kits: RuntimeProjectKitChoice[];
	/** The kit whose models come from a preset or a custom team. */
	teamKitName: string;
	presets: RuntimeProjectKitPresetChoice[];
	selection: ProjectKitSelection;
	error: string | null;
	hint?: string;
	disabled?: boolean;
}): ReactElement {
	const value = selection.kitName;
	const onChange = selection.setKitName;
	const selected = kits.find((kit) => kit.name === value) ?? null;
	return (
		<div>
			<label htmlFor="add-project-kit-select" className="block text-[12px] text-text-secondary mb-1.5">
				Routing kit
			</label>
			<RadixSelect.Root value={value} onValueChange={onChange} disabled={disabled || kits.length === 0}>
				<RadixSelect.Trigger
					id="add-project-kit-select"
					aria-label="Routing kit"
					className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text-primary outline-none focus:border-accent disabled:cursor-default disabled:opacity-60"
				>
					<RadixSelect.Value>{value}</RadixSelect.Value>
					{selected?.origin === "user" ? <span className="text-text-tertiary">user kit</span> : null}
					<RadixSelect.Icon className="ml-auto">
						<ChevronDown size={14} className="text-text-tertiary" />
					</RadixSelect.Icon>
				</RadixSelect.Trigger>
				<RadixSelect.Portal>
					<RadixSelect.Content
						className="z-50 max-h-80 w-[var(--radix-select-trigger-width)] overflow-auto rounded-lg border border-border bg-surface-1 p-1 shadow-xl"
						position="popper"
						sideOffset={4}
						align="start"
					>
						<RadixSelect.Viewport>
							{kits.map((kit) => (
								<RadixSelect.Item
									key={kit.name}
									value={kit.name}
									data-testid={`add-project-kit-option-${kit.name}`}
									className="flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-[12px] outline-none data-highlighted:bg-surface-3"
								>
									<div className="flex items-center gap-2 text-[13px] text-text-primary">
										<RadixSelect.ItemText>{kit.name}</RadixSelect.ItemText>
										{kit.origin === "user" ? <span className="text-text-tertiary">user kit</span> : null}
										<RadixSelect.ItemIndicator className="ml-auto">
											<Check size={14} className="text-accent" />
										</RadixSelect.ItemIndicator>
									</div>
									{kit.description ? (
										<p className="m-0 truncate text-text-secondary" title={kit.description}>
											{kit.description}
										</p>
									) : null}
									{kit.name === teamKitName ? (
										<p className="m-0 text-[11px] text-text-tertiary">
											models: {presets.map((preset) => preset.name).join(", ")} or your own
										</p>
									) : (
										<KitRoles kit={kit} className="m-0 grid grid-cols-2 gap-x-3 text-[11px]" />
									)}
								</RadixSelect.Item>
							))}
						</RadixSelect.Viewport>
					</RadixSelect.Content>
				</RadixSelect.Portal>
			</RadixSelect.Root>
			{selected && selection.isTeamKit ? (
				<>
					{selected.description ? (
						<p className="m-0 mt-1.5 truncate text-[12px] text-text-tertiary" title={selected.description}>
							{selected.description}
						</p>
					) : null}
					<TeamModelsPicker presets={presets} selection={selection} disabled={disabled} />
				</>
			) : selected ? (
				<div data-testid="add-project-kit-summary" className="mt-1.5 text-[12px]">
					{selected.description ? (
						<p className="m-0 truncate text-text-tertiary" title={selected.description}>
							{selected.description}
						</p>
					) : null}
					<KitRoles kit={selected} className="m-0 mt-0.5 grid grid-cols-2 gap-x-3" />
				</div>
			) : null}
			{error ? (
				<p className="m-0 mt-1.5 text-[12px] text-status-orange">
					Kits unavailable ({error}); the project starts on {value}.
				</p>
			) : null}
			{hint ? <p className="m-0 mt-1 text-[12px] text-text-tertiary">{hint}</p> : null}
		</div>
	);
}
