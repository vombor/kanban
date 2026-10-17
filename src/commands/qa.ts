import type { Command } from "commander";

import { readPipelineConfig } from "../config/pipeline-config";
import { resolveQaChromiumLibs } from "../pipeline/qa-browser-tooling";
import { runQaShot } from "../pipeline/qa-shot";
import { getQaToolchainInfo, verifyQaToolchain } from "../pipeline/qa-toolchain";

function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

export function registerQaCommand(program: Command): void {
	const qa = program.command("qa").description("Tools for QA agents (run in the QA scratch copy).");
	qa.command("tools")
		.description(
			"Show pinned shared QA modules/CDP endpoint; --verify drives both sizes and decodes PNGs without installing or launching a browser.",
		)
		.option("--verify")
		.option("--json")
		.action(async (options: { verify?: boolean }) => {
			try {
				process.stdout.write(
					`${JSON.stringify(options.verify ? await verifyQaToolchain() : getQaToolchainInfo(), null, 2)}\n`,
				);
			} catch (error) {
				process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
				process.exitCode = 3;
			}
		});

	qa.command("shot")
		.description(
			"Shared-Chrome screenshots and scripted journeys; writes PNGs, report.txt and report.json to --out using Kanban's pinned QA modules (kanban qa tools). Never installs or launches a browser.",
		)
		.requiredOption("--base <url>", "The app's base URL, e.g. http://127.0.0.1:3000.")
		.option("--out <dir>", "Where screenshots and reports go.", "./qa-shots")
		.option("--scratch <dir>", "The scratch copy Playwright is loaded from.", process.cwd())
		.option("--routes <routes>", "Comma-separated routes, each shot at every viewport.")
		.option(
			"--viewports <viewports>",
			"Routes and unpinned scripts run at every mobile, tablet, desktop or WxH viewport, comma-separated.",
			"mobile,desktop",
		)
		.option("--wait-for <selector>", "Wait for this selector after each navigation.")
		.option(
			"--script <file>",
			'A JSON array of typed steps (repeatable), or {"viewport":"375x667","steps":[...]}; an envelope viewport overrides --viewports. Every step needs "type"; screenshot uses "path", expectText accepts "selector" for scoping.',
			collect,
			[],
		)
		.option("--full-page", "Full-page screenshots.", false)
		.action(
			async (options: {
				base: string;
				out: string;
				scratch: string;
				routes?: string;
				viewports: string;
				waitFor?: string;
				script: string[];
				fullPage: boolean;
			}) => {
				const routes = splitList(options.routes);
				if (routes.length === 0 && options.script.length === 0) {
					process.stderr.write("kanban qa shot: give --routes and/or --script.\n");
					process.exitCode = 2;
					return;
				}
				const { config } = await readPipelineConfig();
				const result = await runQaShot({
					base: options.base,
					out: options.out,
					scratch: options.scratch,
					routes,
					viewports: splitList(options.viewports),
					waitFor: options.waitFor ?? null,
					fullPage: options.fullPage,
					scripts: options.script,
					chromiumLibs: resolveQaChromiumLibs(process.env.QA_CHROMIUM_LIBS || config.pipeline.qa.chromiumLibs),
				});
				(result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.message}\n`);
				process.exitCode = result.exitCode;
			},
		);
}
