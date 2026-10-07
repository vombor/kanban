import type { ReactElement } from "react";

import { isKitProposalSelected } from "@/hooks/use-kit-dev-assignment";
import type { RuntimeAgentId, RuntimeDevAssignmentResponse, RuntimeTaskAgentSettings } from "@/runtime/types";

/** Says where the create dialog's agent/model came from: "from kit `team`", or a shadow kit's unapplied proposal. */
export function TaskKitAssignmentHint({
	devAssignment,
	agentId,
	agentSettings,
}: {
	devAssignment: RuntimeDevAssignmentResponse | null;
	agentId: RuntimeAgentId | undefined;
	agentSettings: RuntimeTaskAgentSettings | undefined;
}): ReactElement | null {
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
