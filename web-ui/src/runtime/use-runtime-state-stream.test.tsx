import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type UseRuntimeStateStreamResult, useRuntimeStateStream } from "@/runtime/use-runtime-state-stream";

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
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
		vi.useRealTimers();
	});

	const current = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as FakeWebSocket;

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
});
