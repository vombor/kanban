// The team kit's built-in features (plan §1.2), registered in the pipeline worker. A feature runs for a workspace
// only while that workspace's resolved kit lists it (src/pipeline/features.ts), so nothing here runs on a `default`
// board. Their landing vetoes (src/kits/land-veto.ts) are asked by the server's landing gate the same way.
import type { PipelineFeatureRegistry } from "../../pipeline/features";
import type { KitLandVeto } from "../land-veto";
import { createBenchFeature } from "./bench/bench-feature";
import { createRunoffsFeature } from "./runoffs/runoffs-feature";
import { createRunoffsLandVeto } from "./runoffs/runoffs-land-veto";
import { createScoreboardFeature } from "./scoreboard/scoreboard-feature";
import { createTiersFeature } from "./tiers/tiers-report";

export function registerTeamKitFeatures(registry: PipelineFeatureRegistry): void {
	registry.register(createScoreboardFeature());
	registry.register(createBenchFeature());
	registry.register(createRunoffsFeature());
	registry.register(createTiersFeature());
}

/** The team kit's landing vetoes, for the server's landing gate (each asked only where the kit lists its feature). */
export function createTeamKitLandVetoes(): KitLandVeto[] {
	return [createRunoffsLandVeto()];
}
