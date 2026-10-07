// The team kit's built-in features (plan §1.2), registered in the pipeline worker. A feature runs for a workspace
// only while that workspace's resolved kit lists it (src/pipeline/features.ts), so nothing here runs on a `default`
// board.
import type { PipelineFeatureRegistry } from "../../pipeline/features";
import { createBenchFeature } from "./bench/bench-feature";
import { createScoreboardFeature } from "./scoreboard/scoreboard-feature";

export function registerTeamKitFeatures(registry: PipelineFeatureRegistry): void {
	registry.register(createScoreboardFeature());
	registry.register(createBenchFeature());
}
