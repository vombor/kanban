import { TRPCError } from "@trpc/server";
import type { RuntimeObsidianConnectorApi } from "../../trpc/obsidian-connector-contract";
import { probeObsidianConnector } from "./connector-probe";
import {
	createObsidianConnectorStore,
	ObsidianConnectorConflictError,
	type ObsidianConnectorStore,
	obsidianConnectorView,
} from "./connector-store";

export function createObsidianConnectorApi(
	deps: { store?: ObsidianConnectorStore; probe?: typeof probeObsidianConnector } = {},
): RuntimeObsidianConnectorApi {
	const store = deps.store ?? createObsidianConnectorStore();
	const probe = deps.probe ?? probeObsidianConnector;
	const assertUser = (caller: Parameters<RuntimeObsidianConnectorApi["get"]>[0]) => {
		if (caller.kind !== "user")
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "Only the user can configure or test the system Obsidian connector.",
			});
	};
	const run = async <T>(operation: () => Promise<T>): Promise<T> => {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof ObsidianConnectorConflictError)
				throw new TRPCError({ code: "CONFLICT", message: error.message });
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"Could not use the Obsidian connector settings. Check the endpoint and key; existing data has not been overwritten.",
			});
		}
	};
	return {
		get: async (caller) => {
			assertUser(caller);
			return await run(async () => obsidianConnectorView(await store.read()));
		},
		save: async (caller, input) => {
			assertUser(caller);
			return await run(async () => await store.save(input));
		},
		test: async (caller, input) => {
			assertUser(caller);
			return await run(async () => await probe(await store.resolve(input)));
		},
	};
}
