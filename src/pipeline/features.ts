// The feature registry: built-in features a workspace's kit switches on by name (`features[]` in the kit, plan
// §3.2), such as the team kit's scoreboard or runoffs. A feature is repo code, never user code: user kits can only
// name built-in features. It runs for a workspace only while that workspace's resolved kit lists it, and it sees
// only that workspace's pipeline events.
//
// The team kit registers its features in src/kits/team/features.ts (scoreboard and bench from P4-T2, runoffs from
// P4-T3; calibration comes with P4-T4). A kit that names a feature nobody registered is reported once per workspace,
// not refused.
//
// Besides events and jobs, a feature may answer `onPass` (only the runoffs feature does: plan §4.0, "only the team
// `runoffs` feature answers hold") and run on each pipeline tick of its workspace (outside shadow) to act on held
// cards. The kit's own `onPass` answer is used when no active feature answers.
import type { RuntimeAgentId } from "../core/api-contract";
import type { EffectiveModel } from "../core/effective-agent";
import type { KitDocument, KitFeature } from "../kits/kit-schema";
import type { EffectiveCard, KitVerdict, OnPassAnswer } from "../kits/policy";
import type { PipelineWorkspaceSnapshot } from "./engine";
import type { PipelineEventBus, PipelineEventHandler, PipelineEventName } from "./events";
import type { ReleaseHoldInput, ReleaseHoldResult } from "./hold";
import type { PipelineWorkspaceState } from "./pipeline-state";

/** What a feature may ask the core to do for its workspace. */
export interface PipelineFeatureActions {
	/** Lands or discards a held card (src/pipeline/hold.ts), through the server's Done workflow. */
	releaseHold: (
		workspaceId: string,
		input: Omit<ReleaseHoldInput, "workspaceId" | "workspacePath">,
	) => Promise<ReleaseHoldResult>;
	/** Appends a section to the workspace's QA log (qa-log.md). */
	appendQaLog?: (workspaceId: string, text: string) => Promise<void>;
	/** Lifts a hold without finishing the card (src/pipeline/hold.ts clearHold); a human decides in Review. */
	unhold?: (workspaceId: string, input: { taskId: string; reason: string }) => Promise<boolean>;
}

/** What the QA gate asks before a PASS lands. */
export interface PipelineFeaturePassInput {
	dev: EffectiveCard;
	verdict: KitVerdict;
}

/** A feature's `onPass` answer; null = no opinion (the next feature, then the kit, answers). */
export type PipelineFeaturePassHandler = (
	input: PipelineFeaturePassInput,
) => OnPassAnswer | null | Promise<OnPassAnswer | null>;

/** One pipeline evaluation of the workspace (never in shadow), after the QA gate's tick. */
export interface PipelineFeatureTickInput {
	snapshot: PipelineWorkspaceSnapshot;
	state: PipelineWorkspaceState;
	now: number;
}

export type PipelineFeatureTickHandler = (input: PipelineFeatureTickInput) => Promise<void>;

/** One card of a runoff group the rework stage starts after a FAIL (the kit's `onFail.runoff`). */
export interface PipelineRunoffCard {
	taskId: string;
	agentId: RuntimeAgentId;
	model: EffectiveModel | null;
}

export interface PipelineRunoffGroup {
	name: string;
	/** The card that failed. */
	from: string;
	/** The failed card first, then its siblings. */
	cards: PipelineRunoffCard[];
	baseRef: string;
	/** The FAIL round the runoff answers. */
	round: number;
	/** Set when no sibling could be created: the group is recorded as abandoned (nothing is held for it). */
	abandoned?: string;
}

/**
 * Runoff groups, kept by the feature that holds their PASSes (the team kit's `runoffs`). The rework stage records a
 * group before it creates the sibling cards, so neither the failed card nor a sibling can land before the runoff is
 * decided. With no active feature providing them for a workspace, a runoff answer is escalated instead.
 */
export interface PipelineRunoffGroupHandler {
	/** The open group a card races in, or null. */
	groupOf: (taskId: string) => Promise<string | null>;
	/** Creates the group, or replaces the one of that name (the cards that were really created). */
	record: (group: PipelineRunoffGroup) => Promise<void>;
}

export interface PipelineRunoffGroups {
	/** The workspace's handler, or null when no active feature provides one. */
	forWorkspace: (workspaceId: string) => PipelineRunoffGroupHandler | null;
}

export interface PipelineFeatureContext {
	workspaceId: string;
	/** The workspace's resolved kit (override > kit > default). */
	kit: KitDocument;
	/** Subscribes to this workspace's events only; the registry unsubscribes on deactivation. */
	on: <Name extends PipelineEventName>(name: Name, handler: PipelineEventHandler<Name>) => void;
	/** The only way out of a hold (`onPass → hold`): land or discard the card, optionally tagging its work first. */
	releaseHold: (input: Omit<ReleaseHoldInput, "workspaceId" | "workspacePath">) => Promise<ReleaseHoldResult>;
	/** Registers a periodic job for this workspace; the watchdog's job runner runs it while the feature is active. */
	job: (job: PipelineFeatureJob) => void;
	/** Answers `onPass` for this workspace's PASSes before the kit does. */
	onPass: (handler: PipelineFeaturePassHandler) => void;
	/** Runs on each pipeline evaluation of this workspace outside shadow. */
	onTick: (handler: PipelineFeatureTickHandler) => void;
	/** Appends a section to this workspace's QA log. */
	appendQaLog: (text: string) => Promise<void>;
	/** Lifts a card's hold without finishing it (it stays in Review for a human). False when it wasn't held. */
	unhold: (input: { taskId: string; reason: string }) => Promise<boolean>;
	/** Keeps this workspace's runoff groups (only the runoffs feature does); the rework stage records into it. */
	provideRunoffGroups: (handler: PipelineRunoffGroupHandler) => void;
	log: (message: string) => void;
}

/**
 * A feature's periodic job (the team kit's daily price check, for example). The watchdog runs a due job once per
 * `everyMin` per workspace and remembers its last run in watchdog-state.json, so a worker restart doesn't re-run it.
 * Returns a one-line summary for the watchdog's log.
 */
export interface PipelineFeatureJob {
	name: string;
	everyMin: number;
	run: () => Promise<string | undefined>;
}

export interface PipelineFeature {
	name: KitFeature;
	/** Starts the feature for one workspace. The returned function (if any) stops it. */
	activate: (context: PipelineFeatureContext) => (() => void) | undefined;
}

export interface PipelineFeatureSync {
	active: KitFeature[];
	/** Named by the kit but not registered (not built yet). */
	unavailable: KitFeature[];
}

export interface PipelineFeatureRegistry {
	register: (feature: PipelineFeature) => void;
	/** Activates exactly the registered features the kit lists for the workspace; restarts them when the kit changes. */
	syncWorkspace: (workspaceId: string, kit: KitDocument) => PipelineFeatureSync;
	removeWorkspace: (workspaceId: string) => void;
	/** The jobs of the features active for the workspace, named `<feature>:<job>`. */
	listJobs: (workspaceId: string) => PipelineFeatureJob[];
	/**
	 * The first active feature's `onPass` answer for the workspace, or null (the kit answers). Rejects when a feature
	 * fails to answer: the caller must then leave the PASS for the next evaluation, not land it.
	 */
	answerOnPass: (workspaceId: string, input: PipelineFeaturePassInput) => Promise<OnPassAnswer | null>;
	/** Runs the tick handlers of the workspace's active features; one that fails is logged. */
	tick: (workspaceId: string, input: PipelineFeatureTickInput) => Promise<void>;
	/** The runoff groups of the workspaces' active features. */
	runoffGroups: PipelineRunoffGroups;
	close: () => void;
}

interface ActiveFeature {
	kitKey: string;
	jobs: PipelineFeatureJob[];
	passHandlers: PipelineFeaturePassHandler[];
	tickHandlers: PipelineFeatureTickHandler[];
	runoffGroups: PipelineRunoffGroupHandler | null;
	stop: () => void;
}

export function createPipelineFeatureRegistry(deps: {
	bus: PipelineEventBus;
	actions?: PipelineFeatureActions;
	log?: (message: string) => void;
}): PipelineFeatureRegistry {
	const features = new Map<KitFeature, PipelineFeature>();
	const activeByWorkspace = new Map<string, Map<KitFeature, ActiveFeature>>();
	const reportedUnavailable = new Set<string>();
	const log = deps.log ?? (() => {});

	const stopFeature = (workspaceId: string, name: KitFeature, active: ActiveFeature): void => {
		try {
			active.stop();
		} catch (error) {
			log(`pipeline ${workspaceId}: feature ${name} failed to stop: ${String(error)}`);
		}
	};

	const startFeature = (workspaceId: string, feature: PipelineFeature, kit: KitDocument, kitKey: string) => {
		const unsubscribes: Array<() => void> = [];
		const jobs: PipelineFeatureJob[] = [];
		const passHandlers: PipelineFeaturePassHandler[] = [];
		const tickHandlers: PipelineFeatureTickHandler[] = [];
		let runoffGroups: PipelineRunoffGroupHandler | null = null;
		const context: PipelineFeatureContext = {
			workspaceId,
			kit,
			on: (name, handler) => {
				unsubscribes.push(
					deps.bus.on(name, async (event) => {
						if (event.workspaceId === workspaceId) {
							await handler(event);
						}
					}),
				);
			},
			releaseHold: async (input) =>
				deps.actions
					? await deps.actions.releaseHold(workspaceId, input)
					: { ok: false, error: "this pipeline cannot release holds" },
			job: (job) => {
				jobs.push({ ...job, name: `${feature.name}:${job.name}` });
			},
			onPass: (handler) => {
				passHandlers.push(handler);
			},
			onTick: (handler) => {
				tickHandlers.push(handler);
			},
			appendQaLog: async (text) => {
				await deps.actions?.appendQaLog?.(workspaceId, text);
			},
			unhold: async (input) => (await deps.actions?.unhold?.(workspaceId, input)) ?? false,
			provideRunoffGroups: (handler) => {
				runoffGroups = handler;
			},
			log: (message) => log(`pipeline ${workspaceId} [${feature.name}]: ${message}`),
		};
		let stop: (() => void) | undefined;
		try {
			stop = feature.activate(context);
		} catch (error) {
			for (const unsubscribe of unsubscribes) {
				unsubscribe();
			}
			log(`pipeline ${workspaceId}: feature ${feature.name} failed to start: ${String(error)}`);
			return null;
		}
		return {
			kitKey,
			jobs,
			passHandlers,
			tickHandlers,
			runoffGroups,
			stop: () => {
				for (const unsubscribe of unsubscribes) {
					unsubscribe();
				}
				stop?.();
			},
		} satisfies ActiveFeature;
	};

	const removeWorkspace = (workspaceId: string): void => {
		const active = activeByWorkspace.get(workspaceId);
		if (!active) {
			return;
		}
		for (const [name, feature] of active) {
			stopFeature(workspaceId, name, feature);
		}
		activeByWorkspace.delete(workspaceId);
	};

	return {
		register: (feature) => {
			if (features.has(feature.name)) {
				throw new Error(`Pipeline feature ${feature.name} is already registered.`);
			}
			features.set(feature.name, feature);
		},
		syncWorkspace: (workspaceId, kit) => {
			const wanted = new Set(kit.features ?? []);
			const kitKey = JSON.stringify(kit);
			const active = activeByWorkspace.get(workspaceId) ?? new Map<KitFeature, ActiveFeature>();
			for (const [name, feature] of active) {
				if (!wanted.has(name) || feature.kitKey !== kitKey) {
					stopFeature(workspaceId, name, feature);
					active.delete(name);
				}
			}
			const unavailable: KitFeature[] = [];
			const newlyUnavailable: KitFeature[] = [];
			for (const name of wanted) {
				const feature = features.get(name);
				if (!feature) {
					unavailable.push(name);
					const key = `${workspaceId}:${name}`;
					if (!reportedUnavailable.has(key)) {
						reportedUnavailable.add(key);
						newlyUnavailable.push(name);
					}
					continue;
				}
				if (!active.has(name)) {
					const started = startFeature(workspaceId, feature, kit, kitKey);
					if (started) {
						active.set(name, started);
					}
				}
			}
			if (newlyUnavailable.length > 0) {
				log(
					`pipeline ${workspaceId}: kit "${kit.name}" lists features this build doesn't have yet: ${newlyUnavailable.join(", ")}`,
				);
			}
			activeByWorkspace.set(workspaceId, active);
			return { active: [...active.keys()], unavailable };
		},
		removeWorkspace,
		listJobs: (workspaceId) =>
			[...(activeByWorkspace.get(workspaceId)?.values() ?? [])].flatMap((active) => active.jobs),
		answerOnPass: async (workspaceId, input) => {
			for (const [name, active] of activeByWorkspace.get(workspaceId) ?? []) {
				for (const handler of active.passHandlers) {
					try {
						const answer = await handler(input);
						if (answer) {
							return answer;
						}
					} catch (error) {
						// Never fall through to the kit's "land": a feature that can't tell may be holding this card.
						throw new Error(`feature ${name} failed to answer onPass: ${String(error)}`);
					}
				}
			}
			return null;
		},
		tick: async (workspaceId, input) => {
			for (const [name, active] of [...(activeByWorkspace.get(workspaceId) ?? [])]) {
				for (const handler of active.tickHandlers) {
					try {
						await handler(input);
					} catch (error) {
						log(`pipeline ${workspaceId}: feature ${name} tick failed: ${String(error)}`);
					}
				}
			}
		},
		runoffGroups: {
			forWorkspace: (workspaceId) => {
				for (const active of activeByWorkspace.get(workspaceId)?.values() ?? []) {
					if (active.runoffGroups) {
						return active.runoffGroups;
					}
				}
				return null;
			},
		},
		close: () => {
			for (const workspaceId of [...activeByWorkspace.keys()]) {
				removeWorkspace(workspaceId);
			}
		},
	};
}
