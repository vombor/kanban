// The user's second factor for isolation's escape hatch (docs/fork/project-isolation.md). A grant, and under
// `enforce` a project create/add/remove, doesn't happen on request: the server keeps it pending and prints a one-time
// code to its own console (stderr: the terminal that started Kanban, or `podman logs` for the container). The code is
// never written to a file or returned by an API. The change runs once someone gives the code with `kanban isolation
// approve <id> <code>`. An agent session doesn't see the server's console, so a process that drops its credential and
// leaves its session's tree still can't finish the change. Same-uid processes can in principle read another process's
// memory or pipes: like the rest of isolation this guards against an agent's ordinary commands, not a sandbox.
import { randomBytes, timingSafeEqual } from "node:crypto";

export type ApprovalKind = "grant" | "project.create" | "project.add" | "project.remove";

export interface PendingApprovalView {
	id: string;
	kind: ApprovalKind;
	summary: string;
	status: "pending" | "approved" | "refused" | "expired";
	expiresAt: string;
	/** What the approved change answered (a grant id, the project), once approved. */
	result: string | null;
}

export interface ApprovalStore {
	/** Records a pending change and prints its code to the console. */
	request: (input: { kind: ApprovalKind; summary: string; run: () => Promise<string> }) => PendingApprovalView;
	approve: (id: string, code: string) => Promise<{ ok: true; result: string } | { ok: false; error: string }>;
	status: (id: string) => PendingApprovalView | null;
}

export const APPROVAL_TTL_MS = 10 * 60_000;
export const APPROVAL_MAX_ATTEMPTS = 3;
const MAX_PENDING = 50;
// No 0/O, 1/I/L: the user types it.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function createCode(): string {
	return Array.from(randomBytes(8), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function sameCode(left: string, right: string): boolean {
	const a = Buffer.from(left.trim().toUpperCase(), "utf8");
	const b = Buffer.from(right, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Prints the code on the server's stderr, which no API, log file or agent session sees. */
export function announceApprovalOnConsole(line: string): void {
	process.stderr.write(`${line}\n`);
}

export function createApprovalStore(
	options: { now?: () => number; announce?: (line: string) => void; ttlMs?: number } = {},
): ApprovalStore {
	const now = options.now ?? Date.now;
	const announce = options.announce ?? announceApprovalOnConsole;
	const ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
	const pending = new Map<
		string,
		{
			view: PendingApprovalView;
			code: string;
			attempts: number;
			expiresAtMs: number;
			run: () => Promise<string>;
		}
	>();
	const refresh = (entry: { view: PendingApprovalView; expiresAtMs: number }) => {
		if (entry.view.status === "pending" && now() >= entry.expiresAtMs) {
			entry.view.status = "expired";
		}
	};
	return {
		request: ({ kind, summary, run }) => {
			while (pending.size >= MAX_PENDING) {
				const oldest = pending.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				pending.delete(oldest);
			}
			const id = `a-${randomBytes(4).toString("hex")}`;
			const code = createCode();
			const expiresAtMs = now() + ttlMs;
			const view: PendingApprovalView = {
				id,
				kind,
				summary,
				status: "pending",
				expiresAt: new Date(expiresAtMs).toISOString(),
				result: null,
			};
			pending.set(id, { view, code, attempts: 0, expiresAtMs, run });
			announce(
				`[kanban] Isolation approval ${id} (${kind}): ${summary}. If you asked for this, run in your own terminal: kanban isolation approve ${id} ${code}   (valid ${Math.round(ttlMs / 60_000)} min; never give this code to an agent)`,
			);
			return { ...view };
		},
		approve: async (id, code) => {
			const entry = pending.get(id);
			if (!entry) {
				return { ok: false, error: `No approval ${id}.` };
			}
			refresh(entry);
			if (entry.view.status !== "pending") {
				return { ok: false, error: `Approval ${id} is ${entry.view.status}.` };
			}
			if (!sameCode(code, entry.code)) {
				entry.attempts += 1;
				if (entry.attempts >= APPROVAL_MAX_ATTEMPTS) {
					entry.view.status = "refused";
				}
				return { ok: false, error: `Wrong code for approval ${id}.` };
			}
			// Approved once: a second approve with the same code is refused.
			entry.view.status = "approved";
			try {
				const result = await entry.run();
				entry.view.result = result;
				return { ok: true, result };
			} catch (error) {
				entry.view.result = error instanceof Error ? error.message : String(error);
				return { ok: false, error: entry.view.result };
			}
		},
		status: (id) => {
			const entry = pending.get(id);
			if (!entry) {
				return null;
			}
			refresh(entry);
			return { ...entry.view };
		},
	};
}
