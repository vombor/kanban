import type { ReactNode } from "react";
import { act, createContext, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSettingsDialog } from "@/components/runtime-settings-dialog";
import type { RuntimeConfigResponse } from "@/runtime/types";

/*
 * Radix Select depends on pointer-capture APIs that jsdom lacks.
 * Replace it with a minimal native <select> so the theme-picker tests
 * can exercise onValueChange without fighting jsdom limitations.
 */
const RadixSelectCtx = createContext<{
	value: string;
	onValueChange: (v: string) => void;
}>({ value: "", onValueChange: () => {} });

vi.mock("@radix-ui/react-select", () => ({
	Root: ({
		value,
		onValueChange,
		children,
	}: {
		value: string;
		onValueChange: (v: string) => void;
		children: ReactNode;
	}) => {
		const open = false;
		return (
			<RadixSelectCtx.Provider value={{ value, onValueChange }}>
				<div data-radix-select-root="" data-state={open ? "open" : "closed"} data-open-setter={String(open)}>
					{typeof children === "function" ? null : children}
				</div>
			</RadixSelectCtx.Provider>
		);
	},
	Trigger: ({ children, ...props }: { children: ReactNode; "aria-label"?: string }) => {
		return (
			<button type="button" {...props} data-radix-select-trigger="">
				{children}
			</button>
		);
	},
	Value: ({ placeholder }: { placeholder?: string }) => {
		const ctx = useContext(RadixSelectCtx);
		return <span>{ctx.value || placeholder}</span>;
	},
	Icon: ({ children }: { children: ReactNode }) => <span>{children}</span>,
	Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
	Content: ({ children }: { children: ReactNode }) => <div data-radix-select-content="">{children}</div>,
	ScrollUpButton: () => null,
	ScrollDownButton: () => null,
	Viewport: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	Label: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	Separator: () => <hr />,
	Item: ({ value, children, ...rest }: { value: string; children: ReactNode }) => {
		const ctx = useContext(RadixSelectCtx);
		return (
			<button
				type="button"
				role="option"
				aria-label={value}
				data-radix-select-item=""
				onClick={() => ctx.onValueChange(value)}
				{...rest}
			>
				{children}
			</button>
		);
	},
	ItemText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
	ItemIndicator: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

const resetLayoutCustomizationsMock = vi.hoisted(() => vi.fn());
const saveConfigMock = vi.hoisted(() => vi.fn(async (_config: Record<string, unknown>) => true));
const replaceProjectShortcutsMock = vi.hoisted(() => vi.fn(async () => []));
const fetchAgentSettingsOptionsMock = vi.hoisted(() =>
	vi.fn(async (_workspaceId: string | null, agentId: string) => ({
		models: agentId === "claude" ? [{ modelId: "opus", label: "Opus", reasoningEfforts: ["low", "high"] }] : [],
		providers: [],
		efforts: [
			{ value: "low", label: "low" },
			{ value: "high", label: "high" },
		],
		source: "Agent's native catalog",
	})),
);
const catalogMock = vi.hoisted(() => {
	const flags = { modelOverride: "flag", effortOverride: "flag", providerOverride: "none" };
	const entries = [
		{ id: "cline", label: "Cline", binary: "cline", capabilities: { ...flags, providerOverride: "flag" } },
		{ id: "claude", label: "Claude Code", binary: "claude", capabilities: flags },
		{
			id: "kiro",
			label: "Kiro",
			binary: "kiro-cli",
			capabilities: { modelOverride: "none", effortOverride: "none", providerOverride: "none" },
		},
	].map((entry) => ({ ...entry, installUrl: null, autonomousArgs: [] }));
	return { entries };
});
// Also the catalog of the real src/core/task-agent-settings.ts (its relative import resolves to this module).
vi.mock("@runtime-agent-catalog", () => ({
	RUNTIME_AGENT_CATALOG: catalogMock.entries,
	getRuntimeAgentCatalogEntry: vi.fn(
		(agentId: string) => catalogMock.entries.find((entry) => entry.id === agentId) ?? null,
	),
	getRuntimeLaunchSupportedAgentCatalog: vi.fn(() => catalogMock.entries),
}));

vi.mock("@runtime-shortcuts", () => ({
	areRuntimeProjectShortcutsEqual: vi.fn(
		(left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
	),
}));

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutCustomizations: () => ({
		layoutResetNonce: 0,
		resetLayoutCustomizations: resetLayoutCustomizationsMock,
	}),
}));

vi.mock("@/runtime/use-runtime-config", () => ({
	useRuntimeConfig: (_open: boolean, _workspaceId: string | null, initialConfig?: RuntimeConfigResponse | null) => ({
		config: initialConfig ?? null,
		isLoading: false,
		isSaving: false,
		refresh: vi.fn(),
		save: saveConfigMock,
	}),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	openFileOnHost: vi.fn(async () => undefined),
	replaceProjectShortcuts: replaceProjectShortcutsMock,
	fetchAgentSettingsOptions: fetchAgentSettingsOptionsMock,
}));

vi.mock("@/utils/notification-permission", () => ({
	getBrowserNotificationPermission: () => "unsupported",
	requestBrowserNotificationPermission: vi.fn(async () => "unsupported"),
}));

function setSelectValue(select: HTMLSelectElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
	setter?.call(select, value);
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

function findAgentSelect(label: string): HTMLSelectElement {
	const select = document.body.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
	if (!select) throw new Error(`No ${label} select`);
	return select;
}

function findButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

function findButtonByAriaLabel(container: ParentNode, ariaLabel: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find(
		(button) => button.getAttribute("aria-label") === ariaLabel,
	) ?? null) as HTMLButtonElement | null;
}

const savedConfig = {
	selectedAgentId: "cline",
	selectedShortcutLabel: null,
	agentAutonomousModeEnabled: true,
	readyForReviewNotificationsEnabled: false,
	effectiveCommand: "cline",
	detectedCommands: [],
	shortcuts: [],
	commitPromptTemplate: "",
	openPrPromptTemplate: "",
	commitPromptTemplateDefault: "",
	openPrPromptTemplateDefault: "",
	globalConfigPath: null,
	projectConfigPath: null,
	kanbanPaths: {
		homePath: "/tmp/home/.kanban",
		homeSource: "default",
		worktreesRootPath: "/tmp/home/.kanban/worktrees",
		legacyWorktreeRootPaths: [],
		debugResetTargetPaths: ["/tmp/home/.kanban", "/tmp/home/.kanban/worktrees"],
		projectConfigDisplayPath: "<project>/.cline/kanban/config.json",
	},
	agents: [
		{
			id: "cline",
			label: "Cline",
			binary: "cline",
			command: "cline",
			installed: true,
		},
		{
			id: "claude",
			label: "Claude Code",
			binary: "claude",
			command: "claude",
			installed: true,
		},
	],
} as unknown as RuntimeConfigResponse;

describe("RuntimeSettingsDialog", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		resetLayoutCustomizationsMock.mockReset();
		window.localStorage.clear();
		document.documentElement.removeAttribute("data-theme");
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		document.body.innerHTML = "";
		window.localStorage.clear();
		document.documentElement.removeAttribute("data-theme");
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("lists Cline once as a launch-supported agent", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					workspaceId={"workspace-1"}
					initialConfig={savedConfig}
					onOpenChange={() => {}}
				/>,
			);
		});

		const agentRows = Array.from(document.body.querySelectorAll('[role="button"]')).filter((element) =>
			element.textContent?.includes("Cline"),
		);
		expect(agentRows).toHaveLength(1);
		expect(document.body.textContent).not.toContain("Cline CLI");
	});

	it("does not render support actions inside settings", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					workspaceId={"workspace-1"}
					initialConfig={savedConfig}
					onOpenChange={() => {}}
				/>,
			);
		});

		expect(findButtonByText(document.body, "Send feedback")).toBeNull();
		expect(findButtonByText(document.body, "Report issue")).toBeNull();
	});

	it("calls the layout reset callback when reset layout is clicked", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					workspaceId={"workspace-1"}
					initialConfig={savedConfig}
					onOpenChange={() => {}}
				/>,
			);
		});

		const resetButton = findButtonByText(document.body, "Reset layout");
		expect(resetButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			resetButton?.click();
		});

		expect(resetLayoutCustomizationsMock).toHaveBeenCalledTimes(1);
	});

	it("enables save on theme change and reverts preview on cancel", async () => {
		const handleOpenChange = vi.fn();
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					workspaceId={"workspace-1"}
					initialConfig={savedConfig}
					onOpenChange={handleOpenChange}
				/>,
			);
		});

		const saveButton = findButtonByText(document.body, "Save");
		const cancelButton = findButtonByText(document.body, "Cancel");
		const themeSelectTrigger = findButtonByAriaLabel(document.body, "Theme");

		expect(saveButton).toBeInstanceOf(HTMLButtonElement);
		expect(cancelButton).toBeInstanceOf(HTMLButtonElement);
		expect(themeSelectTrigger).toBeInstanceOf(HTMLButtonElement);
		expect(saveButton?.disabled).toBe(true);
		expect(themeSelectTrigger?.className).toContain("cursor-pointer");
		expect(themeSelectTrigger?.parentElement?.parentElement?.className).toContain("w-1/2");

		// The mock Radix Select renders items as buttons with role="option".
		// Click the Graphite option to trigger onValueChange.
		const graphiteOption = Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
			el.textContent?.includes("Graphite"),
		) as HTMLElement | undefined;
		expect(graphiteOption).toBeTruthy();
		await act(async () => {
			graphiteOption?.click();
		});

		expect(document.documentElement.getAttribute("data-theme")).toBe("graphite");
		expect(saveButton?.disabled).toBe(false);
		expect(window.localStorage.getItem("kanban.theme")).toBeNull();

		await act(async () => {
			cancelButton?.click();
		});

		expect(handleOpenChange).toHaveBeenCalledWith(false);
		expect(window.localStorage.getItem("kanban.theme")).toBeNull();
		expect(document.documentElement.getAttribute("data-theme")).toBeNull();
	});

	it("persists theme selection only after clicking save", async () => {
		const handleOpenChange = vi.fn();
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					workspaceId={"workspace-1"}
					initialConfig={savedConfig}
					onOpenChange={handleOpenChange}
				/>,
			);
		});

		const saveButton = findButtonByText(document.body, "Save");

		expect(saveButton).toBeInstanceOf(HTMLButtonElement);

		// Click the Graphite option to trigger onValueChange.
		const graphiteOption = Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
			el.textContent?.includes("Graphite"),
		) as HTMLElement | undefined;
		expect(graphiteOption).toBeTruthy();
		await act(async () => {
			graphiteOption?.click();
		});

		expect(window.localStorage.getItem("kanban.theme")).toBeNull();

		await act(async () => {
			saveButton?.click();
		});

		expect(handleOpenChange).toHaveBeenCalledWith(false);
		expect(window.localStorage.getItem("kanban.theme")).toBe("graphite");
		expect(document.documentElement.getAttribute("data-theme")).toBe("graphite");
	});

	it("saves shortcut edits through the shortcut route, not the settings save", async () => {
		saveConfigMock.mockClear();
		replaceProjectShortcutsMock.mockClear();
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					workspaceId={"workspace-1"}
					initialConfig={{ ...savedConfig, shortcuts: [{ label: "Run", command: "npm run dev", icon: "play" }] }}
					onOpenChange={vi.fn()}
				/>,
			);
		});
		await act(async () => {
			findButtonByAriaLabel(document.body, "Remove shortcut Run")?.click();
		});
		await act(async () => {
			findButtonByText(document.body, "Save")?.click();
		});

		expect(replaceProjectShortcutsMock).toHaveBeenCalledWith("workspace-1", []);
		expect(saveConfigMock).toHaveBeenCalledTimes(1);
		expect(saveConfigMock.mock.calls[0]?.[0]).not.toHaveProperty("shortcuts");
	});

	describe("default model per agent", () => {
		async function renderDialog(config: RuntimeConfigResponse = savedConfig): Promise<void> {
			saveConfigMock.mockClear();
			await act(async () => {
				root.render(
					<RuntimeSettingsDialog open={true} workspaceId={null} initialConfig={config} onOpenChange={vi.fn()} />,
				);
			});
		}

		it("saves a selected model and effort for the selected agent, preserving another agent's default", async () => {
			await renderDialog({
				...savedConfig,
				selectedAgentId: "claude",
				agentDefaults: { cline: { providerId: "bedrock", modelId: "model-kept" } },
			} as RuntimeConfigResponse);
			await act(async () => {
				setSelectValue(findAgentSelect("Claude Code default model"), "\u001fopus");
				setSelectValue(findAgentSelect("Claude Code default reasoning effort"), "high");
			});
			await act(async () => {
				findButtonByText(document.body, "Save")?.click();
			});
			expect(saveConfigMock.mock.calls[0]?.[0]).toMatchObject({
				agentDefaults: {
					claude: { modelId: "opus", reasoningEffort: "high" },
					cline: { providerId: "bedrock", modelId: "model-kept" },
				},
			});
		});

		it("shows the stored defaults and clears one when its fields are emptied", async () => {
			await renderDialog({
				...savedConfig,
				selectedAgentId: "claude",
				agentDefaults: { claude: { modelId: "opus" } },
			} as RuntimeConfigResponse);
			const model = findAgentSelect("Claude Code default model");
			expect(model.value).toBe("\u001fopus");
			expect(findButtonByText(document.body, "Save")?.disabled).toBe(true);
			await act(async () => {
				setSelectValue(model, "");
			});
			await act(async () => {
				findButtonByText(document.body, "Save")?.click();
			});
			expect(saveConfigMock.mock.calls[0]?.[0]).toMatchObject({ agentDefaults: {} });
		});

		it("disables the model of an agent that takes none at launch, with a note", async () => {
			await renderDialog({
				...savedConfig,
				selectedAgentId: "kiro",
				agents: [
					...savedConfig.agents,
					{ id: "kiro", label: "Kiro", binary: "kiro-cli", command: "kiro-cli", installed: false },
				],
			} as RuntimeConfigResponse);
			const row = document.body.querySelector('[data-testid="agent-default-kiro"]');
			const input = row?.querySelector<HTMLSelectElement>("select");
			expect(input?.disabled).toBe(true);
			expect(row?.textContent).toContain("Kiro takes no model at launch");
		});

		it("offers Cline's models.json records with no free-text Other mode", async () => {
			await renderDialog({
				...savedConfig,
				clineModelRecords: [{ providerId: "lemonade", models: ["Qwen3-Coder", "GLM-4.7-Flash-GGUF"] }],
			} as RuntimeConfigResponse);
			const select = document.body.querySelector<HTMLSelectElement>('select[aria-label="Cline default model"]');
			expect(select).not.toBeNull();
			expect(Array.from(select?.options ?? []).map((option) => option.textContent)).toEqual([
				"CLI's own model",
				"lemonade · Qwen3-Coder",
				"lemonade · GLM-4.7-Flash-GGUF",
			]);
			await act(async () => {
				if (select) {
					setSelectValue(select, select.options[1]?.value ?? "");
				}
			});
			await act(async () => {
				findButtonByText(document.body, "Save")?.click();
			});
			expect(saveConfigMock.mock.calls[0]?.[0]).toMatchObject({
				agentDefaults: { cline: { providerId: "lemonade", modelId: "Qwen3-Coder" } },
			});
		});

		it("keeps a saved Cline default outside the current records in the selects", async () => {
			await renderDialog({
				...savedConfig,
				agentDefaults: { cline: { providerId: "bedrock", modelId: "anthropic.claude-x" } },
				clineModelRecords: [{ providerId: "lemonade", models: ["Qwen3-Coder"] }],
			} as RuntimeConfigResponse);
			expect(document.body.querySelector<HTMLSelectElement>('select[aria-label="Cline default model"]')?.value).toBe(
				"bedrock\u001fanthropic.claude-x",
			);
			expect(findAgentSelect("Cline default provider").value).toBe("bedrock");
			expect(document.body.querySelector('[data-testid="agent-default-cline"] input')).toBeNull();
		});

		it("groups selection and only the active agent's selects under Agents, with a distinct icon", async () => {
			await renderDialog();
			const heading = Array.from(document.body.querySelectorAll("h2")).find(
				(element) => element.textContent?.trim() === "Agents",
			);
			expect(heading?.querySelector("svg")?.classList.contains("lucide-brain-circuit")).toBe(true);
			expect(document.body.textContent).not.toContain("General");
			const box = document.body.querySelector('[data-testid="runtime-settings-agents"]');
			expect(box?.querySelectorAll('[data-testid^="agent-default-"]')).toHaveLength(1);
			expect(box?.querySelector('[data-testid="agent-default-cline"]')).not.toBeNull();
			expect(box?.querySelector('[data-testid="agent-default-claude"]')).toBeNull();
			expect(box?.querySelectorAll('[data-testid^="agent-default-"] input')).toHaveLength(0);
		});

		it("switches the visible fields with the agent selection and keeps both agents' edits", async () => {
			await renderDialog({
				...savedConfig,
				clineModelRecords: [{ providerId: "lemonade", models: ["project-model"] }],
			} as RuntimeConfigResponse);
			await act(async () => {
				setSelectValue(findAgentSelect("Cline default model"), "lemonade\u001fproject-model");
			});
			const claudeRow = Array.from(document.body.querySelectorAll<HTMLElement>('[role="button"]')).find((element) =>
				element.textContent?.startsWith("Claude Code"),
			);
			await act(async () => {
				claudeRow?.click();
			});
			expect(document.body.querySelector('[data-testid="agent-default-cline"]')).toBeNull();
			expect(document.body.querySelector('[data-testid="agent-default-claude"]')).not.toBeNull();
			await act(async () => {
				setSelectValue(findAgentSelect("Claude Code default model"), "\u001fopus");
			});
			await act(async () => {
				findButtonByText(document.body, "Save")?.click();
			});
			expect(saveConfigMock.mock.calls[0]?.[0]).toMatchObject({
				selectedAgentId: "claude",
				agentDefaults: { cline: { providerId: "lemonade", modelId: "project-model" }, claude: { modelId: "opus" } },
			});
		});
	});
});
