import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runtimeBoardDataSchema } from "../../../src/core/api-contract";
import { DEV_COMPLETION_MARKER } from "../../../src/kits/dev-completion";
import { createGitTestEnv } from "../../../test/utilities/git-env";
import { expect, test } from "../shared-chrome";
import { type DevInstance, startDevInstance } from "./dev-instance";

const FAKE = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
if(process.argv.includes('--version')){console.log('fake 1.0');process.exit(0);}
const args=process.argv.slice(2),prompt=args.find(value=>value.includes('TEAM DEVELOPER COMPLETION CONTRACT'))??args.find(value=>value.includes('You are the QA reviewer'))??'';
const folder=path.join(process.env.HOME,'owned-captures');fs.mkdirSync(folder,{recursive:true});
if(prompt)fs.writeFileSync(path.join(folder,process.pid+'.json'),JSON.stringify({prompt,cwd:process.cwd()}));
if(prompt.includes('TEAM DEVELOPER COMPLETION CONTRACT')){
 fs.writeFileSync('src/app.mjs','export const value = 2;\\n');
 for(const command of [['--test','test/app.test.mjs'],['build.mjs']]){const r=cp.spawnSync(process.execPath,command,{encoding:'utf8'});process.stdout.write(r.stdout??'');if(r.status!==0)process.exit(8);}
 const index=args.indexOf('--settings');const settings=JSON.parse(fs.readFileSync(args[index+1],'utf8'));const command=settings.hooks.Stop[0].hooks[0].command;
 const stopped=cp.spawnSync('bash',['-c',command],{input:JSON.stringify({hook_event_name:'Stop',last_assistant_message:'Owned fixture implemented; unit tests and build passed; native completion.'}),encoding:'utf8'});if(stopped.status!==0)process.exit(9);
}
process.stdout.write('OWNED FAKE CLI - NO MODEL\\r\\n');process.stdin.resume();
`;

test.describe("CLI output and native dev handoff", () => {
	let instance: DevInstance, home: string, workspaceId: string;
	test.afterEach(async () => {
		await instance?.stop();
	});
	async function start(config: Record<string, unknown> = {}) {
		instance = await startDevInstance({
			fakeCommands: { claude: FAKE, cline: FAKE },
			globalConfig: {
				selectedAgentId: "claude",
				sessionSync: { reviewSettleSec: 0 },
				agents: { cline: { lemonadeContextSync: { mode: "off" } } },
				pipeline: { recovery: { mode: "off" } },
				...config,
			},
			runtimeArgs: ["--skip-shutdown-cleanup"],
		});
		home = join(instance.rootDir, "kanban-home");
		const index = z
			.object({ entries: z.record(z.string(), z.object({ workspaceId: z.string() })) })
			.parse(JSON.parse(await readFile(join(home, "workspaces/index.json"), "utf8")));
		const entries = Object.values(index.entries);
		if (entries.length !== 1 || !entries[0]) throw new Error("Expected owned workspace");
		workspaceId = entries[0].workspaceId;
	}
	test("returns complete large board and kit JSON through real CLI stdout pipes (#70)", async () => {
		test.setTimeout(120000);
		await start();
		const created = instance.runCli([
			"task",
			"create",
			"--title",
			"Owned output fixture",
			"--prompt",
			"Do not run this fixture card.",
		]);
		expect(created.status, created.stderr).toBe(0);
		const boardPath = join(home, "workspaces", workspaceId, "board.json"),
			board = runtimeBoardDataSchema.parse(JSON.parse(await readFile(boardPath, "utf8"))),
			template = board.columns.flatMap((c) => c.cards)[0];
		if (!template) throw new Error("Missing fixture card");
		const backlog = board.columns.find((c) => c.id === "backlog");
		if (!backlog) throw new Error("Missing backlog");
		backlog.cards = Array.from({ length: 24 }, (_, i) => ({
			...template,
			id: `owned${i}`,
			title: `Owned pipe ${i}`,
			prompt: "owned pipe content 🌱 ".repeat(600),
		}));
		await writeFile(boardPath, JSON.stringify(board));
		const list = instance.runCli(["task", "list"]);
		expect(list.status, list.stderr).toBe(0);
		expect(Buffer.byteLength(list.stdout)).toBeGreaterThan(262144);
		expect(() => JSON.parse(list.stdout)).not.toThrow();
		const kit = instance.runCli(["kit", "apply", "team", "--preset", "lemonade", "--project", workspaceId]);
		expect(kit.status, kit.stderr).toBe(0);
		const configPath = join(home, "config.json"),
			config = JSON.parse(await readFile(configPath, "utf8"));
		config.workspaces[workspaceId].kit.overrides["qa.blurb"] = "owned kit output ".repeat(6000);
		await writeFile(configPath, JSON.stringify(config));
		const show = instance.runCli(["kit", "show", "--project", workspaceId, "--json"]);
		expect(show.status, show.stderr).toBe(0);
		expect(Buffer.byteLength(show.stdout)).toBeGreaterThan(65536);
		expect(() => JSON.parse(show.stdout)).not.toThrow();
	});
	test("injects dev-only defaults and lets native completion move to Review and existing QA consume it (#71)", async () => {
		test.setTimeout(120000);
		await start();
		await mkdir(join(instance.projectDir, "src"), { recursive: true });
		await mkdir(join(instance.projectDir, "test"), { recursive: true });
		await writeFile(
			join(instance.projectDir, "package.json"),
			JSON.stringify({
				name: "owned-dev-handoff",
				private: true,
				scripts: { test: "node --test test/app.test.mjs", build: "node build.mjs" },
			}),
		);
		await writeFile(join(instance.projectDir, "src/app.mjs"), "export const value = 1;\n");
		await writeFile(
			join(instance.projectDir, "test/app.test.mjs"),
			"import assert from 'node:assert/strict';import {value} from '../src/app.mjs';assert.equal(value,2);\n",
		);
		await writeFile(
			join(instance.projectDir, "build.mjs"),
			"import assert from 'node:assert/strict';import {value} from './src/app.mjs';assert.equal(value,2);console.log('Owned build passed');\n",
		);
		execFileSync("git", ["add", "."], { cwd: instance.projectDir, env: createGitTestEnv() });
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-m", "Owned failing dev fixture"], {
			cwd: instance.projectDir,
			env: createGitTestEnv(),
			stdio: "pipe",
		});
		const applied = instance.runCli([
			"kit",
			"apply",
			"team",
			"--preset",
			"lemonade",
			"--landing",
			"qa",
			"--project",
			workspaceId,
		]);
		expect(applied.status, applied.stderr).toBe(0);
		const configPath = join(home, "config.json"),
			config = JSON.parse(await readFile(configPath, "utf8"));
		config.workspaces[workspaceId].checks = { enabled: false };
		await writeFile(configPath, JSON.stringify(config));
		const created = instance.runCli([
			"task",
			"create",
			"--title",
			"Owned native dev completion",
			"--prompt",
			"Change src/app.mjs to export value 2, pass the existing unit test/build, then finish normally. No browser work.",
			"--agent-id",
			"claude",
			"--model",
			"claude-owned-fixture",
		]);
		expect(created.status, created.stderr).toBe(0);
		const taskId = z.object({ task: z.object({ id: z.string() }) }).parse(JSON.parse(created.stdout)).task.id;
		await instance.restartRuntime();
		const started = instance.runCli(["task", "start", "--task-id", taskId]);
		expect(started.status, started.stderr).toBe(0);
		const boardPath = join(home, "workspaces", workspaceId, "board.json");
		await expect(async () => {
			const board = runtimeBoardDataSchema.parse(JSON.parse(await readFile(boardPath, "utf8")));
			expect(board.columns.find((c) => c.id === "review")?.cards.some((card) => card.id === taskId)).toBe(true);
			expect(
				board.columns.flatMap((c) => c.cards).some((card) => card.role === "qa" && card.reviewsTaskId === taskId),
			).toBe(true);
		}).toPass({ timeout: 60000 });
		await expect(async () => {
			const captures = await readdir(join(instance.rootDir, "user-home", "owned-captures")),
				prompts = await Promise.all(
					captures.map((file) => readFile(join(instance.rootDir, "user-home", "owned-captures", file), "utf8")),
				);
			expect(prompts.some((text) => text.includes(DEV_COMPLETION_MARKER))).toBe(true);
			const qaPrompts = prompts
				.map((text) => z.object({ prompt: z.string() }).parse(JSON.parse(text)))
				.filter((record) => record.prompt.includes("You are the QA reviewer"));
			expect(qaPrompts.length).toBeGreaterThan(0);
			for (const record of qaPrompts) expect(record.prompt).not.toContain(DEV_COMPLETION_MARKER);
		}).toPass({ timeout: 30000 });
	});
});
