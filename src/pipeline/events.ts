// The pipeline's event bus: the core announces what it did, and kit features (src/kits/team/, the scoreboard,
// runoffs, …) react. Features never answer routing questions (that is the kit's data, src/kits/policy.ts); they
// only add behaviour after the fact, so an event is emitted only once the action really happened. A shadow
// workspace acts on nothing and emits nothing.
//
// Handlers are isolated: one that throws or rejects is logged and doesn't stop the others or the pipeline.
import type { RuntimeAgentId } from "../core/api-contract";
import type { EffectiveModel } from "../core/effective-agent";
import type { EscalationTarget, KitVerdict } from "../kits/policy";

interface PipelineCardEvent {
	workspaceId: string;
	taskId: string;
	/** Epoch ms. */
	at: number;
}

export interface PipelineEventMap {
	/** A QA verdict for a dev card was recorded (pipeline-state, qa-log). */
	verdictRecorded: PipelineCardEvent & {
		qaTaskId: string | null;
		verdict: KitVerdict;
		/** The dev card's effective agent and model when it was QA'd. */
		devAgentId: RuntimeAgentId;
		devModel: EffectiveModel | null;
		qaAgentId: RuntimeAgentId | null;
		qaModel: EffectiveModel | null;
	};
	/** Kanban landed the card's work onto its base. */
	landed: PipelineCardEvent & {
		baseRef: string;
		commit: string | null;
		/** `qa`: after a QA PASS; `approved`: Approve & land without QA. */
		via: "qa" | "approved";
	};
	/** A FAIL was handed back to the same card and model. */
	reworkSent: PipelineCardEvent & { round: number; clearedContext: boolean };
	/** The card was escalated (to the orchestrator or to another model). */
	escalated: PipelineCardEvent & { to: EscalationTarget; requireApproval: boolean; reason: string };
}

export type PipelineEventName = keyof PipelineEventMap;
export type PipelineEventHandler<Name extends PipelineEventName> = (
	event: PipelineEventMap[Name],
) => void | Promise<void>;

export interface PipelineEventBus {
	on: <Name extends PipelineEventName>(name: Name, handler: PipelineEventHandler<Name>) => () => void;
	/** Runs every handler and resolves once all have settled. */
	emit: <Name extends PipelineEventName>(name: Name, event: PipelineEventMap[Name]) => Promise<void>;
}

export function createPipelineEventBus(options: { log?: (message: string) => void } = {}): PipelineEventBus {
	const handlers = new Map<PipelineEventName, Set<PipelineEventHandler<PipelineEventName>>>();

	return {
		on: (name, handler) => {
			const set = handlers.get(name) ?? new Set();
			const stored = handler as PipelineEventHandler<PipelineEventName>;
			set.add(stored);
			handlers.set(name, set);
			return () => {
				set.delete(stored);
			};
		},
		emit: async (name, event) => {
			const current = [...(handlers.get(name) ?? [])];
			const results = await Promise.allSettled(current.map(async (handler) => await handler(event)));
			for (const result of results) {
				if (result.status === "rejected") {
					const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
					options.log?.(`pipeline event ${name} for ${event.taskId}: a handler failed: ${reason}`);
				}
			}
		},
	};
}
