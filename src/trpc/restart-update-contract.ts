// The wire contract of `kanban restart update` (tRPC `restart.update`; the route is src/trpc/restart-update-api.ts).
// The app router imports only this file, because the web-ui typechecks the router's whole import graph for its
// `AppRouter` type under its own stricter tsconfig: the route's server-only code (restart prepare, the pipeline, the
// image check) must stay out of that graph. Keep this file to zod and type-only imports.
import { z } from "zod";

import type { RuntimeCaller } from "../isolation/session-identity";

export const restartUpdateRequestSchema = z.object({
	/** Skip the newer-image check and the In Progress refusal. */
	force: z.boolean().default(false),
	/** Check and print what would happen; nothing is tagged, written or stopped. */
	dryRun: z.boolean().default(false),
});
export type RestartUpdateRequest = z.infer<typeof restartUpdateRequestSchema>;

export const restartUpdateResponseSchema = z.object({
	status: z.enum(["refused", "dry_run", "restarting"]),
	message: z.string(),
	lines: z.array(z.string()),
});
export type RestartUpdateResponse = z.infer<typeof restartUpdateResponseSchema>;

export interface RuntimeRestartUpdateApi {
	update: (caller: RuntimeCaller, request: RestartUpdateRequest) => Promise<RestartUpdateResponse>;
}
