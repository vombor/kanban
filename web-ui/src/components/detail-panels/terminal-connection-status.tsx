import { RotateCw, WifiOff } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { TerminalCloseInfo, TerminalConnectionStatus } from "@/terminal/terminal-reconnect-controller";

function describeStatusLabel(status: TerminalConnectionStatus): string {
	switch (status.state) {
		case "connecting":
			return "Connecting…";
		case "connected":
			return "Connected";
		case "disconnected":
			return "Disconnected";
		case "reconnecting":
			if (status.waitingFor === "visibility") {
				return "Reconnects when visible";
			}
			if (status.waitingFor === "network") {
				return "Waiting for network";
			}
			return `Reconnecting… (attempt ${status.attempt})`;
	}
}

function describeLastClose(close: TerminalCloseInfo): string {
	const socketLabel = close.socket === "stream" ? "Terminal stream" : "Control connection";
	return `${socketLabel} closed (code ${close.code}): ${close.description}`;
}

function describeStatusDetail(status: TerminalConnectionStatus): string {
	switch (status.state) {
		case "connecting":
			return "Connecting to the terminal.";
		case "connected":
			return "Terminal connected.";
		case "disconnected":
			return "Stopped reconnecting. Retry to connect again.";
		case "reconnecting":
			// Only a dropped stream socket takes input down; while just the control
			// connection reconnects, keys and output still flow.
			return status.lastClose?.socket === "control"
				? "Reconnecting the control connection. Input and output still work."
				: "Input is blocked until the terminal reconnects.";
	}
}

export function TerminalConnectionStatusDetails({ status }: { status: TerminalConnectionStatus }): ReactElement {
	return (
		<span className="flex max-w-72 flex-col gap-1">
			<span>{describeStatusDetail(status)}</span>
			{status.lastClose ? <span className="text-text-secondary">{describeLastClose(status.lastClose)}</span> : null}
		</span>
	);
}

// Small connection status for the terminal header: a dot while connected, a
// spinner while reconnecting, and a retry button once reconnecting gave up. The
// tooltip says why the last connection dropped (network vs. the server's rules).
export function TerminalConnectionStatusIndicator({
	status,
	onRetry,
	showWhenConnected = true,
	className,
}: {
	status: TerminalConnectionStatus | null;
	onRetry: () => void;
	showWhenConnected?: boolean;
	className?: string;
}): ReactElement | null {
	// The first connect is quick; showing "connecting" there would only flash.
	if (!status || status.state === "connecting") {
		return null;
	}
	if (status.state === "connected" && !showWhenConnected) {
		return null;
	}
	const label = describeStatusLabel(status);
	const tooltip = <TerminalConnectionStatusDetails status={status} />;

	if (status.state === "connected") {
		return (
			<Tooltip side="bottom" content={tooltip}>
				<span
					role="status"
					aria-label={label}
					className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
				>
					<span className="size-1.5 rounded-full bg-status-green" />
				</span>
			</Tooltip>
		);
	}

	if (status.state === "reconnecting") {
		return (
			<Tooltip side="bottom" content={tooltip}>
				<span
					role="status"
					className={cn(
						"inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-status-orange",
						className,
					)}
				>
					<Spinner size={10} className="text-status-orange" />
					{label}
				</span>
			</Tooltip>
		);
	}

	return (
		<span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
			<Tooltip side="bottom" content={tooltip}>
				<span
					role="status"
					className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-status-red"
				>
					<WifiOff size={12} />
					{label}
				</span>
			</Tooltip>
			<Button variant="ghost" size="sm" className="h-5 px-1.5" icon={<RotateCw size={12} />} onClick={onRetry}>
				Retry
			</Button>
		</span>
	);
}
