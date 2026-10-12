import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddProjectDialog } from "@/components/add-project-dialog";
import { PROJECT_NAME_CHECK_DEBOUNCE_MS } from "@/hooks/use-project-name-check";

const trpc = vi.hoisted(() => ({
	roots: vi.fn(),
	checkName: vi.fn(),
	create: vi.fn(),
	add: vi.fn(),
	listDirectoryContents: vi.fn(),
	pickDirectory: vi.fn(),
	kits: vi.fn(),
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		projects: {
			roots: { query: trpc.roots },
			checkName: { query: trpc.checkName },
			create: { mutate: trpc.create },
			add: { mutate: trpc.add },
			listDirectoryContents: { query: trpc.listDirectoryContents },
			pickDirectory: { mutate: trpc.pickDirectory },
			kits: { query: trpc.kits },
		},
	}),
}));

vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));

function kitRole(role: "dev" | "qa" | "plan" | "fallback", fields: Record<string, unknown> = {}) {
	return { role, defined: false, agentId: null, provider: null, model: null, tier: null, ...fields };
}

const KITS = {
	defaultKitName: "default",
	kits: [
		{
			name: "default",
			description: "Kanban's selected agent for every card",
			origin: "built-in",
			roles: [kitRole("dev"), kitRole("qa"), kitRole("plan"), kitRole("fallback")],
		},
		{
			name: "team",
			description: "The team workflow: QA, rework, automatic fallback",
			origin: "built-in",
			roles: [kitRole("dev"), kitRole("qa"), kitRole("plan"), kitRole("fallback")],
		},
		{
			name: "team-foo",
			description: "Foo's own team",
			origin: "user",
			roles: [
				kitRole("dev", { defined: true, agentId: "claude" }),
				kitRole("qa"),
				kitRole("plan"),
				kitRole("fallback"),
			],
		},
	],
	teamKitName: "team",
	presets: [
		{
			name: "lemonade",
			description: "Local models on Lemonade",
			roles: [
				kitRole("dev", { defined: true, agentId: "cline", provider: "lemonade", model: "Muse-GGUF", tier: "dev" }),
				kitRole("qa", { defined: true, agentId: "cline", provider: "lemonade", model: "gemma-GGUF" }),
				kitRole("plan", { defined: true, agentId: "cline", provider: "lemonade", model: "Muse-GGUF" }),
				kitRole("fallback", { defined: true, provider: "lemonade", model: "Laguna-GGUF" }),
			],
		},
		{
			name: "cloud",
			description: "Cloud models on AWS Bedrock",
			roles: [
				kitRole("dev", { defined: true, agentId: "codex", provider: "bedrock", model: "gpt-sol" }),
				kitRole("qa", { defined: true, agentId: "cline", provider: "bedrock", model: "haiku" }),
				kitRole("plan", { defined: true, agentId: "cline", provider: "bedrock", model: "opus" }),
				kitRole("fallback", { defined: true, agentId: "codex", provider: "bedrock", model: "kimi" }),
			],
		},
	],
	errors: [],
};

const PROJECT = { id: "p1", path: "/projects/my-app", name: "my-app", taskCounts: {} };

function nameCheck(overrides: Partial<{ ok: boolean; exists: boolean; isGitRepository: boolean; isEmpty: boolean }>) {
	return { ok: true, exists: false, isGitRepository: false, isEmpty: false, ...overrides };
}

describe("AddProjectDialog", () => {
	let container: HTMLDivElement;
	let root: Root;
	const onProjectAdded = vi.fn();
	const onOpenChange = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		for (const mock of Object.values(trpc)) {
			mock.mockReset();
		}
		onProjectAdded.mockReset();
		onOpenChange.mockReset();
		trpc.roots.mockResolvedValue({ roots: ["/projects"] });
		trpc.kits.mockResolvedValue(KITS);
		trpc.checkName.mockResolvedValue(nameCheck({}));
		trpc.listDirectoryContents.mockResolvedValue({
			ok: true,
			currentPath: "/projects",
			parentPath: null,
			rootPath: "/",
			entries: [
				{ name: "app-a", path: "/projects/app-a", isGitRepository: true },
				{ name: "notes", path: "/projects/notes", isGitRepository: false },
			],
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});

	async function flush(ms = 0): Promise<void> {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});
	}

	async function renderDialog(): Promise<void> {
		act(() => {
			root.render(
				<AddProjectDialog
					open
					onOpenChange={onOpenChange}
					onProjectAdded={onProjectAdded}
					currentProjectId={null}
				/>,
			);
		});
		await flush();
	}

	function body(): HTMLElement {
		return document.body;
	}

	function byLabel<T extends HTMLElement>(label: string): T {
		const element = body().querySelector<T>(`[aria-label="${label}"]`);
		if (!element) {
			throw new Error(`No element labelled ${label}`);
		}
		return element;
	}

	function button(text: string): HTMLButtonElement {
		const found = Array.from(body().querySelectorAll("button")).find((item) => item.textContent?.trim() === text);
		if (!found) {
			throw new Error(`No button ${text}`);
		}
		return found;
	}

	async function click(element: HTMLElement): Promise<void> {
		await act(async () => {
			element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
	}

	async function type(input: HTMLInputElement, value: string): Promise<void> {
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	async function choose(select: HTMLSelectElement, value: string): Promise<void> {
		await act(async () => {
			select.value = value;
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
	}

	function status(): HTMLElement | null {
		return body().querySelector('[data-testid="project-name-status"]');
	}

	async function openNewProject(): Promise<void> {
		await renderDialog();
		await click(button("New project"));
	}

	it("offers Open folder, Clone from URL and New project, starting on Open folder", async () => {
		await renderDialog();
		const tabs = Array.from(body().querySelectorAll('[role="tab"]')).map((tab) => tab.textContent);
		expect(tabs).toEqual(["Open folder", "Clone from URL", "New project"]);
		expect(body().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Open folder");
	});

	it("shows the root as a read-only prefix in every mode", async () => {
		await renderDialog();
		for (const mode of ["Open folder", "Clone from URL", "New project"]) {
			await click(button(mode));
			const prefix = body().querySelector('[data-testid="project-root-prefix"]');
			expect(prefix?.tagName, mode).toBe("SPAN");
			expect(prefix?.textContent).toBe("/projects/");
		}
	});

	it("makes the prefix a selector of the roots when there are several", async () => {
		trpc.roots.mockResolvedValue({ roots: ["/projects", "/work"] });
		await renderDialog();
		const prefix = body().querySelector('[data-testid="project-root-prefix"]');
		expect(prefix?.tagName).toBe("BUTTON");
		expect(prefix?.getAttribute("role")).toBe("combobox");
		expect(prefix?.textContent).toContain("/projects/");
	});

	it("shows an error and no form when there is no projects root", async () => {
		trpc.roots.mockResolvedValue({
			roots: [],
			error: "No projects root exists (/projects, setting projects.roots).",
		});
		await renderDialog();
		expect(body().querySelector('[role="alert"]')?.textContent).toContain("No projects root exists");
		expect(body().querySelector('[role="listbox"]')).toBeNull();
	});

	describe("Open folder", () => {
		it("lists the root's folders one level deep and adds the picked one", async () => {
			trpc.add.mockResolvedValue({ ok: true, project: PROJECT });
			await renderDialog();
			expect(trpc.listDirectoryContents).toHaveBeenCalledWith({ path: "/projects" });
			const options = Array.from(body().querySelectorAll('[role="option"]')).map((option) => option.textContent);
			expect(options).toEqual(["app-a", "notes"]);
			expect(button("Add Project").disabled).toBe(true);

			await click(body().querySelector('[role="option"]') as HTMLElement);
			expect(body().querySelector('[data-testid="open-folder-selection"]')?.textContent).toBe("app-a");
			await click(button("Add Project"));
			expect(trpc.add).toHaveBeenCalledWith({ path: "/projects/app-a", initializeGit: false, kit: "default" });
			expect(onProjectAdded).toHaveBeenCalledWith("p1");
		});

		it("shows the server's refusal inline", async () => {
			trpc.add.mockResolvedValue({
				ok: false,
				project: null,
				error: "/elsewhere is outside the projects root /projects.",
			});
			await renderDialog();
			await click(body().querySelector('[role="option"]') as HTMLElement);
			await click(button("Add Project"));
			expect(body().querySelector('[role="alert"]')?.textContent).toContain("outside the projects root");
			expect(onProjectAdded).not.toHaveBeenCalled();
		});
	});

	describe("New project", () => {
		it("defaults the directory to the slugified name, branch main, initial commit on", async () => {
			await openNewProject();
			await type(byLabel("Project name"), "My App!");
			expect(byLabel<HTMLInputElement>("New project directory name").value).toBe("my-app");
			expect(byLabel<HTMLInputElement>("Initial branch").value).toBe("main");
			expect(byLabel("Initial commit").getAttribute("data-state")).toBe("checked");
		});

		it("disables Create while the check is pending, then enables it when the name is available", async () => {
			await openNewProject();
			await type(byLabel("Project name"), "My App");
			expect(status()?.dataset.status).toBe("checking");
			expect(button("Create Project").disabled).toBe(true);

			await flush(PROJECT_NAME_CHECK_DEBOUNCE_MS);
			expect(trpc.checkName).toHaveBeenCalledWith({ root: "/projects", name: "my-app" });
			expect(status()?.dataset.status).toBe("available");
			expect(status()?.textContent).toContain("/projects/my-app is available");
			expect(button("Create Project").disabled).toBe(false);
		});

		it("checks only the last name typed (debounced)", async () => {
			await openNewProject();
			await type(byLabel("Project name"), "a");
			await type(byLabel("Project name"), "ab");
			await type(byLabel("Project name"), "abc");
			await flush(PROJECT_NAME_CHECK_DEBOUNCE_MS);
			expect(trpc.checkName).toHaveBeenCalledOnce();
			expect(trpc.checkName).toHaveBeenCalledWith({ root: "/projects", name: "abc" });
		});

		it("blocks an existing git repo with a hint to use Open folder", async () => {
			trpc.checkName.mockResolvedValue(nameCheck({ exists: true, isGitRepository: true }));
			await openNewProject();
			await type(byLabel("Project name"), "app-a");
			await flush(PROJECT_NAME_CHECK_DEBOUNCE_MS);
			expect(status()?.dataset.status).toBe("exists");
			expect(status()?.textContent).toContain('git repository. Use "Open folder"');
			expect(button("Create Project").disabled).toBe(true);
		});

		it("blocks an existing non-empty directory and allows an empty one", async () => {
			trpc.checkName.mockResolvedValueOnce(nameCheck({ exists: true }));
			await openNewProject();
			await type(byLabel("Project name"), "notes");
			await flush(PROJECT_NAME_CHECK_DEBOUNCE_MS);
			expect(status()?.textContent).toContain("already exists and is not empty");
			expect(button("Create Project").disabled).toBe(true);

			trpc.checkName.mockResolvedValueOnce(nameCheck({ exists: true, isEmpty: true }));
			await type(byLabel("New project directory name"), "empty");
			await flush(PROJECT_NAME_CHECK_DEBOUNCE_MS);
			expect(status()?.dataset.status).toBe("exists-empty");
			expect(button("Create Project").disabled).toBe(false);
		});

		it("refuses invalid names locally without asking the server", async () => {
			await openNewProject();
			await type(byLabel("Project name"), "Valid");
			for (const [name, message] of [
				["a/b", "slashes"],
				["..", "not a directory name"],
				["bad name", "letters, digits"],
			] as const) {
				await type(byLabel("New project directory name"), name);
				await flush(PROJECT_NAME_CHECK_DEBOUNCE_MS);
				expect(status()?.dataset.status, name).toBe("invalid");
				expect(status()?.textContent).toContain(message);
				expect(button("Create Project").disabled).toBe(true);
			}
			expect(trpc.checkName).not.toHaveBeenCalled();
			await type(byLabel("New project directory name"), "");
			expect(button("Create Project").disabled).toBe(true);
		});

		it("creates the project with the chosen options and closes", async () => {
			trpc.create.mockResolvedValue({ ok: true, project: PROJECT, notes: [] });
			await openNewProject();
			await type(byLabel("Project name"), "My App");
			await type(byLabel("Initial branch"), "trunk");
			await click(byLabel("Initial commit"));
			await flush(PROJECT_NAME_CHECK_DEBOUNCE_MS);
			await click(button("Create Project"));
			expect(trpc.create).toHaveBeenCalledWith({
				path: "/projects/my-app",
				name: "My App",
				initialBranch: "trunk",
				initialCommit: false,
				kit: "default",
			});
			expect(onProjectAdded).toHaveBeenCalledWith("p1");
			expect(onOpenChange).toHaveBeenCalledWith(false);
		});

		it("shows the server's re-check when the name was taken after the typeahead said available", async () => {
			trpc.create.mockResolvedValue({
				ok: false,
				project: null,
				notes: [],
				error: '/projects/my-app already exists and is not empty. To add existing files, use "Open folder".',
			});
			await openNewProject();
			await type(byLabel("Project name"), "My App");
			await flush(PROJECT_NAME_CHECK_DEBOUNCE_MS);
			expect(status()?.dataset.status).toBe("available");
			await click(button("Create Project"));
			expect(body().querySelector('[role="alert"]')?.textContent).toContain("already exists and is not empty");
			expect(onProjectAdded).not.toHaveBeenCalled();
			expect(onOpenChange).not.toHaveBeenCalled();
		});
	});

	describe("Clone from URL", () => {
		it("defaults the directory to the repo name, checks it and clones into the root", async () => {
			trpc.add.mockResolvedValue({ ok: true, project: PROJECT });
			await renderDialog();
			await click(button("Clone from URL"));
			expect(button("Clone & Add").disabled).toBe(true);
			await type(byLabel("Git URL input"), "https://github.com/user/My-Repo.git");
			expect(byLabel<HTMLInputElement>("Clone directory name").placeholder).toBe("My-Repo");
			await flush(PROJECT_NAME_CHECK_DEBOUNCE_MS);
			expect(trpc.checkName).toHaveBeenCalledWith({ root: "/projects", name: "My-Repo" });
			await click(button("Clone & Add"));
			expect(trpc.add).toHaveBeenCalledWith({
				gitUrl: "https://github.com/user/My-Repo.git",
				path: "/projects/My-Repo",
				kit: "default",
			});
			expect(onProjectAdded).toHaveBeenCalledWith("p1");
		});

		it("blocks a directory that already exists", async () => {
			trpc.checkName.mockResolvedValue(nameCheck({ exists: true, isGitRepository: true }));
			await renderDialog();
			await click(button("Clone from URL"));
			await type(byLabel("Git URL input"), "https://github.com/user/app-a.git");
			await flush(PROJECT_NAME_CHECK_DEBOUNCE_MS);
			expect(status()?.dataset.status).toBe("exists");
			expect(button("Clone & Add").disabled).toBe(true);
		});
	});

	describe("Routing kit", () => {
		function kitTrigger(): HTMLElement {
			return byLabel("Routing kit");
		}

		async function pickKit(name: string): Promise<void> {
			await act(async () => {
				kitTrigger().focus();
				kitTrigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			});
			await flush();
			const option = body().querySelector<HTMLElement>(`[data-testid="add-project-kit-option-${name}"]`);
			if (!option) {
				throw new Error(`No kit option ${name}`);
			}
			await act(async () => {
				option.focus();
				option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			});
			await flush();
		}

		beforeEach(() => {
			Element.prototype.scrollIntoView ??= vi.fn();
		});

		it("preselects default and shows the picked kit's description and four role models", async () => {
			await renderDialog();
			expect(trpc.kits).toHaveBeenCalledOnce();
			expect(kitTrigger().textContent).toContain("default");
			const summary = body().querySelector('[data-testid="add-project-kit-summary"]');
			expect(summary?.textContent).toContain("Kanban's selected agent for every card");
			expect(Array.from(summary?.querySelectorAll("dt") ?? []).map((term) => term.textContent)).toEqual([
				"dev",
				"qa",
				"plan",
				"fallback",
			]);
			expect(summary?.textContent).toContain("none (no QA)");
			expect(body().textContent).toContain("A project that is already added keeps its kit.");
		});

		it("lists every kit with its description and roles, user kits marked", async () => {
			await renderDialog();
			await act(async () => {
				kitTrigger().focus();
				kitTrigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			});
			await flush();
			const team = body().querySelector('[data-testid="add-project-kit-option-team"]');
			expect(team?.textContent).toContain("The team workflow: QA, rework, automatic fallback");
			expect(team?.textContent).toContain("models: lemonade, cloud or your own");
			const foo = body().querySelector('[data-testid="add-project-kit-option-team-foo"]');
			expect(foo?.textContent).toContain("user kit");
			expect(foo?.textContent).toContain("claude");
		});

		it("sends the picked kit with New project, Open folder and Clone", async () => {
			trpc.create.mockResolvedValue({ ok: true, project: PROJECT, notes: [] });
			trpc.add.mockResolvedValue({ ok: true, project: PROJECT });
			await openNewProject();
			await pickKit("team");
			expect(kitTrigger().textContent).toContain("team");
			// The first preset is preselected, with its four role models.
			expect(byLabel<HTMLSelectElement>("Models").value).toBe("lemonade");
			expect(body().querySelector('[data-testid="add-project-kit-preset-summary"]')?.textContent).toContain(
				"cline, gemma-GGUF (lemonade)",
			);
			expect(body().querySelector('[data-testid="add-project-kit-fallback-note"]')?.textContent).toContain(
				"a paid fallback model runs and costs without approval",
			);
			await choose(byLabel<HTMLSelectElement>("Models"), "cloud");
			expect(body().querySelector('[data-testid="add-project-kit-preset-summary"]')?.textContent).toContain(
				"codex, gpt-sol (bedrock)",
			);
			await type(byLabel("Project name"), "My App");
			await flush(PROJECT_NAME_CHECK_DEBOUNCE_MS);
			await click(button("Create Project"));
			expect(trpc.create).toHaveBeenCalledWith(expect.objectContaining({ kit: "team", preset: "cloud" }));

			// The pick stays when switching modes.
			await click(button("Open folder"));
			await pickKit("team-foo");
			await click(body().querySelector('[role="option"]') as HTMLElement);
			await click(button("Add Project"));
			expect(trpc.add).toHaveBeenLastCalledWith({ path: "/projects/app-a", initializeGit: false, kit: "team-foo" });

			await click(button("Clone from URL"));
			expect(kitTrigger().textContent).toContain("team-foo");
			await type(byLabel("Git URL input"), "https://github.com/user/repo.git");
			await flush(PROJECT_NAME_CHECK_DEBOUNCE_MS);
			await click(button("Clone & Add"));
			expect(trpc.add).toHaveBeenLastCalledWith(expect.objectContaining({ kit: "team-foo" }));
		});

		it("a custom team needs its dev and QA agents and sends its role models", async () => {
			trpc.create.mockResolvedValue({ ok: true, project: PROJECT, notes: [] });
			await openNewProject();
			await pickKit("team");
			await choose(byLabel<HTMLSelectElement>("Models"), "custom");
			await type(byLabel("Project name"), "My App");
			await flush(PROJECT_NAME_CHECK_DEBOUNCE_MS);
			expect(body().textContent).toContain("Pick the dev and qa agents of the custom team.");
			expect(button("Create Project").disabled).toBe(true);
			await choose(byLabel<HTMLSelectElement>("dev agent"), "codex");
			await type(byLabel("dev provider"), "bedrock");
			await type(byLabel("dev model"), "gpt-sol");
			expect(body().textContent).toContain("Pick the qa agent of the custom team.");
			await choose(byLabel<HTMLSelectElement>("qa agent"), "claude");
			expect(button("Create Project").disabled).toBe(false);
			await click(button("Create Project"));
			expect(trpc.create).toHaveBeenCalledWith(
				expect.objectContaining({
					kit: "team",
					preset: null,
					roleSettings: {
						"roles.dev.agent": "codex",
						"roles.dev.model": "gpt-sol",
						"roles.dev.provider": "bedrock",
						"roles.qa.agent": "claude",
					},
				}),
			);
		});

		it("falls back to default and says so when the kits can't be loaded", async () => {
			trpc.kits.mockRejectedValue(new Error("server gone"));
			trpc.add.mockResolvedValue({ ok: true, project: PROJECT });
			await renderDialog();
			expect(body().textContent).toContain("Kits unavailable (server gone); the project starts on default.");
			await click(body().querySelector('[role="option"]') as HTMLElement);
			await click(button("Add Project"));
			expect(trpc.add).toHaveBeenCalledWith({ path: "/projects/app-a", initializeGit: false, kit: "default" });
		});
	});
});
