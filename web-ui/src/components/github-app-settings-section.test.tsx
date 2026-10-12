import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubAppSettingsSection } from "@/components/github-app-settings-section";
import { GITHUB_APP_WAIT_POLL_MS } from "@/runtime/use-github-app-creation";

const trpc = vi.hoisted(() => ({
	appStatus: vi.fn(),
	startAppCreation: vi.fn(),
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		github: {
			appStatus: { query: trpc.appStatus },
			startAppCreation: { mutate: trpc.startAppCreation },
		},
	}),
}));

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const NOW = Date.parse("2026-10-12T12:00:00Z");

function app(createdAt: string) {
	return {
		appId: 4242,
		slug: "kanban-agents",
		name: "Kanban agents",
		ownerLogin: "vombor",
		htmlUrl: "https://github.com/apps/kanban-agents",
		createdAt,
		installUrl: "https://github.com/apps/kanban-agents/installations/new",
		settingsUrl: "https://github.com/settings/apps/kanban-agents",
	};
}

function status(appInfo: ReturnType<typeof app> | null) {
	return { ok: true, app: appInfo, origin: null, originSource: null };
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("GitHubAppSettingsSection", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let tab: { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> };
	let openSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		vi.setSystemTime(NOW);
		previousActEnvironment = (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		trpc.appStatus.mockReset();
		trpc.startAppCreation.mockReset();
		tab = { opener: window, location: { href: "" }, close: vi.fn() };
		openSpy = vi.spyOn(window, "open").mockImplementation(() => tab as unknown as Window);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		openSpy.mockRestore();
		vi.useRealTimers();
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	const button = () =>
		Array.from(container.querySelectorAll("button")).find((candidate) =>
			candidate.textContent?.includes("Kanban GitHub App"),
		) as HTMLButtonElement;

	it("starts the app creation on this page's origin, in a tab opened by the click, and shows when GitHub sent it back", async () => {
		trpc.appStatus.mockResolvedValue(status(null));
		let answer: (value: unknown) => void = () => {};
		trpc.startAppCreation.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		act(() => {
			root.render(<GitHubAppSettingsSection enabled />);
		});
		await flush();
		expect(container.textContent).toContain("No Kanban GitHub App on this machine yet");
		expect(container.textContent).toContain(`GitHub sends you back to ${window.location.origin}`);

		act(() => {
			button().click();
		});
		// The tab opens in the click itself, before the server answers (Safari blocks a later window.open).
		expect(openSpy).toHaveBeenCalledWith("", "_blank");
		expect(trpc.startAppCreation).toHaveBeenCalledWith({ origin: window.location.origin, org: null });
		expect(button().disabled).toBe(true);

		const startUrl = `${window.location.origin}/api/github/app/new?state=abc`;
		await act(async () => {
			answer({
				ok: true,
				startUrl,
				expiresAt: "2026-10-12T13:00:00.000Z",
				origin: window.location.origin,
				originSource: "requested",
				existing: null,
			});
			await Promise.resolve();
		});
		expect(tab.location.href).toBe(startUrl);
		expect(tab.opener).toBeNull();
		expect(container.textContent).toContain("Waiting for GitHub");
		expect(container.querySelector(`a[href="${startUrl}"]`)).not.toBeNull();

		// An older app doesn't count; the one created after the click does.
		trpc.appStatus.mockResolvedValue(status(app("2026-10-01T00:00:00.000Z")));
		await act(async () => {
			vi.advanceTimersByTime(GITHUB_APP_WAIT_POLL_MS);
		});
		await flush();
		expect(container.textContent).toContain("Waiting for GitHub");
		trpc.appStatus.mockResolvedValue(status(app(new Date(NOW + 5_000).toISOString())));
		vi.setSystemTime(NOW + 6_000);
		await act(async () => {
			vi.advanceTimersByTime(GITHUB_APP_WAIT_POLL_MS);
		});
		await flush();
		expect(container.textContent).toContain("Created kanban-agents");
		expect(container.textContent).toContain("kanban-agents[bot]");
		expect(
			container.querySelector('a[href="https://github.com/apps/kanban-agents/installations/new"]'),
		).not.toBeNull();
		expect(container.textContent).not.toContain("Waiting for GitHub");
	});

	it("closes the tab and shows the server's refusal", async () => {
		trpc.appStatus.mockResolvedValue(status(app("2026-10-01T00:00:00.000Z")));
		trpc.startAppCreation.mockResolvedValue({
			ok: false,
			startUrl: null,
			expiresAt: null,
			origin: null,
			originSource: null,
			existing: null,
			error: "The Kanban GitHub App is the user's to create.",
		});
		act(() => {
			root.render(<GitHubAppSettingsSection enabled />);
		});
		await flush();
		expect(button().textContent).toContain("Create a new Kanban GitHub App");
		expect(container.textContent).toContain("replaces kanban-agents");

		act(() => {
			button().click();
		});
		await flush();
		expect(tab.close).toHaveBeenCalled();
		expect(container.textContent).toContain("is the user's to create");
		expect(button().disabled).toBe(false);
	});

	it("doesn't ask the server while the dialog is closed", async () => {
		act(() => {
			root.render(<GitHubAppSettingsSection enabled={false} />);
		});
		await flush();
		expect(trpc.appStatus).not.toHaveBeenCalled();
	});
});
