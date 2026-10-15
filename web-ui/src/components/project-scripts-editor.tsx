import { Plus, X } from "lucide-react";
import { useId } from "react";
import { RUNTIME_SHORTCUT_ICON_OPTIONS } from "@/components/shared/runtime-shortcut-icons";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import type { RuntimeProjectShortcut } from "@/runtime/types";

export function ProjectScriptsEditor({
	scripts,
	onChange,
	disabled,
}: {
	scripts: RuntimeProjectShortcut[];
	onChange: (scripts: RuntimeProjectShortcut[]) => void;
	disabled: boolean;
}): React.ReactElement {
	const id = useId();
	const patch = (index: number, fields: Partial<RuntimeProjectShortcut>) =>
		onChange(scripts.map((script, current) => (current === index ? { ...script, ...fields } : script)));
	const add = () => {
		const names = new Set(scripts.map((script) => script.label.toLowerCase()));
		let label = "Run",
			suffix = 2;
		while (names.has(label.toLowerCase())) label = `Run ${suffix++}`;
		onChange([...scripts, { label, command: "", icon: "play" }]);
	};
	return (
		<section className="flex flex-col gap-3" aria-label="Script shortcuts">
			<div className="flex items-center justify-between">
				<h3 className="text-[13px] font-semibold text-text-primary">Script shortcuts</h3>
				<Button type="button" size="sm" variant="ghost" icon={<Plus size={14} />} onClick={add} disabled={disabled}>
					Add script
				</Button>
			</div>
			{scripts.map((script, index) => (
				<div
					key={index}
					className="grid grid-cols-[1fr_auto] gap-2 rounded-lg border border-border bg-surface-0 p-3"
				>
					<label className="flex flex-col gap-1 text-xs text-text-secondary">
						Label
						<input
							aria-label={`Script ${index + 1} label`}
							value={script.label}
							onChange={(event) => patch(index, { label: event.target.value })}
							disabled={disabled}
							className="h-8 rounded-md border border-border bg-surface-2 px-2 text-text-primary"
						/>
					</label>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						icon={<X size={14} />}
						aria-label={`Remove shortcut ${script.label}`}
						onClick={() => onChange(scripts.filter((_, current) => current !== index))}
						disabled={disabled}
					/>
					<label className="col-span-2 flex flex-col gap-1 text-xs text-text-secondary">
						Command
						<input
							aria-label={`Script ${index + 1} command`}
							value={script.command}
							onChange={(event) => patch(index, { command: event.target.value })}
							disabled={disabled}
							className="h-8 rounded-md border border-border bg-surface-2 px-2 font-mono text-text-primary"
						/>
					</label>
					<label
						htmlFor={`${id}-${index}-icon`}
						className="col-span-2 flex items-center gap-2 text-xs text-text-secondary"
					>
						Icon
						<NativeSelect
							id={`${id}-${index}-icon`}
							size="sm"
							aria-label={`Script ${index + 1} icon`}
							value={script.icon ?? "play"}
							onChange={(event) => patch(index, { icon: event.target.value })}
							disabled={disabled}
						>
							{RUNTIME_SHORTCUT_ICON_OPTIONS.map((icon) => (
								<option key={icon.value} value={icon.value}>
									{icon.label}
								</option>
							))}
						</NativeSelect>
					</label>
				</div>
			))}
			{scripts.length === 0 ? <p className="text-[13px] text-text-secondary">No shortcuts configured.</p> : null}
		</section>
	);
}
