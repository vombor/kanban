import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ChevronRight, ChevronUp, Lightbulb } from "lucide-react";
import { useState } from "react";
import { Kbd } from "@/components/ui/kbd";
import { isMacPlatform, modifierKeyLabel } from "@/utils/platform";

const TERMINAL_AGENT_HINTS: readonly { label: string; hint: string }[] = [
	{ label: "Create tasks", hint: "Ask your agent to add tasks, link them, and start working" },
	{ label: "Break down work", hint: "Ask to decompose a complex feature into linked subtasks" },
	{ label: "Import issues", hint: "Pull issues into task cards via GitHub CLI or Linear MCP" },
];

const MOD = isMacPlatform ? "⌘" : modifierKeyLabel;
const ALT = isMacPlatform ? "⌥" : "Alt";

const ESSENTIAL_SHORTCUTS = [
	{ keys: ["C"], label: "New task" },
	{ keys: [MOD, "B"], label: "Start backlog tasks" },
	{ keys: [MOD, "Shift", "S"], label: "Settings" },
	{ keys: ["Click", MOD], label: "Hold to link tasks" },
	{ keys: [MOD, "G"], label: "Toggle git view" },
	{ keys: [MOD, "J"], label: "Toggle terminal" },
];

const MORE_SHORTCUTS = [
	{ keys: [MOD, "Shift", "A"], label: "Toggle plan / act" },
	{ keys: [ALT, "Shift", "Enter"], label: "Start and open task" },
	{ keys: [MOD, "M"], label: "Expand terminal" },
	{ keys: ["Esc"], label: "Close / back" },
];

/**
 * The sidebar's collapsible Tips section below the Kanban Agent pill: the agent tips and the keyboard shortcuts.
 * Collapsed by default; the caller keeps the open state (the pill's second click toggles it too).
 */
export function SidebarTipsSection({
	open,
	onOpenChange,
	showAgentHints,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	showAgentHints: boolean;
}): React.ReactElement {
	return (
		<Collapsible.Root open={open} onOpenChange={onOpenChange} className="shrink-0 px-3">
			<Collapsible.Trigger asChild>
				<button
					type="button"
					className="flex w-full cursor-pointer items-center gap-1 rounded-sm border-none bg-transparent px-1 py-1 text-[11px] font-medium text-text-secondary outline-none hover:text-text-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-focus"
				>
					{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
					<Lightbulb size={11} className="text-status-gold" />
					Tips
				</button>
			</Collapsible.Trigger>
			<Collapsible.Content>
				<div className="mb-1 flex flex-col gap-2 rounded-md border border-border bg-surface-2/60 px-3 py-2">
					{showAgentHints ? (
						<ul className="m-0 list-none space-y-1 pl-0">
							{TERMINAL_AGENT_HINTS.map((item) => (
								<li key={item.label} className="flex items-start gap-1.5 text-[11px] text-text-primary">
									<span className="mt-[5px] block h-1 w-1 shrink-0 rounded-full bg-text-tertiary" />
									<span>
										<span className="font-medium">{item.label}.</span> {item.hint}
									</span>
								</li>
							))}
						</ul>
					) : null}
					<KeyboardShortcuts />
				</div>
			</Collapsible.Content>
		</Collapsible.Root>
	);
}

function ShortcutHint({ keys, label }: { keys: string[]; label: string }): React.ReactElement {
	return (
		<div className="flex justify-between items-center py-px">
			<span className="text-text-tertiary text-xs">{label}</span>
			<span className="inline-flex items-center gap-0.5">
				{keys.map((key, i) => (
					<Kbd key={`${key}-${i}`}>{key}</Kbd>
				))}
			</span>
		</div>
	);
}

function KeyboardShortcuts(): React.ReactElement {
	const [expanded, setExpanded] = useState(false);

	return (
		<div aria-label="Keyboard shortcuts" role="group">
			<div className="flex flex-col gap-0.5">
				{ESSENTIAL_SHORTCUTS.map((s) => (
					<ShortcutHint key={s.label} keys={s.keys} label={s.label} />
				))}
			</div>
			<Collapsible.Root open={expanded} onOpenChange={setExpanded}>
				<Collapsible.Content>
					<div className="flex flex-col gap-0.5">
						{MORE_SHORTCUTS.map((s) => (
							<ShortcutHint key={s.label} keys={s.keys} label={s.label} />
						))}
					</div>
				</Collapsible.Content>
				<Collapsible.Trigger asChild>
					<button
						type="button"
						className="flex items-center gap-1 mt-1.5 text-xs text-text-tertiary hover:text-text-secondary cursor-pointer bg-transparent border-none p-0"
					>
						{expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
						{expanded ? "Less" : "All shortcuts"}
					</button>
				</Collapsible.Trigger>
			</Collapsible.Root>
		</div>
	);
}
