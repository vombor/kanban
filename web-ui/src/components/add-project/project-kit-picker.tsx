import * as RadixSelect from "@radix-ui/react-select";
import { describeKitChoiceRole } from "@runtime-kit-choice-display";
import { Check, ChevronDown } from "lucide-react";
import type { ReactElement } from "react";

import type { RuntimeProjectKitChoice } from "@/runtime/types";

function KitRoles({ kit, className }: { kit: RuntimeProjectKitChoice; className?: string }): ReactElement {
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

/**
 * The routing kit a new project starts on (`default` preselected). The server applies it through `kanban kit apply`'s
 * code; a project that is already added keeps its own kit.
 */
export function ProjectKitPicker({
	kits,
	value,
	onChange,
	error,
	hint,
	disabled = false,
}: {
	kits: RuntimeProjectKitChoice[];
	value: string;
	onChange: (kitName: string) => void;
	error: string | null;
	hint?: string;
	disabled?: boolean;
}): ReactElement {
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
									<KitRoles kit={kit} className="m-0 grid grid-cols-2 gap-x-3 text-[11px]" />
								</RadixSelect.Item>
							))}
						</RadixSelect.Viewport>
					</RadixSelect.Content>
				</RadixSelect.Portal>
			</RadixSelect.Root>
			{selected ? (
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
