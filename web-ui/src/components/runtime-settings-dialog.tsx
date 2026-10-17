// Settings dialog composition for Kanban.
// Generic app settings. Every agent, Cline included, is a CLI configured by its own tooling.
import * as RadixCheckbox from "@radix-ui/react-checkbox";
import * as RadixSelect from "@radix-ui/react-select";
import * as RadixSwitch from "@radix-ui/react-switch";
import { getRuntimeAgentCatalogEntry, getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import { normalizeRuntimeAgentDefaultSettings, type RuntimeAgentDefaultSettings } from "@runtime-task-agent-settings";
import {
	Bell,
	BrainCircuit,
	Check,
	ChevronDown,
	Circle,
	CircleDot,
	ExternalLink,
	GitCommit,
	Github,
	Network,
	Palette,
	Settings,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDefaultModelFields } from "@/components/agent-default-model-fields";
import { GitHubAppSettingsSection } from "@/components/github-app-settings-section";
import { ObsidianConnectorSettingsSection } from "@/components/obsidian-connector-settings-section";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { TASK_GIT_BASE_REF_PROMPT_VARIABLE, type TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { useObsidianConnector } from "@/hooks/use-obsidian-connector";
import { useProviderConcurrencyDraft } from "@/hooks/use-provider-concurrency-draft";
import { previewThemeId, readStoredThemeId, saveThemeId, THEME_GROUPS, THEMES, type ThemeId } from "@/hooks/use-theme";
import { useWakeNoticePresentationDraft } from "@/hooks/use-wake-notice-presentation-draft";
import { useLayoutCustomizations } from "@/resize/layout-customizations";
import type { RuntimeAgentId, RuntimeConfigResponse } from "@/runtime/types";
import { useRuntimeConfig } from "@/runtime/use-runtime-config";
import {
	getOrchestratorWaitNotificationsEnabled,
	setOrchestratorWaitNotificationsEnabled,
} from "@/stores/orchestrator-wait-notifications-store";
import {
	type BrowserNotificationPermission,
	getBrowserNotificationPermission,
	requestBrowserNotificationPermission,
} from "@/utils/notification-permission";
import { useUnmount, useWindowEvent } from "@/utils/react-use";

interface RuntimeSettingsAgentRowModel {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	command: string;
	installed: boolean | null;
}

function quoteCommandPartForDisplay(part: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(part)) {
		return part;
	}
	return JSON.stringify(part);
}

function buildDisplayedAgentCommand(agentId: RuntimeAgentId, binary: string, autonomousModeEnabled: boolean): string {
	const args = autonomousModeEnabled ? (getRuntimeAgentCatalogEntry(agentId)?.autonomousArgs ?? []) : [];
	return [binary, ...args.map(quoteCommandPartForDisplay)].join(" ");
}

function normalizeTemplateForComparison(value: string): string {
	return value.replaceAll("\r\n", "\n").trim();
}

const GIT_PROMPT_VARIANT_OPTIONS: Array<{ value: TaskGitAction; label: string }> = [
	{ value: "commit", label: "Commit" },
	{ value: "pr", label: "Make PR" },
];

const SETTINGS_AGENT_ORDER: readonly RuntimeAgentId[] = ["cline", "claude", "codex", "droid", "kiro"];

type SettingsNavId = "agents" | "git-prompts" | "notifications" | "appearance" | "github" | "knowledge";

const SETTINGS_NAV_ITEMS: ReadonlyArray<{
	id: SettingsNavId;
	label: string;
	icon: React.ReactNode;
}> = [
	{ id: "agents", label: "Agents", icon: <BrainCircuit size={16} /> },
	{ id: "git-prompts", label: "Git Prompts", icon: <GitCommit size={16} /> },
	{ id: "notifications", label: "Notifications", icon: <Bell size={16} /> },
	{ id: "appearance", label: "Appearance", icon: <Palette size={16} /> },
	{ id: "github", label: "GitHub App", icon: <Github size={16} /> },
	{ id: "knowledge", label: "Knowledge", icon: <Network size={16} /> },
];

function formatNotificationPermissionStatus(permission: BrowserNotificationPermission): string {
	if (permission === "default") {
		return "not requested yet";
	}
	return permission;
}

function AgentRow({
	agent,
	isSelected,
	onSelect,
	disabled,
}: {
	agent: RuntimeSettingsAgentRowModel;
	isSelected: boolean;
	onSelect: () => void;
	disabled: boolean;
}): React.ReactElement {
	const installUrl = getRuntimeAgentCatalogEntry(agent.id)?.installUrl;
	const isInstalled = agent.installed === true;
	const isInstallStatusPending = agent.installed === null;

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={() => {
				if (isInstalled && !disabled) {
					onSelect();
				}
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" && isInstalled && !disabled) {
					onSelect();
				}
			}}
			className="flex items-center justify-between gap-3 py-1.5"
			style={{ cursor: isInstalled ? "pointer" : "default" }}
		>
			<div className="flex items-start gap-2 min-w-0">
				{isSelected ? (
					<CircleDot size={16} className="text-accent mt-0.5 shrink-0" />
				) : (
					<Circle
						size={16}
						className={cn("mt-0.5 shrink-0", !isInstalled ? "text-text-tertiary" : "text-text-secondary")}
					/>
				)}
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="text-[13px] text-text-primary">{agent.label}</span>
						{isInstalled ? (
							<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-status-green/10 text-status-green">
								Installed
							</span>
						) : isInstallStatusPending ? (
							<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-surface-3 text-text-secondary">
								Checking...
							</span>
						) : null}
					</div>
					{agent.command ? (
						<p className="text-text-secondary font-mono text-xs mt-0.5 m-0">{agent.command}</p>
					) : null}
				</div>
			</div>
			{agent.installed === false && installUrl ? (
				<a
					href={installUrl}
					target="_blank"
					rel="noreferrer"
					onClick={(event: React.MouseEvent) => event.stopPropagation()}
					className="inline-flex items-center justify-center rounded-md font-medium duration-150 cursor-default select-none h-7 px-2 text-xs bg-surface-2 border border-border text-text-primary hover:bg-surface-3 hover:border-border-bright"
				>
					Install
				</a>
			) : agent.installed === false ? (
				<Button size="sm" disabled>
					Install
				</Button>
			) : null}
		</div>
	);
}

function InlineUtilityButton({
	text,
	onClick,
	disabled,
	monospace,
	widthCh,
}: {
	text: string;
	onClick: () => void;
	disabled?: boolean;
	monospace?: boolean;
	widthCh?: number;
}): React.ReactElement {
	return (
		<Button
			size="sm"
			disabled={disabled}
			onClick={onClick}
			className={cn(monospace && "font-mono")}
			style={{
				fontSize: 10,
				verticalAlign: "middle",
				...(typeof widthCh === "number"
					? {
							width: `${widthCh}ch`,
							justifyContent: "center",
						}
					: {}),
			}}
		>
			{text}
		</Button>
	);
}

function SettingsNav({
	items,
	activeId,
	onSelect,
}: {
	items: ReadonlyArray<{ id: SettingsNavId; label: string; icon: React.ReactNode }>;
	activeId: SettingsNavId;
	onSelect: (id: SettingsNavId) => void;
}): React.ReactElement {
	return (
		<nav className="hidden md:flex w-[180px] shrink-0 flex-col gap-0.5 border-r border-border bg-surface-1 p-3 overflow-y-auto">
			{items.map((item) => (
				<button
					key={item.id}
					type="button"
					onClick={() => onSelect(item.id)}
					className={cn(
						"flex items-center gap-2.5 text-left px-3 py-2 rounded-md text-[13px] font-medium cursor-pointer",
						activeId === item.id
							? "bg-surface-3 text-text-primary"
							: "text-text-secondary hover:text-text-primary hover:bg-surface-2",
					)}
				>
					<span className="shrink-0 opacity-80">{item.icon}</span>
					<span>{item.label}</span>
				</button>
			))}
		</nav>
	);
}

export function RuntimeSettingsDialog({
	open,
	workspaceId,
	initialConfig = null,
	onOpenChange,
	onSaved,
}: {
	open: boolean;
	workspaceId: string | null;
	initialConfig?: RuntimeConfigResponse | null;
	onOpenChange: (open: boolean) => void;
	onSaved?: () => void;
}): React.ReactElement {
	const { config, isLoading, isSaving, save } = useRuntimeConfig(open, workspaceId, initialConfig);
	const obsidian = useObsidianConnector(open);
	const providerConcurrency = useProviderConcurrencyDraft(open, config);
	const wakeNotice = useWakeNoticePresentationDraft(open, config);
	const [isSavingSettings, setIsSavingSettings] = useState(false);
	const savingSettingsRef = useRef(false);
	const { resetLayoutCustomizations } = useLayoutCustomizations();
	const [selectedAgentId, setSelectedAgentId] = useState<RuntimeAgentId>("claude");
	const [agentDefaults, setAgentDefaults] = useState<RuntimeAgentDefaultSettings>({});
	const [agentAutonomousModeEnabled, setAgentAutonomousModeEnabled] = useState(true);
	const [readyForReviewNotificationsEnabled, setReadyForReviewNotificationsEnabled] = useState(true);
	const [initialThemeId, setInitialThemeId] = useState<ThemeId>(readStoredThemeId);
	const [draftThemeId, setDraftThemeId] = useState<ThemeId>(readStoredThemeId);
	// This browser's opt-in (local storage, like the theme), saved with the dialog.
	const [initialOrchestratorWaitNotificationsEnabled, setInitialOrchestratorWaitNotificationsEnabled] = useState(
		getOrchestratorWaitNotificationsEnabled,
	);
	const [orchestratorWaitNotificationsEnabled, setOrchestratorWaitNotificationsEnabledDraft] = useState(
		getOrchestratorWaitNotificationsEnabled,
	);
	const [notificationPermission, setNotificationPermission] = useState<BrowserNotificationPermission>("unsupported");
	const [commitPromptTemplate, setCommitPromptTemplate] = useState("");
	const [openPrPromptTemplate, setOpenPrPromptTemplate] = useState("");
	const [selectedPromptVariant, setSelectedPromptVariant] = useState<TaskGitAction>("commit");
	const [copiedVariableToken, setCopiedVariableToken] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const copiedVariableResetTimerRef = useRef<number | null>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const isScrollingProgrammatically = useRef(false);
	const [activeSection, setActiveSection] = useState<SettingsNavId>("agents");
	const controlsDisabled = isLoading || isSaving || isSavingSettings || config === null;
	const commitPromptTemplateDefault = config?.commitPromptTemplateDefault ?? "";
	const openPrPromptTemplateDefault = config?.openPrPromptTemplateDefault ?? "";
	const isCommitPromptAtDefault =
		normalizeTemplateForComparison(commitPromptTemplate) ===
		normalizeTemplateForComparison(commitPromptTemplateDefault);
	const isOpenPrPromptAtDefault =
		normalizeTemplateForComparison(openPrPromptTemplate) ===
		normalizeTemplateForComparison(openPrPromptTemplateDefault);
	const selectedPromptValue = selectedPromptVariant === "commit" ? commitPromptTemplate : openPrPromptTemplate;
	const selectedPromptDefaultValue =
		selectedPromptVariant === "commit" ? commitPromptTemplateDefault : openPrPromptTemplateDefault;
	const isSelectedPromptAtDefault =
		selectedPromptVariant === "commit" ? isCommitPromptAtDefault : isOpenPrPromptAtDefault;
	const selectedPromptPlaceholder =
		selectedPromptVariant === "commit" ? "Commit prompt template" : "PR prompt template";
	const bypassPermissionsCheckboxId = "runtime-settings-bypass-permissions";
	const refreshNotificationPermission = useCallback(() => {
		setNotificationPermission(getBrowserNotificationPermission());
	}, []);

	const supportedAgents = useMemo<RuntimeSettingsAgentRowModel[]>(() => {
		const agents =
			config?.agents.map((agent) => ({
				id: agent.id,
				label: agent.label,
				binary: agent.binary,
				installed: agent.installed,
			})) ??
			getRuntimeLaunchSupportedAgentCatalog().map((agent) => ({
				id: agent.id,
				label: agent.label,
				binary: agent.binary,
				installed: null,
			}));
		const orderIndexByAgentId = new Map(SETTINGS_AGENT_ORDER.map((agentId, index) => [agentId, index] as const));
		const orderedAgents = [...agents].sort((left, right) => {
			const leftOrderIndex = orderIndexByAgentId.get(left.id) ?? Number.MAX_SAFE_INTEGER;
			const rightOrderIndex = orderIndexByAgentId.get(right.id) ?? Number.MAX_SAFE_INTEGER;
			return leftOrderIndex - rightOrderIndex;
		});
		return orderedAgents.map((agent) => ({
			...agent,
			command: buildDisplayedAgentCommand(agent.id, agent.binary, agentAutonomousModeEnabled),
		}));
	}, [agentAutonomousModeEnabled, config?.agents]);
	const displayedAgents = useMemo(() => supportedAgents, [supportedAgents]);
	const activeAgent = displayedAgents.find((agent) => agent.id === selectedAgentId);
	const navItems = SETTINGS_NAV_ITEMS;
	const configuredAgentId = config?.selectedAgentId ?? null;
	const firstInstalledAgentId = displayedAgents.find((agent) => agent.installed)?.id;
	const fallbackAgentId = firstInstalledAgentId ?? displayedAgents[0]?.id ?? "claude";
	const initialSelectedAgentId = configuredAgentId ?? fallbackAgentId;
	const initialAgentDefaults = config?.agentDefaults;
	const initialAgentAutonomousModeEnabled = config?.agentAutonomousModeEnabled ?? true;
	const initialReadyForReviewNotificationsEnabled = config?.readyForReviewNotificationsEnabled ?? true;
	const initialCommitPromptTemplate = config?.commitPromptTemplate ?? "";
	const initialOpenPrPromptTemplate = config?.openPrPromptTemplate ?? "";
	const hasRuntimeUnsavedChanges = useMemo(() => {
		if (!config) {
			return false;
		}
		if (selectedAgentId !== initialSelectedAgentId) {
			return true;
		}
		if (
			JSON.stringify(normalizeRuntimeAgentDefaultSettings(agentDefaults)) !==
			JSON.stringify(normalizeRuntimeAgentDefaultSettings(initialAgentDefaults))
		) {
			return true;
		}
		if (agentAutonomousModeEnabled !== initialAgentAutonomousModeEnabled) {
			return true;
		}
		if (readyForReviewNotificationsEnabled !== initialReadyForReviewNotificationsEnabled) {
			return true;
		}
		if (draftThemeId !== initialThemeId) {
			return true;
		}
		if (orchestratorWaitNotificationsEnabled !== initialOrchestratorWaitNotificationsEnabled) {
			return true;
		}
		if (
			normalizeTemplateForComparison(commitPromptTemplate) !==
			normalizeTemplateForComparison(initialCommitPromptTemplate)
		) {
			return true;
		}
		return (
			normalizeTemplateForComparison(openPrPromptTemplate) !==
			normalizeTemplateForComparison(initialOpenPrPromptTemplate)
		);
	}, [
		agentAutonomousModeEnabled,
		agentDefaults,
		commitPromptTemplate,
		config,
		draftThemeId,
		initialAgentAutonomousModeEnabled,
		initialAgentDefaults,
		initialCommitPromptTemplate,
		initialOpenPrPromptTemplate,
		initialReadyForReviewNotificationsEnabled,
		initialSelectedAgentId,
		initialThemeId,
		initialOrchestratorWaitNotificationsEnabled,
		openPrPromptTemplate,
		orchestratorWaitNotificationsEnabled,
		readyForReviewNotificationsEnabled,
		selectedAgentId,
	]);
	const hasUnsavedChanges =
		hasRuntimeUnsavedChanges || obsidian.hasUnsavedChanges || providerConcurrency.dirty || wakeNotice.dirty;

	useEffect(() => {
		if (!open) {
			return;
		}
		setSelectedAgentId(configuredAgentId ?? fallbackAgentId);
		setAgentDefaults(config?.agentDefaults ?? {});
		setAgentAutonomousModeEnabled(config?.agentAutonomousModeEnabled ?? true);
		setReadyForReviewNotificationsEnabled(config?.readyForReviewNotificationsEnabled ?? true);
		setCommitPromptTemplate(config?.commitPromptTemplate ?? "");
		setOpenPrPromptTemplate(config?.openPrPromptTemplate ?? "");
		setSaveError(null);
	}, [
		config?.agentAutonomousModeEnabled,
		config?.agentDefaults,
		config?.commitPromptTemplate,
		config?.openPrPromptTemplate,
		config?.readyForReviewNotificationsEnabled,
		config?.selectedAgentId,
		fallbackAgentId,
		open,
	]);

	useEffect(() => {
		if (!open) {
			return;
		}
		const persistedThemeId = readStoredThemeId();
		setInitialThemeId(persistedThemeId);
		setDraftThemeId(persistedThemeId);
		const persistedOrchestratorWaitNotifications = getOrchestratorWaitNotificationsEnabled();
		setInitialOrchestratorWaitNotificationsEnabled(persistedOrchestratorWaitNotifications);
		setOrchestratorWaitNotificationsEnabledDraft(persistedOrchestratorWaitNotifications);
	}, [open]);

	useEffect(() => {
		if (!open) {
			return;
		}
		refreshNotificationPermission();
	}, [open, refreshNotificationPermission]);
	useWindowEvent("focus", open ? refreshNotificationPermission : null);

	useUnmount(() => {
		if (copiedVariableResetTimerRef.current !== null) {
			window.clearTimeout(copiedVariableResetTimerRef.current);
			copiedVariableResetTimerRef.current = null;
		}
	});

	const handleBodyScroll = useCallback(() => {
		if (isScrollingProgrammatically.current) return;
		const body = bodyRef.current;
		if (!body) return;
		const headings = body.querySelectorAll<HTMLElement>("[data-settings-section]");
		const bodyRect = body.getBoundingClientRect();
		let current: SettingsNavId = "agents";

		for (const heading of headings) {
			const rect = heading.getBoundingClientRect();
			if (rect.top - bodyRect.top <= 40) {
				const id = heading.getAttribute("data-settings-section");
				if (id) current = id as SettingsNavId;
			}
		}

		setActiveSection(current);
	}, []);

	const handleNavSelect = useCallback((id: SettingsNavId) => {
		setActiveSection(id);
		isScrollingProgrammatically.current = true;
		const body = bodyRef.current;
		if (!body) return;
		const target = body.querySelector(`[data-settings-section="${id}"]`);
		if (target) {
			const bodyRect = body.getBoundingClientRect();
			const targetRect = target.getBoundingClientRect();
			body.scrollTo({
				top: targetRect.top - bodyRect.top + body.scrollTop,
				behavior: "smooth",
			});
		}
		window.setTimeout(() => {
			isScrollingProgrammatically.current = false;
		}, 600);
	}, []);

	const handleCopyVariableToken = (token: string) => {
		void (async () => {
			try {
				await navigator.clipboard.writeText(token);
				setCopiedVariableToken(token);
				if (copiedVariableResetTimerRef.current !== null) {
					window.clearTimeout(copiedVariableResetTimerRef.current);
				}
				copiedVariableResetTimerRef.current = window.setTimeout(() => {
					setCopiedVariableToken((current) => (current === token ? null : current));
					copiedVariableResetTimerRef.current = null;
				}, 2000);
			} catch {
				// Ignore clipboard failures.
			}
		})();
	};

	const handleSelectedPromptChange = (value: string) => {
		if (selectedPromptVariant === "commit") {
			setCommitPromptTemplate(value);
			return;
		}
		setOpenPrPromptTemplate(value);
	};

	const handleResetSelectedPrompt = () => {
		handleSelectedPromptChange(selectedPromptDefaultValue);
	};

	const handleSave = async () => {
		if (savingSettingsRef.current || isSaving || (obsidian.busy && obsidian.hasUnsavedChanges)) return;
		setSaveError(null);
		if (!config) {
			setSaveError("Runtime settings are still loading. Try again in a moment.");
			return;
		}
		const selectedAgent = displayedAgents.find((agent) => agent.id === selectedAgentId);
		if (hasRuntimeUnsavedChanges && (!selectedAgent || selectedAgent.installed !== true)) {
			setSaveError("Selected agent is not installed. Install it first or choose an installed agent.");
			return;
		}
		savingSettingsRef.current = true;
		setIsSavingSettings(true);
		try {
			const turnedOnNotifications =
				(!initialReadyForReviewNotificationsEnabled && readyForReviewNotificationsEnabled) ||
				(!initialOrchestratorWaitNotificationsEnabled && orchestratorWaitNotificationsEnabled);
			const shouldRequestNotificationPermission = turnedOnNotifications && notificationPermission === "default";
			if (shouldRequestNotificationPermission) {
				const nextPermission = await requestBrowserNotificationPermission();
				setNotificationPermission(nextPermission);
			}
			const saved =
				(!hasRuntimeUnsavedChanges && !providerConcurrency.dirty && !wakeNotice.dirty) ||
				(await save({
					...(providerConcurrency.dirty ? { providerConcurrency: providerConcurrency.limits } : {}),
					...(wakeNotice.dirty ? { wakeNoticePresentation: wakeNotice.presentation } : {}),
					selectedAgentId,
					agentDefaults: normalizeRuntimeAgentDefaultSettings(agentDefaults),
					agentAutonomousModeEnabled,
					readyForReviewNotificationsEnabled,
					commitPromptTemplate,
					openPrPromptTemplate,
				}));
			if (!saved) {
				setSaveError("Could not save runtime settings. Check runtime logs and try again.");
				return;
			}
			if (obsidian.hasUnsavedChanges && !(await obsidian.save())) {
				setSaveError(
					hasRuntimeUnsavedChanges
						? "Runtime settings were saved, but the Obsidian connector could not be saved. Your connector draft is kept; fix it and retry."
						: "Could not save the Obsidian connector. Your draft is kept; fix it and retry.",
				);
				return;
			}
			if (draftThemeId !== initialThemeId) {
				saveThemeId(draftThemeId);
				setInitialThemeId(draftThemeId);
			}
			if (orchestratorWaitNotificationsEnabled !== initialOrchestratorWaitNotificationsEnabled) {
				setOrchestratorWaitNotificationsEnabled(orchestratorWaitNotificationsEnabled);
				setInitialOrchestratorWaitNotificationsEnabled(orchestratorWaitNotificationsEnabled);
			}
			onSaved?.();
			savingSettingsRef.current = false;
			handleDialogOpenChange(false);
		} catch {
			setSaveError("Could not finish saving settings. Changes already saved are kept; you can retry.");
		} finally {
			savingSettingsRef.current = false;
			setIsSavingSettings(false);
		}
	};

	const handleRequestPermission = () => {
		void (async () => {
			const nextPermission = await requestBrowserNotificationPermission();
			setNotificationPermission(nextPermission);
		})();
	};

	const handleDialogOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (!nextOpen && savingSettingsRef.current) return;
			if (!nextOpen) {
				const persistedThemeId = readStoredThemeId();
				if (draftThemeId !== persistedThemeId) {
					previewThemeId(persistedThemeId);
				}
				setDraftThemeId(persistedThemeId);
				setInitialThemeId(persistedThemeId);
			}
			onOpenChange(nextOpen);
		},
		[draftThemeId, onOpenChange],
	);

	const currentThemeDef = THEMES.find((t) => t.id === draftThemeId);

	return (
		<Dialog open={open} onOpenChange={handleDialogOpenChange} contentClassName="!max-w-[780px]">
			<DialogHeader title="Global Settings" icon={<Settings size={16} />} />
			<div className="border-b border-border px-5 py-2 md:hidden">
				<NativeSelect
					aria-label="Settings section"
					value={activeSection}
					onChange={(event) => {
						const item = navItems.find((entry) => entry.id === event.target.value);
						if (item) handleNavSelect(item.id);
					}}
				>
					{navItems.map((item) => (
						<option key={item.id} value={item.id}>
							{item.label}
						</option>
					))}
				</NativeSelect>
			</div>
			<div className="flex h-[min(480px,60vh)]">
				<SettingsNav items={navItems} activeId={activeSection} onSelect={handleNavSelect} />
				<div
					ref={bodyRef}
					onScroll={handleBodyScroll}
					className="px-5 pb-5 overflow-y-auto overscroll-contain flex-1 min-h-0 bg-surface-1"
				>
					{/* ---- Agents ---- */}
					<div data-settings-section="agents" />
					<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
						<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
							<BrainCircuit size={16} className="text-text-secondary" />
							Agents
						</h2>
					</div>
					<div
						className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4"
						data-testid="runtime-settings-agents"
					>
						<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-1">
							Agent
						</h6>
						{displayedAgents.map((agent) => (
							<AgentRow
								key={agent.id}
								agent={agent}
								isSelected={agent.id === selectedAgentId}
								onSelect={() => setSelectedAgentId(agent.id)}
								disabled={controlsDisabled}
							/>
						))}
						{config === null ? (
							<p className="text-text-secondary py-2">Checking which CLIs are installed for this project...</p>
						) : null}
						<label
							htmlFor={bypassPermissionsCheckboxId}
							className="flex items-center gap-2 text-[13px] text-text-primary mt-2 cursor-pointer"
						>
							<RadixCheckbox.Root
								id={bypassPermissionsCheckboxId}
								aria-label="Enable bypass permissions flag"
								checked={agentAutonomousModeEnabled}
								disabled={controlsDisabled}
								onCheckedChange={(checked) => setAgentAutonomousModeEnabled(checked === true)}
								className="flex h-4 w-4 cursor-pointer items-center justify-center rounded border border-border bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent disabled:cursor-default disabled:opacity-40"
							>
								<RadixCheckbox.Indicator>
									<Check size={12} className="text-white" />
								</RadixCheckbox.Indicator>
							</RadixCheckbox.Root>
							<span>Enable bypass permissions flag</span>
						</label>
						<p className="text-text-secondary text-[13px] ml-6 mt-0 mb-0">
							Allows agents to use tools without stopping for permission. Use at your own risk.
						</p>
						<div className="mt-3 border-t border-border pt-3">
							<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-1">
								Default model
							</h6>
							<p className="text-text-secondary text-[13px] mt-0 mb-1">
								Used at launch when a task or orchestrator names no model. A card's own model, including its
								routing kit's assignment, wins. Choose the CLI's own default to use its configuration.
							</p>
							{activeAgent ? (
								<AgentDefaultModelFields
									key={activeAgent.id}
									agentId={activeAgent.id}
									agentLabel={activeAgent.label}
									settings={agentDefaults[activeAgent.id]}
									clineModelRecords={config?.clineModelRecords ?? []}
									workspaceId={workspaceId}
									disabled={controlsDisabled}
									onChange={(settings) =>
										setAgentDefaults((current) => {
											const next = { ...current };
											if (settings) {
												next[activeAgent.id] = settings;
											} else {
												delete next[activeAgent.id];
											}
											return next;
										})
									}
								/>
							) : null}
						</div>
					</div>

					{/* ---- Git Prompts ---- */}
					<section
						aria-label="Shared provider concurrency"
						className="mb-4 space-y-2 rounded-lg border border-border bg-surface-0 px-4 py-3"
					>
						<h3 className="m-0 text-[13px] font-semibold text-text-primary">Agent coordination</h3>
						<label
							htmlFor="wake-notice-presentation"
							className="flex items-center justify-between gap-3 text-xs text-text-secondary"
						>
							<span>Watchdog sidebar notices</span>
							<NativeSelect
								id="wake-notice-presentation"
								aria-label="Watchdog sidebar notices"
								value={wakeNotice.presentation}
								disabled={controlsDisabled}
								onChange={(event) =>
									wakeNotice.setPresentation(
										event.target.value as NonNullable<RuntimeConfigResponse["wakeNoticePresentation"]>,
									)
								}
							>
								<option value="compact">Compact</option>
								<option value="hidden">Tiny notice</option>
								<option value="full">Full details</option>
							</NativeSelect>
						</label>
						<p className="m-0 text-xs text-text-tertiary">
							Full instructions remain in each project's audit log. This changes presentation, not orchestration
							or wake delivery; project overrides still take priority.
						</p>
						<p className="m-0 text-[13px] text-text-secondary">
							Opt-in maximum active turns shared by dev, QA, rework and recovery across projects. Starts wait in
							a persistent queue; existing turns are not interrupted. Project pacing can be stricter. Quota-reset
							holds still apply.
						</p>
						{providerConcurrency.providers.map((provider) => (
							<label
								key={provider}
								htmlFor={`provider-cap-${provider}`}
								className="flex items-center justify-between gap-3 text-xs text-text-secondary"
							>
								<span>{provider}</span>
								<NativeSelect
									id={`provider-cap-${provider}`}
									aria-label={`${provider} maximum active turns`}
									value={providerConcurrency.limits[provider]?.toString() ?? ""}
									disabled={controlsDisabled}
									onChange={(event) => providerConcurrency.set(provider, event.target.value)}
								>
									<option value="">Unlimited</option>
									{[
										...new Set([
											1,
											2,
											3,
											4,
											8,
											...(providerConcurrency.limits[provider]
												? [providerConcurrency.limits[provider]]
												: []),
										]),
									]
										.sort((a, b) => a - b)
										.map((limit) => (
											<option key={limit} value={limit}>
												{limit}
											</option>
										))}
								</NativeSelect>
							</label>
						))}
						<p className="m-0 text-xs text-text-tertiary">
							Provider-selecting CLIs use their provider id; opaque CLIs use agent:&lt;id&gt;. Saved unknown
							providers/limits remain editable. Direct CLI work outside Kanban is not scheduled.
						</p>
					</section>
					<div data-settings-section="git-prompts" />
					<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
						<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
							<GitCommit size={16} className="text-text-secondary" />
							Git Prompts
						</h2>
					</div>
					<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
						<p className="text-text-secondary text-[13px] mt-0 mb-2">
							Modify the prompts sent to the agent when using Commit or Make PR on tasks in Review.
						</p>
						<div className="flex items-center justify-between gap-2 mb-2">
							<NativeSelect
								value={selectedPromptVariant}
								onChange={(event) => setSelectedPromptVariant(event.target.value as TaskGitAction)}
								disabled={controlsDisabled}
								style={{ minWidth: 220 }}
							>
								{GIT_PROMPT_VARIANT_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</NativeSelect>
							<Button
								variant="ghost"
								size="sm"
								onClick={handleResetSelectedPrompt}
								disabled={controlsDisabled || isSelectedPromptAtDefault}
							>
								Reset
							</Button>
						</div>
						<textarea
							rows={5}
							value={selectedPromptValue}
							onChange={(event) => handleSelectedPromptChange(event.target.value)}
							placeholder={selectedPromptPlaceholder}
							disabled={controlsDisabled}
							className="w-full rounded-md border border-border bg-surface-2 p-3 text-[13px] text-text-primary font-mono placeholder:text-text-tertiary focus:border-border-focus focus:outline-none resize-none disabled:opacity-40"
						/>
						<p className="text-text-secondary text-[13px] mt-2 mb-0">
							Use{" "}
							<InlineUtilityButton
								text={
									copiedVariableToken === TASK_GIT_BASE_REF_PROMPT_VARIABLE.token
										? "Copied!"
										: TASK_GIT_BASE_REF_PROMPT_VARIABLE.token
								}
								monospace
								widthCh={Math.max(TASK_GIT_BASE_REF_PROMPT_VARIABLE.token.length, "Copied!".length) + 2}
								onClick={() => {
									handleCopyVariableToken(TASK_GIT_BASE_REF_PROMPT_VARIABLE.token);
								}}
								disabled={controlsDisabled}
							/>{" "}
							to reference {TASK_GIT_BASE_REF_PROMPT_VARIABLE.description}
						</p>
					</div>

					{/* ---- Notifications ---- */}
					<div data-settings-section="notifications" />
					<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
						<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
							<Bell size={16} className="text-text-secondary" />
							Notifications
						</h2>
					</div>
					<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
						<div className="flex items-center gap-2">
							<RadixSwitch.Root
								checked={readyForReviewNotificationsEnabled}
								disabled={controlsDisabled}
								onCheckedChange={setReadyForReviewNotificationsEnabled}
								className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
							>
								<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
							</RadixSwitch.Root>
							<span className="text-[13px] text-text-primary">Notify when a task is ready for review</span>
						</div>
						<div className="flex items-center gap-2 mt-2">
							<RadixSwitch.Root
								checked={orchestratorWaitNotificationsEnabled}
								disabled={controlsDisabled}
								onCheckedChange={setOrchestratorWaitNotificationsEnabledDraft}
								aria-label="Notify when a project's Kanban Agent waits for you"
								className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
							>
								<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
							</RadixSwitch.Root>
							<span className="text-[13px] text-text-primary">
								Notify when a project's Kanban Agent waits for you (this browser)
							</span>
						</div>
						<p className="text-text-tertiary text-[12px] mt-1 mb-0">
							A question or an approval in any project's sidebar agent. The badge on the project shows either
							way.
						</p>
						<div className="flex items-center gap-2 mt-2">
							<p className="text-text-secondary text-[13px] m-0">
								Browser permission: {formatNotificationPermissionStatus(notificationPermission)}
							</p>
							{notificationPermission !== "granted" && notificationPermission !== "unsupported" ? (
								<InlineUtilityButton
									text="Request permission"
									onClick={handleRequestPermission}
									disabled={controlsDisabled}
								/>
							) : null}
						</div>
					</div>

					{/* ---- Appearance ---- */}
					<div data-settings-section="appearance" />
					<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
						<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
							<Palette size={16} className="text-text-secondary" />
							Appearance
						</h2>
					</div>
					<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
						<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-2">
							Theme
						</h6>
						<div className="min-w-0 w-1/2 max-w-full">
							<RadixSelect.Root
								value={draftThemeId}
								onValueChange={(value) => {
									setDraftThemeId(value as ThemeId);
									previewThemeId(value as ThemeId);
								}}
								onOpenChange={(selectOpen) => {
									if (!selectOpen) {
										previewThemeId(draftThemeId);
									}
								}}
							>
								<RadixSelect.Trigger
									className="flex h-9 w-full cursor-pointer items-center justify-between rounded-md border border-border-bright bg-surface-2 px-3 text-[13px] text-text-primary outline-none hover:bg-surface-3 hover:border-border-bright focus:border-border-focus focus:outline-none"
									aria-label="Theme"
								>
									<span className="flex items-center gap-2.5">
										<span className="flex shrink-0 h-5 w-10 rounded overflow-hidden border border-border">
											<span
												className="flex-1"
												style={{ background: currentThemeDef?.surface ?? "#1F2428" }}
											/>
											<span
												className="flex-1"
												style={{ background: currentThemeDef?.accent ?? "#0084FF" }}
											/>
											<span
												className="flex-1"
												style={{ background: currentThemeDef?.accent2 ?? "#7C5CFF" }}
											/>
										</span>
										<RadixSelect.Value />
									</span>
									<RadixSelect.Icon>
										<ChevronDown size={14} className="text-text-tertiary" />
									</RadixSelect.Icon>
								</RadixSelect.Trigger>
								<RadixSelect.Portal>
									<RadixSelect.Content
										className="z-50 max-h-72 w-(--radix-select-trigger-width) overflow-auto rounded-lg border border-border bg-surface-1 p-1 shadow-xl"
										position="popper"
										sideOffset={4}
										align="start"
									>
										<RadixSelect.Viewport>
											{THEME_GROUPS.map((group) => {
												const groupThemes = THEMES.filter((t) => t.group === group.key);
												if (groupThemes.length === 0) return null;
												return (
													<RadixSelect.Group key={group.key}>
														<RadixSelect.Label className="px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
															{group.label}
														</RadixSelect.Label>
														{groupThemes.map((theme) => (
															<RadixSelect.Item
																key={theme.id}
																value={theme.id}
																className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text-secondary outline-none data-highlighted:bg-surface-3 data-highlighted:text-text-primary data-[state=checked]:text-text-primary"
																onMouseEnter={() => previewThemeId(theme.id)}
																onFocus={() => previewThemeId(theme.id)}
															>
																<span className="flex shrink-0 h-5 w-10 rounded overflow-hidden border border-border">
																	<span className="flex-1" style={{ background: theme.surface }} />
																	<span className="flex-1" style={{ background: theme.accent }} />
																	<span className="flex-1" style={{ background: theme.accent2 }} />
																</span>
																<RadixSelect.ItemText>{theme.label}</RadixSelect.ItemText>
																<RadixSelect.ItemIndicator className="ml-auto">
																	<Check size={14} className="text-accent-2" />
																</RadixSelect.ItemIndicator>
															</RadixSelect.Item>
														))}
													</RadixSelect.Group>
												);
											})}
										</RadixSelect.Viewport>
									</RadixSelect.Content>
								</RadixSelect.Portal>
							</RadixSelect.Root>
						</div>

						<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary mt-5 mb-2">
							Layout
						</h6>
						<Button size="sm" onClick={resetLayoutCustomizations}>
							Reset layout
						</Button>
						<p className="text-text-secondary text-[13px] mt-2 mb-0">
							Reset sidebar, split pane, and terminal resize customizations back to their defaults.
						</p>
					</div>
					{/* ---- GitHub App ---- */}
					<div data-settings-section="github" />
					<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
						<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
							<Github size={16} className="text-text-secondary" />
							GitHub App
						</h2>
					</div>
					<GitHubAppSettingsSection enabled={open} />
					<div data-settings-section="knowledge" />
					<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
						<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
							<Network size={16} className="text-text-secondary" /> Knowledge
						</h2>
					</div>
					<ObsidianConnectorSettingsSection draft={obsidian} disabled={controlsDisabled} />

					{saveError ? (
						<div className="flex gap-2 rounded-md border border-status-red/30 bg-status-red/5 p-3 text-[13px]">
							<span className="text-text-primary">{saveError}</span>
						</div>
					) : null}
				</div>
			</div>
			<DialogFooter>
				<Button
					size="sm"
					variant="ghost"
					className="mr-auto mt-[3px]"
					icon={<ExternalLink size={14} />}
					onClick={() => window.open("https://github.com/vombor/kanban#readme", "_blank")}
				>
					Read the docs
				</Button>
				<Button onClick={() => handleDialogOpenChange(false)} disabled={controlsDisabled}>
					Cancel
				</Button>
				<Button
					variant="primary"
					onClick={() => void handleSave()}
					disabled={controlsDisabled || (obsidian.busy && obsidian.hasUnsavedChanges) || !hasUnsavedChanges}
				>
					Save
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
