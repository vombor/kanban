import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseTaskAgentModelPickerResult } from "@/components/task-agent-model-picker";
import type { RuntimeAgentId, RuntimeTaskAgentSettings } from "@/runtime/types";

vi.mock("@runtime-agent-catalog", () => ({
	getRuntimeLaunchSupportedAgentCatalog: vi.fn(() => [
		{ id: "cline", label: "Cline", binary: "cline" },
		{ id: "claude", label: "Claude Code", binary: "claude" },
		{ id: "gemini", label: "Gemini CLI", binary: "gemini" },
		{ id: "kiro", label: "Kiro", binary: "kiro-cli" },
		{ id: "opencode", label: "OpenCode", binary: "opencode" },
	]),
	getRuntimeAgentCatalogEntry: vi.fn((agentId: string) => {
		const capabilitiesByAgent: Record<
			string,
			{ label: string; modelOverride: string; effortOverride: string; providerOverride: string; docsUrl: string }
		> = {
			cline: {
				label: "Cline",
				modelOverride: "flag",
				effortOverride: "flag",
				providerOverride: "flag",
				docsUrl: "https://docs.cline.bot/cli/cli-reference",
			},
			claude: {
				label: "Claude Code",
				modelOverride: "flag",
				effortOverride: "flag",
				providerOverride: "none",
				docsUrl: "https://code.claude.com/docs/en/cli-reference",
			},
			gemini: {
				label: "Gemini CLI",
				modelOverride: "flag",
				effortOverride: "none",
				providerOverride: "none",
				docsUrl: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md",
			},
			kiro: {
				label: "Kiro",
				modelOverride: "none",
				effortOverride: "none",
				providerOverride: "none",
				docsUrl: "https://kiro.dev/docs/reference/cli-commands/",
			},
			opencode: {
				label: "OpenCode",
				modelOverride: "flag",
				effortOverride: "none",
				providerOverride: "flag",
				docsUrl: "https://opencode.ai/docs/cli/",
			},
		};
		const capabilities = capabilitiesByAgent[agentId];
		if (!capabilities) {
			return null;
		}
		return {
			id: agentId,
			label: capabilities.label,
			capabilities: {
				modelOverride: capabilities.modelOverride,
				effortOverride: capabilities.effortOverride,
				providerOverride: capabilities.providerOverride,
				docsUrl: capabilities.docsUrl,
			},
		};
	}),
}));

const AGENT_OPTIONS = [
	{ value: "", label: "Cline" },
	{ value: "claude", label: "Claude Code" },
	{ value: "gemini", label: "Gemini CLI" },
	{ value: "kiro", label: "Kiro" },
	{ value: "opencode", label: "OpenCode" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

async function openOverrideSettings(): Promise<void> {
	const settingsTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
		button.textContent?.includes("Override Agent Settings"),
	);
	expect(settingsTrigger).not.toBeUndefined();
	await act(async () => {
		(settingsTrigger as HTMLButtonElement).click();
	});
}

async function renderPicker(props: {
	agentId: RuntimeAgentId | undefined;
	agentSettings?: RuntimeTaskAgentSettings;
	onAgentSettingsChange?: (value: RuntimeTaskAgentSettings | undefined) => void;
	onAgentIdChange?: (value: RuntimeAgentId | undefined) => void;
}): Promise<void> {
	const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
	await act(async () =>
		root.render(
			<TaskAgentModelPicker
				agentId={props.agentId}
				onAgentIdChange={props.onAgentIdChange ?? (() => {})}
				agentSettings={props.agentSettings}
				onAgentSettingsChange={props.onAgentSettingsChange ?? (() => {})}
				agentOptions={AGENT_OPTIONS}
				defaultAgentId={"cline" as RuntimeAgentId}
			/>,
		),
	);
	await openOverrideSettings();
}

async function typeInto(selector: string, value: string): Promise<void> {
	const input = container.querySelector<HTMLInputElement>(selector);
	expect(input).not.toBeNull();
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, value);
		input?.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("useTaskAgentModelPicker", () => {
	it("lists every launch-supported agent once, with the default agent as the first option", async () => {
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		let snapshot: UseTaskAgentModelPickerResult | null = null;
		function Harness(): null {
			const result = useTaskAgentModelPicker({ defaultAgentId: "cline" as RuntimeAgentId });
			useEffect(() => {
				snapshot = result;
			}, [result]);
			return null;
		}
		await act(async () => root.render(<Harness />));

		expect(snapshot).not.toBeNull();
		const options = (snapshot as UseTaskAgentModelPickerResult | null)?.agentOptions ?? [];
		expect(options[0]).toEqual({ value: "", label: "Cline" });
		expect(options.filter((option) => option.label.startsWith("Cline"))).toHaveLength(1);
		expect(options.map((option) => option.value)).toEqual(["", "claude", "gemini", "kiro", "opencode"]);
	});
});

describe("TaskAgentModelPicker – flag-driven fields", () => {
	it("shows provider, model, effort and a docs link for Cline", async () => {
		await renderPicker({ agentId: "cline" as RuntimeAgentId, agentSettings: { modelId: "us.openai.gpt-6.1-sol" } });

		expect(container.querySelector('input[aria-label="Provider override"]')).not.toBeNull();
		expect(container.querySelector('input[aria-label="Model override"]')).not.toBeNull();
		expect(container.querySelector('input[aria-label="Reasoning effort override"]')).not.toBeNull();
		const docsLink = container.querySelector('a[href="https://docs.cline.bot/cli/cli-reference"]');
		expect(docsLink?.textContent).toContain("Cline command-line reference");
		expect(container.textContent).not.toContain("Cline CLI");
	});

	it("writes a typed provider into the task's agent settings", async () => {
		const onAgentSettingsChange = vi.fn();
		await renderPicker({ agentId: "cline" as RuntimeAgentId, agentSettings: undefined, onAgentSettingsChange });

		await typeInto('input[aria-label="Provider override"]', "bedrock");

		expect(onAgentSettingsChange).toHaveBeenLastCalledWith({ providerId: "bedrock" });
	});

	it("shows model and effort but no provider for Claude Code", async () => {
		await renderPicker({ agentId: "claude" as RuntimeAgentId });

		expect(container.querySelector('input[aria-label="Provider override"]')).toBeNull();
		expect(container.querySelector('input[aria-label="Model override"]')).not.toBeNull();
		expect(container.querySelector('input[aria-label="Reasoning effort override"]')).not.toBeNull();
	});

	it("hides effort for gemini and every free-text field for kiro", async () => {
		await renderPicker({ agentId: "gemini" as RuntimeAgentId });
		expect(container.querySelector('input[aria-label="Model override"]')).not.toBeNull();
		expect(container.querySelector('input[aria-label="Reasoning effort override"]')).toBeNull();

		await renderPicker({ agentId: "kiro" as RuntimeAgentId });
		expect(container.querySelector('input[aria-label="Provider override"]')).toBeNull();
		expect(container.querySelector('input[aria-label="Model override"]')).toBeNull();
		expect(container.querySelector('input[aria-label="Reasoning effort override"]')).toBeNull();
	});

	it("keeps model and clears provider when switching from Cline to gemini", async () => {
		const onAgentSettingsChange = vi.fn();
		const onAgentIdChange = vi.fn();
		await renderPicker({
			agentId: "cline" as RuntimeAgentId,
			agentSettings: { providerId: "bedrock", modelId: "kept-model" },
			onAgentSettingsChange,
			onAgentIdChange,
		});

		const select = container.querySelector("select");
		expect(select).not.toBeNull();
		await act(async () => {
			Object.defineProperty(select, "value", { writable: true, value: "gemini" });
			select?.dispatchEvent(new Event("change", { bubbles: true }));
		});

		expect(onAgentIdChange).toHaveBeenCalledWith("gemini");
		expect(onAgentSettingsChange).toHaveBeenCalledWith({ modelId: "kept-model" });
	});

	it("keeps provider when switching from Cline to opencode", async () => {
		const onAgentSettingsChange = vi.fn();
		await renderPicker({
			agentId: "cline" as RuntimeAgentId,
			agentSettings: { providerId: "bedrock", modelId: "kept-model" },
			onAgentSettingsChange,
		});

		const select = container.querySelector("select");
		await act(async () => {
			Object.defineProperty(select, "value", { writable: true, value: "opencode" });
			select?.dispatchEvent(new Event("change", { bubbles: true }));
		});

		expect(onAgentSettingsChange).not.toHaveBeenCalled();
	});
});
