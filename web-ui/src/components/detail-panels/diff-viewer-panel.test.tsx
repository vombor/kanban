import Prism from "prismjs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type DiffLineComment, DiffViewerPanel } from "@/components/detail-panels/diff-viewer-panel";
import type { RuntimeWorkspaceFileChange } from "@/runtime/types";

const hotkeyRegistrations: Array<{
	keys: string;
	callback: (event: KeyboardEvent) => void;
}> = [];

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: (keys: string, callback: (event: KeyboardEvent) => void) => {
		hotkeyRegistrations.push({ keys, callback });
	},
}));

function createRect(top: number): DOMRect {
	return {
		x: 0,
		y: top,
		width: 600,
		height: 24,
		top,
		right: 600,
		bottom: top + 24,
		left: 0,
		toJSON: () => ({}),
	};
}

describe("DiffViewerPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		hotkeyRegistrations.length = 0;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		// Most behavior tests use the browser-without-observers fallback. Deferred
		// activation has its own controlled-observer regression below.
		vi.stubGlobal("IntersectionObserver", undefined);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("scrolls to the selected file using section position relative to the scroll container", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "src/a.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "const a = 1;\n",
				newText: "const a = 2;\n",
			},
			{
				path: "src/b.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "const b = 1;\n",
				newText: "const b = 2;\n",
			},
		];
		const comments = new Map<string, DiffLineComment>();

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={() => {}}
				/>,
			);
		});

		const sections = Array.from(container.querySelectorAll("section"));
		expect(sections).toHaveLength(2);

		const scrollContainer = sections[0]?.parentElement;
		expect(scrollContainer).toBeInstanceOf(HTMLDivElement);
		if (!(scrollContainer instanceof HTMLDivElement)) {
			throw new Error("Expected a diff scroll container.");
		}

		Object.defineProperty(scrollContainer, "scrollTop", {
			configurable: true,
			writable: true,
			value: 200,
		});
		Object.defineProperty(scrollContainer, "clientTop", {
			configurable: true,
			value: 1,
		});
		Object.defineProperty(sections[1]!, "offsetTop", {
			configurable: true,
			value: 620,
		});

		vi.spyOn(scrollContainer, "getBoundingClientRect").mockReturnValue(createRect(100));
		vi.spyOn(sections[0]!, "getBoundingClientRect").mockReturnValue(createRect(140));
		vi.spyOn(sections[1]!, "getBoundingClientRect").mockReturnValue(createRect(460));

		const originalGetComputedStyle = window.getComputedStyle.bind(window);
		vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element) => {
			if (element === scrollContainer) {
				return Object.assign({}, originalGetComputedStyle(element), { paddingTop: "12px" }) as CSSStyleDeclaration;
			}
			return originalGetComputedStyle(element);
		});

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath="src/b.ts"
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={() => {}}
				/>,
			);
		});

		expect(scrollContainer.scrollTop).toBe(547);
	});

	it("renders replaced lines side by side in split view", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 1,
				deletions: 1,
				oldText: "const value = 1;\n",
				newText: "const value = 2;\n",
			},
		];

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={new Map<string, DiffLineComment>()}
					onCommentsChange={() => {}}
					viewMode="split"
				/>,
			);
		});

		const splitRows = Array.from(container.querySelectorAll(".kb-diff-split-grid-row"));
		expect(splitRows).toHaveLength(1);
		expect(splitRows[0]?.querySelector(".kb-diff-row-removed")).toBeInstanceOf(HTMLDivElement);
		expect(splitRows[0]?.querySelector(".kb-diff-row-added")).toBeInstanceOf(HTMLDivElement);
		expect(splitRows[0]?.querySelector(".kb-diff-split-cell-placeholder")).toBeNull();
	});

	it("renders uneven split replacements with an empty placeholder cell", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 1,
				deletions: 2,
				oldText: "const first = 1;\nconst second = 2;\n",
				newText: "const value = 2;\n",
			},
		];

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={new Map<string, DiffLineComment>()}
					onCommentsChange={() => {}}
					viewMode="split"
				/>,
			);
		});

		const splitRows = Array.from(container.querySelectorAll(".kb-diff-split-grid-row"));
		expect(splitRows).toHaveLength(2);
		expect(splitRows[0]?.querySelector(".kb-diff-row-removed")).toBeInstanceOf(HTMLDivElement);
		expect(splitRows[0]?.querySelector(".kb-diff-row-added")).toBeInstanceOf(HTMLDivElement);
		expect(splitRows[1]?.querySelector(".kb-diff-row-removed")).toBeInstanceOf(HTMLDivElement);
		const placeholderCell = splitRows[1]?.querySelector(".kb-diff-split-cell-right");
		expect(placeholderCell).toBeInstanceOf(HTMLDivElement);
		expect(placeholderCell?.classList.contains("kb-diff-split-cell-placeholder")).toBe(true);
		expect(placeholderCell?.childElementCount).toBe(0);
		expect(placeholderCell?.querySelector(".kb-diff-line-number")).toBeNull();
	});

	it("does not mark the last line changed when only the final newline differs", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 0,
				deletions: 0,
				oldText: "const value = 1;",
				newText: "const value = 1;\n",
			},
		];

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={new Map<string, DiffLineComment>()}
					onCommentsChange={() => {}}
				/>,
			);
		});

		expect(container.querySelector(".kb-diff-row-added")).toBeNull();
		expect(container.querySelector(".kb-diff-row-removed")).toBeNull();
	});

	it("does not render diff rows for binary file paths", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "assets/logo.png",
				status: "modified",
				additions: 0,
				deletions: 0,
				oldText: "not real image data",
				newText: "still not real image data",
			},
		];

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={new Map<string, DiffLineComment>()}
					onCommentsChange={() => {}}
				/>,
			);
		});

		expect(container.textContent).toContain("assets/logo.png");
		expect(container.textContent).toContain("Binary");
		expect(container.querySelector(".kb-diff-row")).toBeNull();
	});

	it("shows shortcut indicators on Add and Send", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "const value = 1;\n",
				newText: "const value = 2;\n",
			},
		];
		const comments = new Map<string, DiffLineComment>([
			[
				"src/example.ts:added:1",
				{
					filePath: "src/example.ts",
					lineNumber: 1,
					lineText: "const value = 2;",
					variant: "added",
					comment: "Ship this",
				},
			],
		]);

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={() => {}}
					onAddToTerminal={() => {}}
					onSendToTerminal={() => {}}
				/>,
			);
		});

		const buttons = Array.from(container.querySelectorAll("button"));
		const addButton = buttons.find((button) => button.textContent?.includes("Add"));
		const sendButton = buttons.find((button) => button.textContent?.includes("Send"));

		expect(addButton).toBeDefined();
		expect(sendButton).toBeDefined();
		expect(container.querySelector("kbd")).toBeNull();
		expect(sendButton?.textContent).toContain("Shift");
		expect(addButton?.querySelectorAll("svg").length).toBeGreaterThan(0);
		expect(sendButton?.querySelectorAll("svg").length).toBeGreaterThan(0);
	});

	it("uses Cmd or Ctrl Enter to add comments and Cmd or Ctrl Shift Enter to send comments", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "const value = 1;\n",
				newText: "const value = 2;\n",
			},
		];
		const comments = new Map<string, DiffLineComment>([
			[
				"src/example.ts:added:1",
				{
					filePath: "src/example.ts",
					lineNumber: 1,
					lineText: "const value = 2;",
					variant: "added",
					comment: "Ship this",
				},
			],
		]);
		const onCommentsChange = vi.fn();
		const onAddToTerminal = vi.fn();
		const onSendToTerminal = vi.fn();

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={onCommentsChange}
					onAddToTerminal={onAddToTerminal}
					onSendToTerminal={onSendToTerminal}
				/>,
			);
		});

		const enterHotkey = hotkeyRegistrations.find((registration) => registration.keys === "meta+enter,ctrl+enter");
		const sendHotkey = hotkeyRegistrations.find(
			(registration) => registration.keys === "meta+shift+enter,ctrl+shift+enter",
		);

		expect(enterHotkey).toBeDefined();
		expect(sendHotkey).toBeDefined();

		act(() => {
			enterHotkey?.callback(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
		});

		expect(onAddToTerminal).toHaveBeenCalledWith("src/example.ts:1 | const value = 2;\n> Ship this");
		expect(onCommentsChange).toHaveBeenCalledWith(new Map());

		onCommentsChange.mockClear();

		act(() => {
			sendHotkey?.callback(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, shiftKey: true }));
		});

		expect(onSendToTerminal).toHaveBeenCalledWith("src/example.ts:1 | const value = 2;\n> Ship this");
		expect(onCommentsChange).toHaveBeenCalledWith(new Map());
	});

	it("highlights only displayed lines and reuses decoration on selection and comment edits", async () => {
		const highlight = vi.spyOn(Prism, "highlight");
		const oldText = Array.from({ length: 2000 }, (_, index) => `const value${index} = ${index};`).join("\n");
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "large.ts",
				status: "modified",
				additions: 1,
				deletions: 1,
				oldText,
				newText: oldText.replace("value1000 = 1000", "value1000 = 'changed'"),
			},
		];
		const onSelectedPathChange = vi.fn();
		const onCommentsChange = vi.fn();
		const render = (comments: Map<string, DiffLineComment>, selectedPath: string | null) =>
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={selectedPath}
					onSelectedPathChange={onSelectedPathChange}
					comments={comments}
					onCommentsChange={onCommentsChange}
				/>,
			);
		await act(async () => {
			render(new Map(), null);
		});
		expect(container.querySelectorAll(".kb-diff-row")).toHaveLength(8);
		expect(highlight.mock.calls.length).toBeLessThan(40);
		const initialCalls = highlight.mock.calls.length;
		await act(async () => {
			render(new Map(), "large.ts");
		});
		expect(highlight).toHaveBeenCalledTimes(initialCalls);
		const comments = new Map<string, DiffLineComment>([
			[
				"large.ts:added:1001",
				{
					filePath: "large.ts",
					lineNumber: 1001,
					lineText: "const value1000 = 'changed';",
					variant: "added",
					comment: "note",
				},
			],
		]);
		await act(async () => {
			render(comments, "large.ts");
		});
		expect(container.querySelector("textarea")?.value).toBe("note");
		expect(highlight).toHaveBeenCalledTimes(initialCalls);
	});

	it("defers offscreen files, activates at most two per frame, and cancels queued work while hidden", async () => {
		const observers: ControlledObserver[] = [];
		class ControlledObserver {
			callback: IntersectionObserverCallback;
			disconnect = vi.fn();
			observe = vi.fn();
			unobserve = vi.fn();
			constructor(callback: IntersectionObserverCallback) {
				this.callback = callback;
				observers.push(this);
			}
			emit(elements: Element[]) {
				this.callback(
					elements.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
					this as unknown as IntersectionObserver,
				);
			}
		}
		vi.stubGlobal("IntersectionObserver", ControlledObserver);
		let frameId = 0;
		const frames = new Map<number, FrameRequestCallback>();
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.set(++frameId, callback);
			return frameId;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
		const workspaceFiles: RuntimeWorkspaceFileChange[] = Array.from({ length: 6 }, (_, index) => ({
			path: `file${index}.ts`,
			status: "added",
			additions: 1,
			deletions: 0,
			oldText: null,
			newText: `const value = ${index};`,
		}));
		const comments = new Map<string, DiffLineComment>();
		const onSelectedPathChange = vi.fn();
		const onCommentsChange = vi.fn();
		const render = (isActive: boolean, selectedPath: string | null = null) =>
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={selectedPath}
					onSelectedPathChange={onSelectedPathChange}
					comments={comments}
					onCommentsChange={onCommentsChange}
					isActive={isActive}
				/>,
			);
		await act(async () => {
			render(false);
		});
		expect(observers).toHaveLength(0);
		expect(container.querySelectorAll(".kb-diff-row")).toHaveLength(0);
		await act(async () => {
			render(true);
		});
		act(() => observers[0]!.emit([...container.querySelectorAll("section")]));
		const flushFrame = () => {
			const [id, callback] = [...frames.entries()][0]!;
			frames.delete(id);
			act(() => callback(0));
		};
		flushFrame();
		expect(container.querySelectorAll(".kb-diff-row")).toHaveLength(2);
		await act(async () => {
			render(false);
		});
		expect(frames.size).toBe(0);
		expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
		await act(async () => {
			render(true, "file5.ts");
		});
		expect(container.querySelectorAll(".kb-diff-row")).toHaveLength(3);
		expect(container.querySelector('[data-diff-path="file5.ts"]')?.textContent).toContain("const value = 5;");
	});

	it("resolves scroll selection with logarithmic section reads", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = Array.from({ length: 128 }, (_, index) => ({
			path: `file${String(index).padStart(3, "0")}.txt`,
			status: "added",
			additions: 1,
			deletions: 0,
			oldText: null,
			newText: "value",
		}));
		const onSelectedPathChange = vi.fn();
		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={null}
					onSelectedPathChange={onSelectedPathChange}
					comments={new Map()}
					onCommentsChange={() => {}}
				/>,
			);
		});
		const sections = [...container.querySelectorAll("section")];
		const scrollContainer = sections[0]!.parentElement!;
		vi.spyOn(scrollContainer, "getBoundingClientRect").mockReturnValue(createRect(100));
		const reads = sections.map((section, index) =>
			vi.spyOn(section, "getBoundingClientRect").mockReturnValue(createRect(100 + (index - 100) * 200)),
		);
		act(() => {
			scrollContainer.dispatchEvent(new Event("scroll"));
		});
		expect(onSelectedPathChange).toHaveBeenCalledWith("file100.txt");
		expect(reads.reduce((count, read) => count + read.mock.calls.length, 0)).toBeLessThanOrEqual(8);
	});

	it("keeps complete long lines safe and commentable without syntax decoration", async () => {
		const text = `<img src=x onerror='alert(1)'>${"x".repeat(12_000)}`;
		const highlight = vi.spyOn(Prism, "highlight");
		const onCommentsChange = vi.fn();
		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={[
						{ path: "generated.ts", status: "added", additions: 1, deletions: 0, oldText: null, newText: text },
					]}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={new Map()}
					onCommentsChange={onCommentsChange}
				/>,
			);
		});
		expect(container.querySelector(".kb-diff-text")?.textContent).toBe(text);
		expect(container.querySelector("img")).toBeNull();
		expect(highlight).not.toHaveBeenCalled();
		act(() => {
			container.querySelector<HTMLDivElement>(".kb-diff-row-added")!.click();
		});
		expect(
			(onCommentsChange.mock.calls[0]![0] as Map<string, DiffLineComment>).get("generated.ts:added:1")?.lineText,
		).toBe(text);
	});

	it("freezes hidden file payloads and catches up without losing an expanded context block", async () => {
		const oldText = Array.from({ length: 100 }, (_, index) => `const value${index} = ${index};`).join("\n");
		const file: RuntimeWorkspaceFileChange = {
			path: "file.ts",
			status: "modified",
			additions: 1,
			deletions: 1,
			oldText,
			newText: oldText.replace("value50 = 50", "value50 = 'one'"),
		};
		const highlight = vi.spyOn(Prism, "highlight");
		const render = (workspaceFiles: RuntimeWorkspaceFileChange[], isActive: boolean) =>
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={new Map()}
					onCommentsChange={() => {}}
					isActive={isActive}
				/>,
			);
		await act(async () => {
			render([file], true);
		});
		const expand = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "↓ 20 lines",
		)!;
		act(() => expand.click());
		expect(container.querySelectorAll(".kb-diff-row")).toHaveLength(28);
		const calls = highlight.mock.calls.length;
		const changed = { ...file, newText: file.newText!.replace("'one'", "'two'") };
		await act(async () => {
			render([changed], false);
		});
		expect(highlight).toHaveBeenCalledTimes(calls);
		expect(container.querySelector(".kb-diff-row-added")?.textContent).toContain("one");
		await act(async () => {
			render([changed], true);
		});
		expect(container.querySelector(".kb-diff-row-added")?.textContent).toContain("two");
		expect(container.querySelectorAll(".kb-diff-row")).toHaveLength(28);
		await act(async () => {
			render([{ ...file, path: "a.txt", oldText: null, newText: "new file" }, changed], true);
		});
		expect(container.querySelectorAll('[data-diff-path="file.ts"] .kb-diff-row')).toHaveLength(28);
	});
});
