/** A refusal proven to precede IPC submission. Every later failure remains uncertain and cannot authorize replay. */
export class IntegrationChecksUnavailableError extends Error {
	constructor() {
		super("Shared checks worker unavailable before submission; no integration checks were sent.");
	}
}
