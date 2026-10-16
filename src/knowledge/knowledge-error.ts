export class KnowledgeError extends Error {
	constructor(
		public readonly code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "FORBIDDEN" | "PRECONDITION_FAILED",
		message: string,
	) {
		super(message);
	}
}
