import { Plus } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { KanbanAgentPill } from "@/components/kanban-agent-pill";
import { ProjectActionsMenu } from "@/components/project-actions-menu";
import { ProjectSwitcher } from "@/components/project-switcher";
import { SidebarTipsSection } from "@/components/sidebar-tips-section";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { RuntimeAgentId, RuntimeProjectSummary } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { useBooleanLocalStorageValue, useUnmount, useWindowEvent } from "@/utils/react-use";

const COLLAPSED_WIDTH = 48;
const SIDEBAR_COLLAPSE_THRESHOLD = 120;
const SIDEBAR_MIN_EXPANDED_WIDTH = 200;
const SIDEBAR_MAX_EXPANDED_WIDTH = 600;

export function ProjectNavigationPanel({
	projects,
	isLoadingProjects = false,
	currentProjectId,
	removingProjectId,
	isAgentOpen,
	onAgentOpenChange,
	canShowAgentSection,
	agentSectionContent,
	selectedAgentId,
	agentLabel = null,
	onSelectProject,
	onRemoveProject,
	onAddProject,
	sidebarWidth,
	setExpandedSidebarWidth,
	isCollapsed,
	setSidebarCollapsed,
}: {
	projects: RuntimeProjectSummary[];
	isLoadingProjects?: boolean;
	currentProjectId: string | null;
	removingProjectId: string | null;
	/** Whether the sidebar shows the selected project's Kanban Agent below the project dropdown. */
	isAgentOpen: boolean;
	onAgentOpenChange: (open: boolean) => void;
	canShowAgentSection: boolean;
	agentSectionContent?: ReactNode;
	selectedAgentId?: RuntimeAgentId | null;
	/** The selected project's agent (e.g. "Claude Code"), shown on the right of the Kanban Agent pill. */
	agentLabel?: string | null;
	onSelectProject: (projectId: string) => void;
	onRemoveProject: (projectId: string) => Promise<boolean>;
	onAddProject: () => void;
	sidebarWidth: number;
	setExpandedSidebarWidth: (width: number) => void;
	isCollapsed: boolean;
	setSidebarCollapsed: (collapsed: boolean, persist?: boolean) => void;
}): React.ReactElement {
	const sortedProjects = [...projects].sort((a, b) => a.path.localeCompare(b.path));
	const currentProject = sortedProjects.find((project) => project.id === currentProjectId) ?? null;
	const [isTipsOpen, setIsTipsOpen] = useBooleanLocalStorageValue(LocalStorageKey.SidebarTipsExpanded, false);

	const [pendingProjectRemoval, setPendingProjectRemoval] = useState<RuntimeProjectSummary | null>(null);
	const isProjectRemovalPending = pendingProjectRemoval !== null && removingProjectId === pendingProjectRemoval.id;
	const pendingProjectTaskCount = pendingProjectRemoval
		? pendingProjectRemoval.taskCounts.backlog +
			pendingProjectRemoval.taskCounts.in_progress +
			pendingProjectRemoval.taskCounts.review +
			pendingProjectRemoval.taskCounts.trash
		: 0;

	const isMobile = useIsMobile();
	const [isMobileClosing, setIsMobileClosing] = useState(false);

	useEffect(() => {
		if (isMobile) {
			setSidebarCollapsed(true, false);
		}
		// Only auto-collapse when crossing the mobile breakpoint, not on every isCollapsed change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isMobile]);

	const setCollapsed = useCallback(
		(collapsed: boolean) => {
			if (isMobile && collapsed) {
				setIsMobileClosing(true);
				return;
			}
			setSidebarCollapsed(collapsed, !isMobile);
		},
		[isMobile, setSidebarCollapsed],
	);

	const handleMobileCloseAnimationEnd = useCallback(() => {
		setIsMobileClosing(false);
		setSidebarCollapsed(true, false);
	}, [setSidebarCollapsed]);

	const [isDragging, setIsDragging] = useState(false);
	const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
	const previousBodyStyleRef = useRef<{ userSelect: string; cursor: string } | null>(null);

	const stopDrag = useCallback(() => {
		setIsDragging(false);
		const previousStyle = previousBodyStyleRef.current;
		if (previousStyle) {
			document.body.style.userSelect = previousStyle.userSelect;
			document.body.style.cursor = previousStyle.cursor;
			previousBodyStyleRef.current = null;
		}
		dragRef.current = null;
	}, []);

	useUnmount(stopDrag);

	const handleMouseMove = useCallback(
		(event: MouseEvent) => {
			if (!isDragging) {
				return;
			}
			const dragState = dragRef.current;
			if (!dragState) {
				return;
			}
			const delta = event.clientX - dragState.startX;
			const newWidth = dragState.startWidth + delta;
			if (newWidth < SIDEBAR_COLLAPSE_THRESHOLD) {
				if (!isCollapsed) {
					setCollapsed(true);
				}
				return;
			}
			if (isCollapsed) {
				setCollapsed(false);
			}
			setExpandedSidebarWidth(newWidth);
		},
		[isCollapsed, isDragging, setExpandedSidebarWidth, setCollapsed],
	);

	const handleMouseUp = useCallback(() => {
		if (!isDragging) {
			return;
		}
		stopDrag();
	}, [isDragging, stopDrag]);

	useWindowEvent("mousemove", isDragging ? handleMouseMove : null);
	useWindowEvent("mouseup", isDragging ? handleMouseUp : null);

	const startDrag = useCallback(
		(e: ReactMouseEvent) => {
			e.preventDefault();
			if (isDragging) {
				stopDrag();
			}
			dragRef.current = { startX: e.clientX, startWidth: isCollapsed ? COLLAPSED_WIDTH : sidebarWidth };
			setIsDragging(true);
			previousBodyStyleRef.current = {
				userSelect: document.body.style.userSelect,
				cursor: document.body.style.cursor,
			};
			document.body.style.userSelect = "none";
			document.body.style.cursor = "ew-resize";
		},
		[isCollapsed, isDragging, sidebarWidth, stopDrag],
	);

	if (isMobile && isCollapsed && !isMobileClosing) {
		return <></>;
	}

	const collapsedWidth = COLLAPSED_WIDTH;

	if (isCollapsed) {
		return (
			<aside
				className="flex flex-col items-center min-h-0 overflow-hidden bg-surface-1 relative shrink-0 py-2 gap-1.5"
				style={{
					width: collapsedWidth,
					minWidth: collapsedWidth,
					borderRight: "1px solid var(--color-divider)",
				}}
			>
				{!isMobile && (
					<div
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize sidebar"
						onMouseDown={startDrag}
						className="absolute top-0 right-0 bottom-0 w-1.5 cursor-ew-resize z-10"
					/>
				)}
				{sortedProjects.map((project) => {
					const isCurrent = currentProjectId === project.id;
					const letter = project.name.charAt(0).toUpperCase();
					return (
						<button
							key={project.id}
							type="button"
							title={project.name}
							onClick={() => {
								if (isMobile) {
									setCollapsed(false);
								}
								onSelectProject(project.id);
							}}
							className={cn(
								"rounded-md text-xs font-semibold shrink-0 border-0 cursor-pointer flex items-center justify-center",
								isMobile ? "w-11 h-11" : "w-8 h-8",
								isCurrent
									? "bg-accent text-accent-fg"
									: "bg-surface-3 text-text-secondary hover:text-text-primary hover:bg-surface-4",
							)}
						>
							{letter}
						</button>
					);
				})}
				<button
					type="button"
					title="Add project"
					onClick={onAddProject}
					disabled={removingProjectId !== null}
					className={cn(
						"rounded-md text-xs shrink-0 border-0 cursor-pointer flex items-center justify-center bg-transparent text-text-tertiary hover:text-text-secondary hover:bg-surface-2 mt-auto",
						isMobile ? "w-11 h-11" : "w-8 h-8",
					)}
				>
					<Plus size={16} />
				</button>
			</aside>
		);
	}

	return (
		<aside
			className={cn(
				"flex flex-col min-h-0 overflow-hidden bg-surface-1 shrink-0",
				isMobile ? "fixed inset-y-0 left-0 z-50 shadow-2xl" : "relative",
			)}
			onAnimationEnd={isMobileClosing ? handleMobileCloseAnimationEnd : undefined}
			style={
				isMobile
					? {
							width: "100vw",
							animation: isMobileClosing
								? "kb-sidebar-slide-out 200ms ease forwards"
								: "kb-sidebar-slide-in 200ms ease",
						}
					: {
							width: sidebarWidth,
							minWidth: SIDEBAR_MIN_EXPANDED_WIDTH,
							maxWidth: SIDEBAR_MAX_EXPANDED_WIDTH,
							borderRight: "1px solid var(--color-divider)",
						}
			}
		>
			{!isMobile && (
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize sidebar"
					onMouseDown={startDrag}
					className="absolute top-0 right-0 bottom-0 w-1.5 cursor-ew-resize z-10"
				/>
			)}
			<div style={{ padding: "12px 12px 8px" }}>
				<div className="flex items-center justify-between">
					<div className="font-semibold text-base flex items-baseline gap-1.5">
						Kanban <span className="text-text-secondary font-normal text-xs">v{__APP_VERSION__}</span>
					</div>
					{isMobile ? (
						<Button
							variant="ghost"
							size="sm"
							icon={<Plus size={16} className="rotate-45" />}
							onClick={() => setCollapsed(true)}
							aria-label="Close sidebar"
							className="min-w-[44px] min-h-[44px] -mr-2"
						/>
					) : null}
				</div>
				<div className="mt-2 flex items-center gap-1">
					<ProjectSwitcher
						projects={sortedProjects}
						currentProjectId={currentProjectId}
						isLoading={isLoadingProjects}
						disabled={removingProjectId !== null}
						onSelectProject={(projectId) => {
							onSelectProject(projectId);
							if (isMobile && !isAgentOpen) {
								setCollapsed(true);
							}
						}}
					/>
					{currentProject ? (
						<ProjectActionsMenu
							isRemoving={removingProjectId === currentProject.id}
							disabled={removingProjectId !== null && removingProjectId !== currentProject.id}
							onRemove={() => setPendingProjectRemoval(currentProject)}
						/>
					) : null}
					<Tooltip content="Add project">
						<Button
							variant="ghost"
							icon={<Plus size={16} />}
							aria-label="Add project"
							onClick={onAddProject}
							disabled={removingProjectId !== null}
						/>
					</Tooltip>
				</div>
				<div className="mt-2">
					<KanbanAgentPill
						agentLabel={agentLabel}
						isOpen={isAgentOpen}
						disabled={!canShowAgentSection}
						title={isAgentOpen ? (isTipsOpen ? "Hide tips" : "Show tips") : undefined}
						onClick={() => {
							// First click opens the agent; once it is open, the pill shows or hides the tips below it.
							if (isAgentOpen) {
								setIsTipsOpen((open) => !open);
							} else {
								onAgentOpenChange(true);
							}
						}}
					/>
				</div>
			</div>
			<SidebarTipsSection open={isTipsOpen} onOpenChange={setIsTipsOpen} showAgentHints={Boolean(selectedAgentId)} />

			{isAgentOpen ? (
				<div className="flex flex-1 min-h-0 flex-col">
					<div className="flex flex-1 min-h-0 overflow-hidden bg-surface-1 px-2 pb-2 pt-1">
						{agentSectionContent ?? (
							<div className="flex w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 text-center text-sm text-text-secondary">
								Select a project to use the agent.
							</div>
						)}
					</div>
				</div>
			) : (
				<div className="flex-1 min-h-0" />
			)}
			<AlertDialog
				open={pendingProjectRemoval !== null}
				onOpenChange={(open) => {
					if (!open && !isProjectRemovalPending) {
						setPendingProjectRemoval(null);
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>Remove Project</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription asChild>
						<div className="flex flex-col gap-3">
							<p>{pendingProjectRemoval ? pendingProjectRemoval.name : "This project"}</p>
							<p className="text-text-primary">
								This will delete all project tasks ({pendingProjectTaskCount}), remove task
								workspaces/worktrees, and stop any running processes for this project.
							</p>
							<p className="text-text-primary">This action cannot be undone.</p>
						</div>
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button
							variant="default"
							disabled={isProjectRemovalPending}
							onClick={() => {
								if (!isProjectRemovalPending) {
									setPendingProjectRemoval(null);
								}
							}}
						>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							disabled={isProjectRemovalPending}
							onClick={async () => {
								if (!pendingProjectRemoval) {
									return;
								}
								const removed = await onRemoveProject(pendingProjectRemoval.id);
								if (removed) {
									setPendingProjectRemoval(null);
								}
							}}
						>
							{isProjectRemovalPending ? (
								<>
									<Spinner size={14} />
									Removing...
								</>
							) : (
								"Remove Project"
							)}
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</aside>
	);
}
