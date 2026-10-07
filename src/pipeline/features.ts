// The feature registry: built-in features a workspace's kit switches on by name (`features[]` in the kit, plan
// §3.2), such as the team kit's scoreboard or runoffs. A feature is repo code, never user code: user kits can only
// name built-in features. It runs for a workspace only while that workspace's resolved kit lists it, and it sees
// only that workspace's pipeline events.
//
// No feature is registered yet; the team kit's features arrive with their own cards (P4-T2, P4-T3, P4-T4). A kit
// that names a feature nobody registered is reported once per workspace, not refused.
import type { KitDocument, KitFeature } from "../kits/kit-schema";
import type { PipelineEventBus, PipelineEventHandler, PipelineEventName } from "./events";

export interface PipelineFeatureContext {
	workspaceId: string;
	/** The workspace's resolved kit (override > kit > default). */
	kit: KitDocument;
	/** Subscribes to this workspace's events only; the registry unsubscribes on deactivation. */
	on: <Name extends PipelineEventName>(name: Name, handler: PipelineEventHandler<Name>) => void;
	log: (message: string) => void;
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
	close: () => void;
}

interface ActiveFeature {
	kitKey: string;
	stop: () => void;
}

export function createPipelineFeatureRegistry(deps: {
	bus: PipelineEventBus;
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
		close: () => {
			for (const workspaceId of [...activeByWorkspace.keys()]) {
				removeWorkspace(workspaceId);
			}
		},
	};
}
