import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Ellipsis } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-is-mobile";

/** Actions on the selected project (next to the project dropdown). */
export function ProjectActionsMenu({
	isRemoving,
	disabled,
	onRemove,
}: {
	isRemoving: boolean;
	disabled: boolean;
	onRemove: () => void;
}): React.ReactElement {
	const isMobile = useIsMobile();
	return (
		<DropdownMenu.Root>
			<Tooltip content="Project actions">
				<DropdownMenu.Trigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className={cn("w-7 shrink-0", isMobile && "min-w-[44px] min-h-[44px]")}
						icon={isRemoving ? <Spinner size={12} /> : <Ellipsis size={14} />}
						disabled={disabled}
						aria-label="Project actions"
					/>
				</DropdownMenu.Trigger>
			</Tooltip>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					side="bottom"
					align="end"
					sideOffset={4}
					className="z-50 min-w-[140px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
					onCloseAutoFocus={(event) => event.preventDefault()}
				>
					<DropdownMenu.Item
						className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-status-red cursor-pointer outline-none data-[highlighted]:bg-surface-3"
						onSelect={onRemove}
					>
						Delete
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
