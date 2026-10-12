import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimePipelineCardStage } from "@/runtime/types";
import { type UseRuntimeStateStreamResult, useRuntimeStateStream } from "@/runtime/use-runtime-state-stream";
import { getPipelineCardStage, setPipelineCardStages } from "@/stores/pipeline-card-stage-store";
import { getTaskTokenUsage, setTaskTokenUsage } from "@/stores/task-token-usage-store";

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readyState = FakeWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	close() {
		this.readyState = FakeWebSocket.CLOSED;
	}

	open() {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}

	sendSnapshot(projectId: string) {
		this.onmessage?.({
			data: JSON.stringify({
				type: "snapshot",
				currentProjectId: projectId,
				projects: [],
				workspaceState: null,
				workspaceMetadata: null,
			}),
		});
	}

	send(message: unknown) {
		this.onmessage?.({ data: JSON.stringify(message) });
	}

	// A socket a tunnel dropped silently: no close event reaches the page.
	dieSilently() {
		this.readyState = FakeWebSocket.CLOSED;
	}
}

function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
	document.dispatchEvent(new Event("visibilitychange"));
}

function Harness({ onState }: { onState: (state: UseRuntimeStateStreamResult) => void }): null {
	const state = useRuntimeStateStream("project-1");
	useEffect(() => {
		onState(state);
	}, [onState, state]);
	return null;
}

describe("useRuntimeStateStream reconnect", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latest: UseRuntimeStateStreamResult | null = null;
	const originalWebSocket = globalThis.WebSocket;

	beforeEach(() => {
		vi.useFakeTimers();
		FakeWebSocket.instances = [];
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => {
			root.render(
				<Harness
					onState={(state) => {
						latest = state;
					}}
				/>,
			);
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		globalThis.WebSocket = originalWebSocket;
		setPipelineCardStages([]);
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
		vi.useRealTimers();
	});

	const current = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as FakeWebSocket;

	it("names the page's own origin, which the server can't see behind a tunnel", () => {
		const url = new URL(current().url);
		expect(url.pathname).toBe("/api/runtime/ws");
		expect(url.searchParams.get("pageOrigin")).toBe(window.location.origin);
	});

	it("reconnects at once when the page becomes visible with a dead socket, and resyncs from the new snapshot", () => {
		act(() => {
			current().open();
			current().sendSnapshot("project-1");
		});
		expect(latest?.hasReceivedSnapshot).toBe(true);
		expect(FakeWebSocket.instances).toHaveLength(1);

		act(() => {
			setVisibility("hidden");
			current().dieSilently();
			setVisibility("visible");
		});
		expect(FakeWebSocket.instances).toHaveLength(2);

		act(() => {
			current().open();
			current().sendSnapshot("project-2");
		});
		expect(latest?.currentProjectId).toBe("project-2");
		expect(latest?.isRuntimeDisconnected).toBe(false);
	});

	it("reconnects after a long hidden period even if the socket still looks open", () => {
		act(() => {
			current().open();
			setVisibility("hidden");
		});
		act(() => {
			vi.advanceTimersByTime(60_000);
			setVisibility("visible");
		});
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it("keeps a healthy socket after a short hide", () => {
		act(() => {
			current().open();
			setVisibility("hidden");
			vi.advanceTimersByTime(1_000);
			setVisibility("visible");
		});
		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	it("reconnects at once when the network comes back", () => {
		act(() => {
			current().open();
			current().dieSilently();
			window.dispatchEvent(new Event("online"));
		});
		expect(FakeWebSocket.instances).toHaveLength(2);
	});
	it("keeps the pipeline card stage store on the current project's stages (issue #30)", () => {
		const stage: RuntimePipelineCardStage = {
			taskId: "8c28e",
			kind: "checks_running",
			label: "Checks running (test)",
			next: "QA next",
			qaTaskId: null,
			deadline: null,
			detail: null,
			inFlight: true,
		};
		act(() => {
			current().open();
			current().send({
				type: "snapshot",
				currentProjectId: "project-1",
				projects: [],
				workspaceState: null,
				workspaceMetadata: null,
				pipelineCardStages: [stage],
			});
		});
		expect(getPipelineCardStage("8c28e")).toEqual(stage);

		const running: RuntimePipelineCardStage = { ...stage, kind: "qa_running", label: "QA r1 running", next: null };
		act(() => {
			// Another project's stages are not this board's.
			current().send({ type: "pipeline_card_stages_updated", workspaceId: "project-2", stages: [] });
		});
		expect(getPipelineCardStage("8c28e")).toEqual(stage);
		act(() => {
			current().send({ type: "pipeline_card_stages_updated", workspaceId: "project-1", stages: [running] });
		});
		expect(getPipelineCardStage("8c28e")).toEqual(running);
		act(() => {
			current().send({ type: "pipeline_card_stages_updated", workspaceId: "project-1", stages: [] });
		});
		expect(getPipelineCardStage("8c28e")).toBeNull();
	});

	it("merges the current project's pushed token counts into the store, card by card", () => {
		const counts = (taskId: string, output: number) => ({ taskId, input: 1, output, cacheRead: 0, cacheWrite: 0 });
		setTaskTokenUsage([counts("aaaaa", 10), counts("bbbbb", 20)]);
		try {
			act(() => {
				current().open();
				current().sendSnapshot("project-1");
			});
			act(() => {
				current().send({
					type: "task_token_usage_updated",
					workspaceId: "project-2",
					usage: [counts("aaaaa", 99)],
				});
			});
			expect(getTaskTokenUsage("aaaaa")?.output).toBe(10);
			act(() => {
				current().send({
					type: "task_token_usage_updated",
					workspaceId: "project-1",
					usage: [counts("aaaaa", 15)],
				});
			});
			expect(getTaskTokenUsage("aaaaa")?.output).toBe(15);
			expect(getTaskTokenUsage("bbbbb")?.output).toBe(20);
		} finally {
			setTaskTokenUsage([]);
		}
	});
});
