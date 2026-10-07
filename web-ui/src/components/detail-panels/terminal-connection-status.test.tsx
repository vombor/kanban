import { TERMINAL_WS_CLOSE_ACK_STALL, TERMINAL_WS_CLOSE_REASONS } from "@runtime-terminal-ws-close";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	TerminalConnectionStatusDetails,
	TerminalConnectionStatusIndicator,
} from "@/components/detail-panels/terminal-connection-status";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TerminalCloseInfo } from "@/terminal/terminal-reconnect-controller";

const ackStallClose: TerminalCloseInfo = {
	socket: "stream",
	code: TERMINAL_WS_CLOSE_ACK_STALL,
	reason: TERMINAL_WS_CLOSE_REASONS[TERMINAL_WS_CLOSE_ACK_STALL],
	description: TERMINAL_WS_CLOSE_REASONS[TERMINAL_WS_CLOSE_ACK_STALL],
	at: 1,
};

describe("TerminalConnectionStatusIndicator", () => {
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

	function render(element: React.ReactElement): void {
		act(() => {
			root.render(<TooltipProvider>{element}</TooltipProvider>);
		});
	}

	it("shows the attempt while reconnecting", () => {
		render(
			<TerminalConnectionStatusIndicator
				status={{ state: "reconnecting", attempt: 3, waitingFor: null, lastClose: ackStallClose }}
				onRetry={() => {}}
			/>,
		);
		expect(container.textContent).toContain("Reconnecting… (attempt 3)");
	});

	it("says a hidden tab reconnects once visible", () => {
		render(
			<TerminalConnectionStatusIndicator
				status={{ state: "reconnecting", attempt: 0, waitingFor: "visibility", lastClose: ackStallClose }}
				onRetry={() => {}}
			/>,
		);
		expect(container.textContent).toContain("Reconnects when visible");
	});

	it("offers a retry button once disconnected", () => {
		const onRetry = vi.fn();
		render(
			<TerminalConnectionStatusIndicator status={{ state: "disconnected", lastClose: null }} onRetry={onRetry} />,
		);
		expect(container.textContent).toContain("Disconnected");
		const retryButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Retry"),
		);
		expect(retryButton).toBeDefined();
		act(() => {
			retryButton?.click();
		});
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("renders nothing while the first connect is in flight, or when connected in a headerless panel", () => {
		render(
			<TerminalConnectionStatusIndicator status={{ state: "connecting", lastClose: null }} onRetry={() => {}} />,
		);
		expect(container.innerHTML).toBe("");
		render(
			<TerminalConnectionStatusIndicator
				status={{ state: "connected", lastClose: null }}
				onRetry={() => {}}
				showWhenConnected={false}
			/>,
		);
		expect(container.innerHTML).toBe("");
	});

	it("puts the close code and the server's reason in the tooltip details", () => {
		render(
			<TerminalConnectionStatusDetails
				status={{ state: "reconnecting", attempt: 1, waitingFor: null, lastClose: ackStallClose }}
			/>,
		);
		expect(container.textContent).toContain("Input is blocked until the terminal reconnects.");
		expect(container.textContent).toContain(
			`Terminal stream closed (code ${TERMINAL_WS_CLOSE_ACK_STALL}): ${TERMINAL_WS_CLOSE_REASONS[TERMINAL_WS_CLOSE_ACK_STALL]}`,
		);
	});
});
