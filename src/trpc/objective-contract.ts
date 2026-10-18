import type { z } from "zod";
import type {
	ObjectiveControlRequest,
	ObjectiveCreate,
	ObjectiveLimits,
	ObjectiveManualLineage,
	ObjectiveReadResponse,
	objectiveListSchema,
	RuntimeObjective,
} from "../core/objective-contract";
import type { RuntimeCaller } from "../isolation/session-identity";

export interface RuntimeObjectiveApi {
	manualLineage(caller: RuntimeCaller, workspaceId: string, input: ObjectiveManualLineage): Promise<RuntimeObjective>;
	control(caller: RuntimeCaller, workspaceId: string, input: ObjectiveControlRequest): Promise<RuntimeObjective>;
	list(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof objectiveListSchema>,
	): Promise<{ objectives: RuntimeObjective[]; total: number; nextOffset: number | null }>;
	read(caller: RuntimeCaller, workspaceId: string, id: string): Promise<ObjectiveReadResponse>;
	recheck(caller: RuntimeCaller, workspaceId: string, id: string): Promise<ObjectiveReadResponse>;
	create(caller: RuntimeCaller, workspaceId: string, input: ObjectiveCreate): Promise<RuntimeObjective>;
	setLimits(
		caller: RuntimeCaller,
		workspaceId: string,
		input: {
			requestId: string;
			id: string;
			expectedRevision: number;
			limits: ObjectiveLimits;
			acknowledgeAdmissionScope?: boolean;
		},
	): Promise<RuntimeObjective>;
}
