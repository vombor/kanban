import { describe, expect, it } from "vitest";

import { resolveReviewedTaskId } from "../../../src/core/card-role";
import { buildQaCardTitle, buildQaPrompt, buildQaRequirements } from "../../../src/pipeline/qa-prompt";
import { getChromiumLaunchEnv, resolveShotUrl, resolveViewport, slugifyRoute } from "../../../src/pipeline/qa-shot";

// The full prompt is checked word for word against the legacy kit in test/runtime/kits/team-qa-prompt.test.ts.
const BASE_INPUT = {
	devTaskId: "d1111",
	round: 1,
	devTitle: "Add a wishlist page\nwith details",
	requirements: "Add a wishlist page.",
	repoPath: "/projects/foo",
	snapshotRef: "refs/kanban/snapshots/d1111",
	baseRef: "master",
	scratchDir: "/tmp/kanban-qa/d1111",
	outboxDir: "/tmp/kanban-qa-out/qa001",
	previousRounds: "## Claude QA d1111: FAIL\n- old",
	parts: {
		rules: [],
		blurb: "",
		notes: { screenshotFallback: "", knownBaseIssues: "", dbSetup: "" },
		serversScript: null,
	},
	kanbanHome: "~/.cline/kanban",
};

describe("QA prompt skeleton", () => {
	it("names the Kanban home it is given, and quotes earlier rounds only from round 2 on", () => {
		const prompt = buildQaPrompt(BASE_INPUT);
		expect(prompt).toContain("anywhere under ~/.cline/kanban; do NOT run any kanban command");
		expect(prompt).toContain('for Kanban dev card d1111 ("Add a wishlist page")');
		expect(prompt).not.toContain("Earlier QA rounds");
		expect(buildQaPrompt({ ...BASE_INPUT, round: 2 })).toContain(
			'Earlier QA rounds for this card (check whether each blocking issue is now fixed):\n"""\n## Claude QA d1111: FAIL\n- old\n"""',
		);
	});

	it("adds the kit's screenshot fallback and servers script to step 3c, with kanban qa shot", () => {
		const prompt = buildQaPrompt({
			...BASE_INPUT,
			parts: {
				...BASE_INPUT.parts,
				notes: { ...BASE_INPUT.parts.notes, screenshotFallback: "The admin pages need the ADMIN cookie." },
				serversScript: "data/foo/qa-servers.sh",
			},
		});
		expect(prompt).toContain(
			"Never judge UI from code alone. The admin pages need the ADMIN cookie. Fallback when the project tooling fails: start the scratch copy's servers with data/foo/qa-servers.sh (read it first for its arguments), then shoot them with kanban qa shot --base <url> --out /tmp/kanban-qa-out/qa001 --scratch /tmp/kanban-qa/d1111 --routes <route,...> (the one kanban command you may run).\n   d.",
		);
	});

	it("drops the dev prompt's FINAL STEP and puts the blurb first unless the prompt names its project", () => {
		expect(buildQaRequirements("Do it.\n\nFINAL STEP: kanban task start --task-id x", "Project: Pawsome.")).toBe(
			"Project: Pawsome.\n\nDo it.",
		);
		expect(buildQaRequirements("Project: other. Do it.", "Project: Pawsome.")).toBe("Project: other. Do it.");
		expect(buildQaCardTitle("d1111", 1, "Wishlist\nmore")).toBe("QA d1111: Wishlist");
		expect(buildQaCardTitle("d1111", 3, "Wishlist")).toBe("QA3 d1111: Wishlist");
	});
});

describe("the dev card a QA card reviews", () => {
	it("is reviewsTaskId, else a legacy QA card's prompt, else its title; never for a dev card", () => {
		expect(resolveReviewedTaskId({ role: "qa", reviewsTaskId: "d1111", prompt: "x" })).toBe("d1111");
		expect(
			resolveReviewedTaskId({
				title: "QA 08be2: old title",
				prompt: 'You are the QA reviewer (round 2) for Kanban dev card c1e30 ("x")',
			}),
		).toBe("c1e30");
		expect(resolveReviewedTaskId({ title: "QA2 abcde: Wishlist", prompt: "review it" })).toBe("abcde");
		expect(resolveReviewedTaskId({ title: "QA gate: build it", prompt: "for Kanban dev card d1111" })).toBeNull();
	});
});

describe("kanban qa shot helpers", () => {
	it("resolves viewports, route slugs and URLs as the legacy qa-shot.cjs did", () => {
		expect(resolveViewport("mobile")).toEqual({ width: 375, height: 667 });
		expect(resolveViewport("800x600")).toEqual({ width: 800, height: 600 });
		expect(resolveViewport("huge")).toEqual({ width: 1280, height: 720 });
		expect(slugifyRoute("/")).toBe("home");
		expect(slugifyRoute("/products/some-slug")).toBe("products_some_slug");
		expect(resolveShotUrl("http://127.0.0.1:3000/", "/cart")).toBe("http://127.0.0.1:3000/cart");
		expect(resolveShotUrl("http://127.0.0.1:3000", "cart")).toBe("http://127.0.0.1:3000/cart");
		expect(resolveShotUrl("http://a", "https://b/x")).toBe("https://b/x");
	});

	it("leaves the browser env alone without chromiumLibs", () => {
		const env = { PATH: "/bin" };
		expect(getChromiumLaunchEnv(null, env)).toBe(env);
		expect(getChromiumLaunchEnv("/nonexistent-libs", env)).toEqual(env);
	});
});
