import type { ReactElement } from "react";

import { Spinner } from "@/components/ui/spinner";
import type { TerminalLoadingPhase, TerminalReadiness } from "@/terminal/terminal-readiness";

const PHASE_DETAILS: Record<TerminalLoadingPhase, string> = {
	connecting: "Connecting to the terminal",
	starting: "Starting the session",
	waiting_for_output: "Waiting for the agent to start",
};

// Covers the terminal until it is ready (terminal-readiness.ts). Keys and pastes
// are blocked meanwhile by the terminal itself. Once loading times out or
// reconnecting gives up, the overlay goes away and the connection status with
// its retry button takes over.
export function TerminalLoadingOverlay({ readiness }: { readiness: TerminalReadiness | null }): ReactElement | null {
	if (readiness?.state !== "loading") {
		return null;
	}
	return (
		<div
			role="status"
			aria-live="polite"
			className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-surface-0 text-text-secondary"
		>
			<Spinner size={20} />
			<span className="text-sm">Loading, please wait...</span>
			<span className="text-xs text-text-tertiary">{PHASE_DETAILS[readiness.phase]}</span>
		</div>
	);
}
