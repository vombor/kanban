import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeMarkdown, safeKnowledgeUrl } from "./knowledge-markdown";

describe("knowledge reference rendering", () => {
	let container: HTMLDivElement, root: Root;
	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});
	it("renders Markdown while refusing HTML, image requests and same-origin/relative/unsafe link navigation", () => {
		const markdown = `# Reviewed contract\n\n**Useful text**\n\n<script>alert(1)</script>\n<iframe src="/api/private"></iframe>\n\n![tracking](https://example.invalid/pixel.png)\n[relative](/api/private) [same](${window.location.origin}/api/private) [unsafe](javascript:alert%281%29) [credentials](https://user:password@example.invalid/) [external](https://docs.example.invalid/guide)\n\n- [ ] Reference checklist`;
		act(() => root.render(<KnowledgeMarkdown markdown={markdown} />));
		expect(container.querySelector("h1")?.textContent).toBe("Reviewed contract");
		expect(container.querySelector("strong")?.textContent).toBe("Useful text");
		expect(container.querySelectorAll("script,iframe,img,input,form,object,embed")).toHaveLength(0);
		const anchors = container.querySelectorAll("a");
		expect(anchors).toHaveLength(1);
		expect(anchors[0]?.href).toBe("https://docs.example.invalid/guide");
		expect(anchors[0]?.rel).toBe("noopener noreferrer");
		expect(anchors[0]?.target).toBe("_blank");
		for (const url of [
			"/api/private",
			"//example.invalid",
			"javascript:alert(1)",
			"data:text/html,bad",
			"file:///tmp/private",
			window.location.origin,
			"https://user:pw@example.invalid",
		])
			expect(safeKnowledgeUrl(url)).toBeUndefined();
	});
});
