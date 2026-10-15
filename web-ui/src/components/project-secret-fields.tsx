import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProjectSecretInput, ProjectSecretMetadata } from "@/runtime/types";

export function ProjectSecretFields({
	values,
	onChange,
	existing = [],
	removed = [],
	onRemove,
	disabled = false,
}: {
	values: ProjectSecretInput[];
	onChange: (values: ProjectSecretInput[]) => void;
	existing?: ProjectSecretMetadata[];
	removed?: string[];
	onRemove?: (name: string) => void;
	disabled?: boolean;
}): React.ReactElement {
	const set = (index: number, fields: Partial<ProjectSecretInput>) =>
		onChange(values.map((value, current) => (current === index ? { ...value, ...fields } : value)));
	return (
		<section className="flex flex-col gap-3" aria-label="Project secrets">
			<div className="flex items-center justify-between">
				<h3 className="text-[13px] font-semibold text-text-primary">Project secrets</h3>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					icon={<Plus size={14} />}
					disabled={disabled}
					onClick={() => onChange([...values, { name: "", value: "" }])}
				>
					Add secret
				</Button>
			</div>
			<p className="m-0 text-[12px] text-text-secondary">
				Values are stored encrypted. Kanban returns names and status, not stored values. Enter a new value to
				replace an existing secret.
			</p>
			{existing
				.filter((secret) => !removed.includes(secret.name))
				.map((secret) => (
					<div
						key={secret.name}
						className="flex items-center justify-between rounded-md border border-border bg-surface-0 px-3 py-2"
					>
						<span className="font-mono text-xs text-text-primary">{secret.name}</span>
						<div className="flex items-center gap-2">
							<span className="text-xs text-status-green">Configured</span>
							{onRemove ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									icon={<X size={14} />}
									aria-label={`Remove secret ${secret.name}`}
									disabled={disabled}
									onClick={() => onRemove(secret.name)}
								/>
							) : null}
						</div>
					</div>
				))}
			{values.map((secret, index) => (
				<div
					key={index}
					className="grid grid-cols-[1fr_auto] gap-2 rounded-lg border border-border bg-surface-0 p-3"
				>
					<label className="flex flex-col gap-1 text-xs text-text-secondary">
						Name
						<input
							aria-label={`Secret ${index + 1} name`}
							autoComplete="off"
							value={secret.name}
							onChange={(event) => set(index, { name: event.target.value })}
							disabled={disabled}
							placeholder="DATABASE_URL"
							className="h-8 rounded-md border border-border bg-surface-2 px-2 font-mono text-text-primary"
						/>
					</label>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						icon={<X size={14} />}
						aria-label={`Remove secret field ${index + 1}`}
						disabled={disabled}
						onClick={() => onChange(values.filter((_, current) => current !== index))}
					/>
					<label className="col-span-2 flex flex-col gap-1 text-xs text-text-secondary">
						Value
						<input
							aria-label={`Secret ${index + 1} value`}
							type="password"
							autoComplete="new-password"
							value={secret.value}
							onChange={(event) => set(index, { value: event.target.value })}
							disabled={disabled}
							className="h-8 rounded-md border border-border bg-surface-2 px-2 text-text-primary"
						/>
					</label>
				</div>
			))}
			{values.length === 0 && existing.length === 0 ? (
				<p className="m-0 text-[13px] text-text-secondary">
					No secrets configured. You can add them later in Edit Project.
				</p>
			) : null}
		</section>
	);
}
