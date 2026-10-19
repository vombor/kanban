import type { Command } from "commander";

import { readPipelineConfig } from "../config/pipeline-config";
import { resolveQaChromiumLibs } from "../pipeline/qa-browser-tooling";
import { inspectQaFontconfig, repairQaFontconfig } from "../pipeline/qa-fontconfig";
import { runQaShot } from "../pipeline/qa-shot";
import { getQaToolchainInfo, verifyQaToolchain } from "../pipeline/qa-toolchain";
import { runOperatorQaEvaluation } from "../qa-evaluator/operator-run";

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
	const qa = program
		.command("qa")
		.description("QA tooling; evaluate is an explicit user-only host mode, separate from card QA.");
	qa.command("evaluate")
		.description(
			"User-only host evaluator: bounded native structured-output A/B evidence, separate from card QA. Dry-run unless --execute.",
		)
		.requiredOption(
			"--profile <file>",
			"Operator-owned capability/transport profile; credentials are env references only.",
		)
		.requiredOption("--suite <file>", "Versioned trusted cases, named signatures, oracles and explicit variants.")
		.requiredOption("--image <sha256>", "Existing immutable secret-free local Node image; never pulled.")
		.requiredOption(
			"--out <directory>",
			"New private output directory outside Git workspaces; existing output is refused.",
		)
		.option("--execute", "Explicitly authorize bounded model requests and isolated CPU containers.", false)
		.option(
			"--provider-idle-confirmed",
			"User attestation that evaluation will not contend with live work; not a capacity reservation.",
			false,
		)
		.option("--max-total-sec <seconds>", "Whole-run deadline (10–900), checked before further work.", Number, 300)
		.action(
			async (options: {
				profile: string;
				suite: string;
				image: string;
				out: string;
				execute: boolean;
				providerIdleConfirmed: boolean;
				maxTotalSec: number;
			}) => {
				try {
					const result = await runOperatorQaEvaluation(options);
					process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
					if ("matrixComplete" in result && !result.matrixComplete) process.exitCode = 3;
				} catch {
					process.stderr.write(
						"kanban qa evaluate: operator input, capability, image or execution unavailable/unconfirmed. No raw provider error, credential fallback, settings change or automatic replay was used.\n",
					);
					process.exitCode = 2;
				}
			},
		);
	qa.command("fonts")
		.description(
			"Inspect retained Fontconfig as the runtime/QA OS user; explicitly repair relocated paths with a backup. Never launches a browser.",
		)
		.option("--vendor <dir>", "Explicit retained Chromium libraries directory")
		.option("--repair", "Back up and regenerate owned paths against the resolved vendor home (user only)")
		.option("--json")
		.action(async (options: { vendor?: string; repair?: boolean }) => {
			try {
				const { config } = await readPipelineConfig();
				const vendor =
					options.vendor || resolveQaChromiumLibs(process.env.QA_CHROMIUM_LIBS || config.pipeline.qa.chromiumLibs);
				if (!vendor)
					throw new Error(
						"No retained Chromium font bundle is installed; native QA uses shared Chrome. Run kanban qa tools --verify --json for glyph readiness.",
					);
				const result = options.repair ? await repairQaFontconfig(vendor) : inspectQaFontconfig(vendor);
				process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
				if (result.issues.length) process.exitCode = 3;
			} catch (error) {
				process.stderr.write(`${error instanceof Error ? error.message : "Fontconfig inspection failed"}\n`);
				process.exitCode = 3;
			}
		});
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
