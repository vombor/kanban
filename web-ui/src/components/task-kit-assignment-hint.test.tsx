import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskKitAssignmentHint } from "@/components/task-kit-assignment-hint";
import type { RuntimeDevAssignmentResponse } from "@/runtime/types";

const PROPOSAL = {
	agentId: "cline",
	agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" },
	tier: "tier3",
} satisfies NonNullable<RuntimeDevAssignmentResponse["proposal"]>;

describe("TaskKitAssignmentHint", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
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
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	function render(element: ReactElement): string {
		act(() => {
			root.render(element);
		});
		return container.textContent ?? "";
	}

	it('says "from kit team" while the proposal is selected', () => {
		const devAssignment = { kitName: "team", outcome: "applied", proposal: PROPOSAL } as const;
		expect(
			render(
				<TaskKitAssignmentHint
					devAssignment={devAssignment}
					agentId="cline"
					agentSettings={{ ...PROPOSAL.agentSettings }}
				/>,
			),
		).toBe("from kit team");
		expect(
			render(<TaskKitAssignmentHint devAssignment={devAssignment} agentId="claude" agentSettings={undefined} />),
		).toBe("");
	});

	it("shows a shadow proposal as not applied", () => {
		expect(
			render(
				<TaskKitAssignmentHint
					devAssignment={{ kitName: "team", outcome: "shadow", proposal: PROPOSAL }}
					agentId={undefined}
					agentSettings={undefined}
				/>,
			),
		).toBe("Kit team would pick cline on us.openai.gpt-6.1-sol (shadow mode: not applied)");
	});

	it("shows nothing on the default kit", () => {
		expect(
			render(
				<TaskKitAssignmentHint
					devAssignment={{ kitName: "default", outcome: "none", proposal: null }}
					agentId={undefined}
					agentSettings={undefined}
				/>,
			),
		).toBe("");
	});
});
