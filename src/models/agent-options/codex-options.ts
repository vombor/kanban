import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { AgentSettingsOptions } from "../../core/agent-settings-options";

// The installed CLI's model/list response. Keep only picker fields; effort values come from the CLI, not a union.
const modelListSchema = z.object({
	data: z.array(
		z.object({
			model: z.string(),
			displayName: z.string(),
			supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
		}),
	),
	nextCursor: z.string().nullable(),
});

export async function readCodexOptions(binary = "codex"): Promise<AgentSettingsOptions> {
	return await new Promise((resolve, reject) => {
		const child = spawn(binary, ["app-server", "--stdio", "-c", "check_for_update_on_startup=false"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const lines = createInterface({ input: child.stdout });
		const models: AgentSettingsOptions["models"] = [];
		let settled = false;
		let requestId = 1;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			lines.close();
			child.kill("SIGTERM");
			const killTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, 1000);
			killTimer.unref();
			if (error) reject(error);
			else
				resolve({
					models,
					providers: [],
					efforts: [...new Set(models.flatMap((model) => model.reasoningEfforts))].map((value) => ({
						value,
						label: value,
					})),
					source: "Codex's model catalog",
				});
		};
		const timer = setTimeout(() => finish(new Error("Codex model discovery timed out")), 10_000);
		const send = (method: string, params: unknown, id?: number) =>
			child.stdin.write(`${JSON.stringify({ ...(id === undefined ? {} : { id }), method, params })}\n`);
		child.on("error", () => finish(new Error("Codex model discovery failed")));
		child.stdin.on("error", () => finish(new Error("Codex model discovery input closed")));
		child.on("exit", () => finish(new Error("Codex model discovery ended before the catalog arrived")));
		child.stderr.resume();
		lines.on("line", (line) => {
			try {
				const message = z
					.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.unknown().optional() })
					.parse(JSON.parse(line));
				if (message.id !== requestId) return;
				if (message.error) {
					finish(new Error("Codex refused model discovery"));
					return;
				}
				if (requestId === 1) {
					send("initialized", {});
					requestId += 1;
					send("model/list", { limit: 100, includeHidden: false }, requestId);
					return;
				}
				const result = modelListSchema.parse(message.result);
				models.push(
					...result.data.map((model) => ({
						modelId: model.model,
						label: model.displayName,
						reasoningEfforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
					})),
				);
				if (result.nextCursor) {
					requestId += 1;
					send("model/list", { limit: 100, includeHidden: false, cursor: result.nextCursor }, requestId);
				} else finish();
			} catch {
				finish(new Error("Codex returned an unreadable model catalog"));
			}
		});
		send("initialize", { clientInfo: { name: "kanban-model-picker", version: "1.0.0" } }, requestId);
	});
}
