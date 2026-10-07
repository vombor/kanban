// The CLI half of an isolation approval (approvals.ts): the server holds a grant or (under `enforce`) a project
// change until someone enters the one-time code it printed on its own console. On a terminal the user is asked for
// the code here; otherwise this waits until `kanban isolation approve <id> <code>` is run elsewhere.
import { createInterface } from "node:readline/promises";

import type { RuntimeTrpcClient } from "../commands/runtime-trpc-client";
import { APPROVAL_MAX_ATTEMPTS, APPROVAL_TTL_MS } from "./approvals";

export type ApprovalOutcome = { ok: true; result: string | null } | { ok: false; error: string };

export interface CompleteApprovalInput {
	client: Pick<RuntimeTrpcClient, "isolation">;
	approvalId: string;
	/** What waits, for the instructions ("The grant", "kanban project add /projects/foo"). */
	what: string;
	/** Asks for the code; null when there is no terminal to ask on (then this polls). */
	readCode?: (() => Promise<string | null>) | null;
	write?: (line: string) => void;
	pollMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

async function readCodeFromTerminal(): Promise<string | null> {
	if (!process.stdin.isTTY) {
		return null;
	}
	const prompt = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return (await prompt.question("Approval code: ")).trim() || null;
	} finally {
		prompt.close();
	}
}

export async function completeIsolationApproval(input: CompleteApprovalInput): Promise<ApprovalOutcome> {
	const write = input.write ?? ((line: string) => process.stderr.write(`${line}\n`));
	const readCode = input.readCode === undefined ? readCodeFromTerminal : input.readCode;
	const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = input.now ?? Date.now;
	write(
		`${input.what} needs your approval (${input.approvalId}): the Kanban server printed a one-time code on its console (the terminal that started Kanban, or \`podman logs\` for the container).`,
	);
	if (readCode) {
		for (let attempt = 0; attempt < APPROVAL_MAX_ATTEMPTS; attempt += 1) {
			const code = await readCode();
			if (!code) {
				return { ok: false, error: "No code entered." };
			}
			const result = await input.client.isolation.approve.mutate({ id: input.approvalId, code });
			if (result.ok) {
				return { ok: true, result: result.result };
			}
			write(result.error ?? "The code was not accepted.");
			const status = await input.client.isolation.approvalStatus.query({ id: input.approvalId });
			if (status.approval?.status !== "pending") {
				return { ok: false, error: result.error ?? "The approval is no longer pending." };
			}
		}
		return { ok: false, error: "Too many wrong codes." };
	}
	write(`Waiting: run \`kanban isolation approve ${input.approvalId} <code>\` in your own terminal.`);
	const deadline = now() + APPROVAL_TTL_MS;
	while (now() < deadline) {
		await sleep(input.pollMs ?? 2000);
		const { approval } = await input.client.isolation.approvalStatus.query({ id: input.approvalId });
		if (!approval) {
			return { ok: false, error: `No approval ${input.approvalId} (did Kanban restart?).` };
		}
		if (approval.status === "approved") {
			return { ok: true, result: approval.result };
		}
		if (approval.status !== "pending") {
			return { ok: false, error: `The approval was ${approval.status}.` };
		}
	}
	return { ok: false, error: "The approval expired." };
}
