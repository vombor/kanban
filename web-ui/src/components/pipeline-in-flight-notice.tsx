import type { ReactElement } from "react";

import { describePipelineCardStage } from "@/components/board-card-pipeline-stage";
import type { RuntimePipelineCardStage } from "@/runtime/types";

/**
 * What landing now skips while the pipeline still checks or QAs the card (issue #30): its stage with the deadline, and
 * that `action` lands past it. Shared by Approve & land's warning and the Done move's "land or discard?" dialog; a
 * fragment, so the dialog body spaces its lines.
 */
export function PipelineInFlightNotice({
	stage,
	action,
}: {
	stage: RuntimePipelineCardStage;
	action: string;
}): ReactElement {
	return (
		<>
			<p className="text-text-primary">{describePipelineCardStage(stage)}</p>
			<p className="text-text-secondary">{action} squash-lands it now and skips the rest of its checks and QA.</p>
		</>
	);
}
