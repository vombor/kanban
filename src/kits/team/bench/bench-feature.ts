// The team kit's `bench` feature: registers the daily price check (price-sync-job.ts) as a feature job for each
// workspace whose kit lists `bench`. The watchdog's job runner runs it (only in `watchdog.mode: "on"`, which
// `kanban doctor` fails while the legacy kit's review-watch, and with it its PRICE_SYNC toggle, still runs).
import type { PipelineFeature } from "../../../pipeline/features";
import { createPriceCheckJob, type PriceCheckJobDependencies } from "./price-sync-job";

export function createBenchFeature(deps: PriceCheckJobDependencies = {}): PipelineFeature {
	return {
		name: "bench",
		activate: (context) => {
			context.job(createPriceCheckJob(deps));
			return undefined;
		},
	};
}
