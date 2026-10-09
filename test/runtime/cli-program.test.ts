// The real CLI program (root options + every registered command) parsing real command lines. Without positional
// options commander matches a root option anywhere in the line, so a root option named like a subcommand's
// swallowed it: the root's deprecated `--agent` made `models vet --agent ...` always "required option not
// specified". The actions are replaced, so nothing here runs a command.
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { addRootOptions, dropDeprecatedLaunchAgentOption, registerCliCommands } from "../../src/cli-program";

function createCliProgram(): Command {
	const program = new Command().name("kanban");
	addRootOptions(program);
	registerCliCommands(program, "0.0.0-test");
	return program;
}

function findCommand(program: Command, path: string[]): Command {
	let command = program;
	for (const name of path) {
		const next = command.commands.find((entry) => entry.name() === name);
		if (!next) {
			throw new Error(`no command ${path.join(" ")}`);
		}
		command = next;
	}
	return command;
}

/** Parses `argv` like cli.ts does and returns the target command's action arguments (operands, then options). */
async function parse(path: string[], argv: string[]): Promise<unknown[]> {
	const program = createCliProgram();
	const target = findCommand(program, path);
	let received: unknown[] | null = null;
	for (const command of [program, target]) {
		command.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
	}
	target.action((...args: unknown[]) => {
		received = args.slice(0, -1);
	});
	await program.parseAsync(dropDeprecatedLaunchAgentOption(argv), { from: "user" });
	if (!received) {
		throw new Error(`${path.join(" ")} did not run`);
	}
	return received;
}

describe("CLI program option parsing", () => {
	it("passes every option of models vet to the command, in both syntaxes", async () => {
		const expected = {
			agent: "cline",
			provider: "lemonade",
			model: "GLM-4.7-Flash-GGUF",
			role: "dev",
			project: "kanban-2uge",
			maxMin: "1",
			maxCost: "0.5",
			json: true,
		};
		const spaced = await parse(
			["models", "vet"],
			[
				"models",
				"vet",
				"--agent",
				"cline",
				"--provider",
				"lemonade",
				"--model",
				"GLM-4.7-Flash-GGUF",
				"--role",
				"dev",
				"--project",
				"kanban-2uge",
				"--max-min",
				"1",
				"--max-cost",
				"0.5",
				"--json",
			],
		);
		expect(spaced).toEqual([expected]);
		const joined = await parse(
			["models", "vet"],
			[
				"models",
				"vet",
				"--agent=cline",
				"--provider=lemonade",
				"--model=GLM-4.7-Flash-GGUF",
				"--role=dev",
				"--project=kanban-2uge",
				"--max-min=1",
				"--max-cost=0.5",
				"--json",
			],
		);
		expect(joined).toEqual([expected]);
	});

	it("still refuses models vet without --agent", async () => {
		await expect(parse(["models", "vet"], ["models", "vet", "--role", "dev"])).rejects.toThrow(
			/required option '--agent <agent>' not specified/,
		);
	});

	it("passes the options of models list and models allow-provisional", async () => {
		expect(
			await parse(["models", "list"], ["models", "list", "--project", "kanban-2uge", "--role", "qa", "--json"]),
		).toEqual([{ project: "kanban-2uge", role: "qa", json: true }]);
		expect(
			await parse(
				["models", "allow-provisional"],
				["models", "allow-provisional", "on", "--project", "kanban-2uge"],
			),
		).toEqual(["on", { project: "kanban-2uge" }]);
	});

	it("passes --agent to the other subcommands that have one", async () => {
		const [run] = await parse(
			["orchestrator", "run"],
			["orchestrator", "run", "--workspace", "w1", "--project", "/projects/w1", "--agent", "codex"],
		);
		expect(run).toMatchObject({ workspace: "w1", project: "/projects/w1", agent: "codex" });
		const [, create] = await parse(
			["bench", "runoff", "create"],
			["bench", "runoff", "create", "r1", "--tier", "junior", "--agent", "codex", "--dry-run"],
		);
		expect(create).toMatchObject({ tier: "junior", agent: "codex", dryRun: true });
	});

	it("drops the deprecated launch flag --agent only before the subcommand", () => {
		expect(dropDeprecatedLaunchAgentOption(["--agent", "codex", "--port", "3484"])).toEqual(["--port", "3484"]);
		expect(dropDeprecatedLaunchAgentOption(["--home", "/h", "--agent=codex", "task", "list"])).toEqual([
			"--home",
			"/h",
			"task",
			"list",
		]);
		expect(dropDeprecatedLaunchAgentOption(["models", "vet", "--agent", "cline"])).toEqual([
			"models",
			"vet",
			"--agent",
			"cline",
		]);
	});

	it("still takes root options after the subcommand", async () => {
		const program = createCliProgram();
		const target = findCommand(program, ["models", "list"]);
		target.action(() => {});
		await program.parseAsync(["models", "list", "--home", "/tmp/kanban-home-test"], { from: "user" });
		expect(program.opts()).toMatchObject({ home: "/tmp/kanban-home-test" });
	});
});
