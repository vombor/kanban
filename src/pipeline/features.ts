// The feature registry: built-in features a workspace's kit switches on by name (`features[]` in the kit, plan
// §3.2), such as the team kit's scoreboard or runoffs. A feature is repo code, never user code: user kits can only
// name built-in features. It runs for a workspace only while that workspace's resolved kit lists it, and it sees
// only that workspace's pipeline events.
//
// The team kit registers its features in src/kits/team/features.ts (scoreboard from P4-T2; runoffs and calibration
// come with P4-T3/P4-T4). A kit that names a feature nobody registered is reported once per workspace, not refused.
import type { KitDocument, KitFeature } from "../kits/kit-schema";
import type { PipelineEventBus, PipelineEventHandler, PipelineEventName } from "./events";
import type { ReleaseHoldInput, ReleaseHoldResult } from "./hold";

/** What a feature may ask the core to do for its workspace. */
export interface PipelineFeatureActions {
	/** Lands or discards a held card (src/pipeline/hold.ts), through the server's Done workflow. */
	releaseHold: (
		workspaceId: string,
		input: Omit<ReleaseHoldInput, "workspaceId" | "workspacePath">,
	) => Promise<ReleaseHoldResult>;
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
	close: () => void;
}

interface ActiveFeature {
	kitKey: string;
	jobs: PipelineFeatureJob[];
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
		close: () => {
			for (const workspaceId of [...activeByWorkspace.keys()]) {
				removeWorkspace(workspaceId);
			}
		},
	};
}
