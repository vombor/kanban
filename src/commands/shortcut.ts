// `kanban shortcut list|add|remove`: a project's top-bar shortcuts (the script runner: label, command typed into a
// terminal, icon) without the settings dialog. Changes go through the running server (src/trpc/shortcuts-api.ts),
// which allows only the user and the project's own orchestrator and logs every change to
// `<home>/data/<ws>/shortcut-history.jsonl`; open boards pick the change up at once.
import type { Command } from "commander";

import { RUNTIME_SHORTCUT_ICON_IDS } from "../config/shortcut-utils";
import type { RuntimeProjectShortcut } from "../core/api-contract";
import type { ShortcutChangeResponse } from "../trpc/shortcuts-api";
import { createRuntimeTrpcClient } from "./runtime-trpc-client";
import { resolveWorkspaceTarget } from "./workspace-target";

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message : String(error);
}

export function formatShortcut(shortcut: RuntimeProjectShortcut): string {
	return `${shortcut.label}${shortcut.icon ? ` [${shortcut.icon}]` : ""}: ${shortcut.command}`;
}

export function formatShortcutChange(response: ShortcutChangeResponse, workspaceId: string): string[] {
	const change = response.change;
	if (!change) {
		return [`${workspaceId}: no change (the shortcut is already like that).`];
	}
	const verb = !change.to ? "removed" : change.from ? "updated" : "added";
	return [
		`${workspaceId}: shortcut "${change.label}" ${verb}.`,
		...(change.from && change.to ? [`  was: ${formatShortcut(change.from)}`] : []),
		...(change.to ? [`  now: ${formatShortcut(change.to)}`] : []),
	];
}

type ProjectOptions = { project?: string; json?: boolean };

async function runShortcutCommand<T>(
	options: ProjectOptions,
	failureLabel: string,
	call: (client: ReturnType<typeof createRuntimeTrpcClient>) => Promise<T>,
	print: (result: T, workspaceId: string) => { ok: boolean; error?: string; lines: string[] },
): Promise<void> {
	try {
		const target = await resolveWorkspaceTarget(options.project, { allowUnregistered: false });
		let result: T;
		try {
			result = await call(createRuntimeTrpcClient(target.workspaceId));
		} catch (error) {
			throw new Error(
				`the running Kanban server didn't answer (${toErrorMessage(error)}); shortcuts change only through it, because it checks who is asking`,
			);
		}
		const printed = print(result, target.workspaceId);
		if (options.json) {
			process.stdout.write(`${JSON.stringify({ workspaceId: target.workspaceId, ...result }, null, 2)}\n`);
		}
		if (!printed.ok) {
			throw new Error(printed.error ?? "refused");
		}
		if (!options.json) {
			process.stdout.write(`${printed.lines.join("\n")}\n`);
		}
	} catch (error) {
		process.stderr.write(`${failureLabel} failed: ${toErrorMessage(error)}\n`);
		process.exitCode = 1;
	}
}

const PROJECT_OPTION_HELP = "Workspace id or project path. Defaults to the project containing the current directory.";

export function registerShortcutCommand(program: Command): void {
	const shortcut = program
		.command("shortcut")
		.description(
			"A project's shortcuts: the top bar's script runner buttons, which type a command into a terminal (a card's terminal in its worktree when a card is open, else the main checkout's). {port} in a command is a free port Kanban hands out for each run and {url} where the browser opens it.",
		);

	shortcut
		.command("list")
		.description("List the project's shortcuts.")
		.option("--project <workspace>", PROJECT_OPTION_HELP)
		.option("--json", "Print as JSON.")
		.action(async (options: ProjectOptions) => {
			await runShortcutCommand(
				options,
				"Shortcut list",
				async (client) => await client.shortcuts.list.query(),
				(result, workspaceId) => ({
					ok: true,
					lines:
						result.shortcuts.length === 0
							? [`${workspaceId}: no shortcuts.`]
							: result.shortcuts.map((item) => formatShortcut(item)),
				}),
			);
		});

	shortcut
		.command("add")
		.description(
			"Add a shortcut, or change the one with the same label (any label, command and icon). Only the user and the project's own orchestrator; never a card.",
		)
		.requiredOption("--label <label>", "Button label, e.g. Preview.")
		.requiredOption(
			"--command <command>",
			'One shell line, e.g. "PORT={port} npm run dev". {port}: a free port per run; {url}: <board origin>/api/shortcut-port/<port>/.',
		)
		.option("--icon <icon>", `Button icon: ${RUNTIME_SHORTCUT_ICON_IDS.join(", ")}.`)
		.option("--project <workspace>", PROJECT_OPTION_HELP)
		.option("--json", "Print as JSON.")
		.action(async (options: ProjectOptions & { label: string; command: string; icon?: string }) => {
			await runShortcutCommand(
				options,
				"Shortcut add",
				async (client) =>
					await client.shortcuts.add.mutate({
						label: options.label,
						command: options.command,
						icon: options.icon,
					}),
				(response, workspaceId) => ({
					ok: response.ok,
					error: response.error,
					lines: formatShortcutChange(response, workspaceId),
				}),
			);
		});

	shortcut
		.command("remove")
		.description("Remove a shortcut by its label. Only the user and the project's own orchestrator.")
		.requiredOption("--label <label>", "The shortcut's label.")
		.option("--project <workspace>", PROJECT_OPTION_HELP)
		.option("--json", "Print as JSON.")
		.action(async (options: ProjectOptions & { label: string }) => {
			await runShortcutCommand(
				options,
				"Shortcut remove",
				async (client) => await client.shortcuts.remove.mutate({ label: options.label }),
				(response, workspaceId) => ({
					ok: response.ok,
					error: response.error,
					lines: formatShortcutChange(response, workspaceId),
				}),
			);
		});
}
