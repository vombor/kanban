import * as Collapsible from "@radix-ui/react-collapsible";
import * as RadixPopover from "@radix-ui/react-popover";
import { ChevronDown, ChevronUp, Lightbulb } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
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

const TIPS_LABEL = "Tips & shortcuts";

/**
 * The top bar's lightbulb button (left of the settings cog): a popover with the agent tips and the keyboard shortcuts.
 * Radix Popover moves focus into it and closes it on Esc or an outside click.
 */
export function TipsPopover({
	showAgentHints,
	className,
}: {
	showAgentHints: boolean;
	className?: string;
}): React.ReactElement {
	return (
		<RadixPopover.Root>
			<Tooltip side="bottom" content={TIPS_LABEL}>
				<RadixPopover.Trigger asChild>
					<Button
						variant="ghost"
						size="sm"
						icon={<Lightbulb size={16} />}
						aria-label={TIPS_LABEL}
						data-testid="open-tips-button"
						className={className}
					/>
				</RadixPopover.Trigger>
			</Tooltip>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="end"
					sideOffset={4}
					collisionPadding={8}
					aria-label={TIPS_LABEL}
					className="z-50 flex w-72 max-w-[calc(100vw-16px)] flex-col gap-2 rounded-md border border-border-bright bg-surface-1 px-3 py-2.5 shadow-xl outline-none"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
				>
					<div className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
						<Lightbulb size={12} className="text-status-gold" />
						{TIPS_LABEL}
					</div>
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
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
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
