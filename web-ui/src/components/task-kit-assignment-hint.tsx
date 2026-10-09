import type { ReactElement } from "react";

import { isKitProposalSelected, isVettedDevSelection } from "@/hooks/use-kit-dev-assignment";
import type { RuntimeAgentId, RuntimeDevAssignmentResponse, RuntimeTaskAgentSettings } from "@/runtime/types";

/**
 * Says where the create dialog's agent/model came from: "from kit `team`", or a shadow kit's unapplied proposal.
 * Warns when the pick is not a combination the vetted model registry allows for dev work on this project: allowed
 * (the user's call), but it may waste the project's time erroring out.
 */
export function TaskKitAssignmentHint({
	devAssignment,
	agentId,
	agentSettings,
	defaultAgentId,
}: {
	devAssignment: RuntimeDevAssignmentResponse | null;
	agentId: RuntimeAgentId | undefined;
	agentSettings: RuntimeTaskAgentSettings | undefined;
	/** The agent selected in Kanban settings: what a card without an agent runs on. */
	defaultAgentId?: RuntimeAgentId;
}): ReactElement | null {
	if (devAssignment && !isVettedDevSelection(devAssignment, agentId ?? defaultAgentId, agentSettings)) {
		const refused = devAssignment.outcome === "refused" ? devAssignment.proposal?.refused : null;
		return (
			<p className="text-[11px] text-status-orange">
				{refused
					? `The kit's own pick is refused: ${refused}. `
					: "This agent and model are not vetted for dev work on this project (kanban models list). "}
				You can still create the card; it may error out.
			</p>
		);
	}
	const proposal = devAssignment?.proposal;
	if (!devAssignment || !proposal) {
		return null;
	}
	const kitName = <code className="font-mono text-text-primary">{devAssignment.kitName}</code>;
	if (devAssignment.outcome === "applied" && isKitProposalSelected(proposal, agentId, agentSettings)) {
		return <p className="text-[11px] text-text-secondary">from kit {kitName}</p>;
	}
	if (devAssignment.outcome === "shadow") {
		const model = proposal.agentSettings?.modelId ? ` on ${proposal.agentSettings.modelId}` : "";
		return (
			<p className="text-[11px] text-text-tertiary">
				Kit {kitName} would pick {proposal.agentId}
				{model} (shadow mode: not applied)
			</p>
		);
	}
	return null;
}
