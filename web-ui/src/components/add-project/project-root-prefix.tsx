import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactElement } from "react";

/**
 * The fixed, read-only start of every project path: "<root>/". With several allowed roots it is a small selector;
 * the user only edits what comes after it.
 */
export function ProjectRootPrefix({
	roots,
	value,
	onChange,
	disabled = false,
}: {
	roots: string[];
	value: string;
	onChange: (root: string) => void;
	disabled?: boolean;
}): ReactElement {
	if (roots.length <= 1) {
		return (
			<span
				data-testid="project-root-prefix"
				className="pl-2.5 pr-0.5 text-[13px] font-mono text-text-tertiary select-none shrink-0"
			>
				{`${value}/`}
			</span>
		);
	}
	return (
		<RadixSelect.Root value={value} onValueChange={onChange} disabled={disabled}>
			<RadixSelect.Trigger
				aria-label="Projects root"
				data-testid="project-root-prefix"
				className="ml-1 flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1.5 text-[13px] font-mono text-text-secondary outline-none hover:bg-surface-3 focus:border-border-focus disabled:cursor-default"
			>
				<RadixSelect.Value>{`${value}/`}</RadixSelect.Value>
				<RadixSelect.Icon>
					<ChevronDown size={12} className="text-text-tertiary" />
				</RadixSelect.Icon>
			</RadixSelect.Trigger>
			<RadixSelect.Portal>
				<RadixSelect.Content
					className="z-50 max-h-72 overflow-auto rounded-lg border border-border bg-surface-1 p-1 shadow-xl"
					position="popper"
					sideOffset={4}
					align="start"
				>
					<RadixSelect.Viewport>
						{roots.map((root) => (
							<RadixSelect.Item
								key={root}
								value={root}
								className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-mono text-text-secondary outline-none data-highlighted:bg-surface-3 data-highlighted:text-text-primary data-[state=checked]:text-text-primary"
							>
								<RadixSelect.ItemText>{`${root}/`}</RadixSelect.ItemText>
								<RadixSelect.ItemIndicator className="ml-auto">
									<Check size={14} className="text-accent" />
								</RadixSelect.ItemIndicator>
							</RadixSelect.Item>
						))}
					</RadixSelect.Viewport>
				</RadixSelect.Content>
			</RadixSelect.Portal>
		</RadixSelect.Root>
	);
}

/** "<root>/" prefix plus the text field for one directory name after it. */
export function ProjectNameField({
	id,
	ariaLabel,
	roots,
	root,
	onRootChange,
	value,
	onChange,
	placeholder,
	disabled = false,
	inputRef,
}: {
	id: string;
	ariaLabel: string;
	roots: string[];
	root: string;
	onRootChange: (root: string) => void;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	disabled?: boolean;
	inputRef?: React.RefObject<HTMLInputElement>;
}): ReactElement {
	return (
		<div className="flex items-center h-8 rounded-md border border-border bg-surface-2 focus-within:border-accent">
			<ProjectRootPrefix roots={roots} value={root} onChange={onRootChange} disabled={disabled} />
			<input
				ref={inputRef}
				type="text"
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				className="flex-1 min-w-0 h-full px-0.5 pr-2.5 text-[13px] font-mono bg-transparent text-text-primary placeholder:text-text-tertiary focus:outline-none border-none"
				disabled={disabled}
				aria-label={ariaLabel}
				autoComplete="off"
				spellCheck={false}
			/>
		</div>
	);
}
