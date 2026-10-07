import type { Command } from "commander";

import { readPipelineConfig } from "../config/pipeline-config";
import { runQaShot } from "../pipeline/qa-shot";

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

	qa.command("shot")
		.description(
			"Headless-browser screenshots and scripted journeys of a running app; writes PNGs, report.txt and report.json to --out. Playwright comes from the --scratch copy.",
		)
		.requiredOption("--base <url>", "The app's base URL, e.g. http://127.0.0.1:3000.")
		.option("--out <dir>", "Where screenshots and reports go.", "./qa-shots")
		.option("--scratch <dir>", "The scratch copy Playwright is loaded from.", process.cwd())
		.option("--routes <routes>", "Comma-separated routes, each shot at every viewport.")
		.option("--viewports <viewports>", "mobile, tablet, desktop or WxH, comma-separated.", "mobile,desktop")
		.option("--wait-for <selector>", "Wait for this selector after each navigation.")
		.option(
			"--script <file>",
			"A JSON step list (repeatable): goto, fill, click, press, select, waitFor, wait, expectText, screenshot.",
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
					chromiumLibs: process.env.QA_CHROMIUM_LIBS || config.pipeline.qa.chromiumLibs,
				});
				(result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.message}\n`);
				process.exitCode = result.exitCode;
			},
		);
}
