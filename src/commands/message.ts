// `kanban message send|inbox|reply`: orchestrator messages between projects (src/isolation/messages.ts). Only a
// project's orchestrator session sends; the server takes the sender from its session credential. A message is a
// request: the receiver answers or refuses, and acts only on its own project.
import { readFile } from "node:fs/promises";
import type { Command } from "commander";

import { createRuntimeTrpcClient } from "./runtime-trpc-client";

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message : String(error);
}

async function readText(options: { text?: string; textFile?: string }): Promise<string> {
	if (options.text !== undefined && options.textFile !== undefined) {
		throw new Error("Pass --text or --text-file, not both.");
	}
	if (options.textFile !== undefined) {
		return await readFile(options.textFile, "utf8");
	}
	if (options.text === undefined) {
		throw new Error("Pass the message with --text <text> or --text-file <file>.");
	}
	return options.text;
}

function report(result: { ok: boolean }): void {
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	if (!result.ok) {
		process.exitCode = 1;
	}
}

export function registerMessageCommand(program: Command): void {
	const message = program
		.command("message")
		.description(
			"Orchestrator messages between projects: requests only, never approvals; both projects must allow them.",
		);

	message
		.command("send")
		.description("Send another project's orchestrator a request (from this project's orchestrator session).")
		.requiredOption("--to <project>", "The project (workspace id or name; not a path).")
		.option("--text <text>", "The message.")
		.option("--text-file <file>", "Read the message from a file.")
		.action(async (options: { to: string; text?: string; textFile?: string }) => {
			try {
				report(
					await createRuntimeTrpcClient(null).message.send.mutate({
						to: options.to,
						text: await readText(options),
						inReplyTo: null,
						refuse: false,
					}),
				);
			} catch (error) {
				process.stderr.write(`Message send failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});

	message
		.command("reply")
		.description("Answer or refuse a message this project received.")
		.argument("<messageId>", "The message (kanban message inbox).")
		.option("--text <text>", "The answer, or why it is refused.")
		.option("--text-file <file>", "Read it from a file.")
		.option("--refuse", "Refuse the request.")
		.action(async (messageId: string, options: { text?: string; textFile?: string; refuse?: boolean }) => {
			try {
				report(
					await createRuntimeTrpcClient(null).message.send.mutate({
						to: null,
						text: await readText(options),
						inReplyTo: messageId,
						refuse: options.refuse === true,
					}),
				);
			} catch (error) {
				process.stderr.write(`Message reply failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});

	message
		.command("inbox")
		.description("This project's messages, sent and received (the user names the project with --project).")
		.option("--project <project>", "For the user: the project (workspace id or name).")
		.option("--limit <count>", "The newest this many (default 50).", (value) => Number.parseInt(value, 10), 50)
		.action(async (options: { project?: string; limit: number }) => {
			try {
				report(
					await createRuntimeTrpcClient(null).message.inbox.query({
						project: options.project ?? null,
						limit: options.limit,
					}),
				);
			} catch (error) {
				process.stderr.write(`Message inbox failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
