// `kanban project create|add` without `--kit`: on a terminal the user is asked which routing kit the new project
// uses (`default` preselected, src/kits/kit-choices.ts), and for the `team` kit which preset's models (a custom team
// needs its role models typed as flags: `--kit team --custom --set roles.<role>.agent=...`). Without a terminal nothing is asked and the project gets
// `default`, so scripts and agents never block. The prompt goes to stderr, so `--json` output stays clean.
import { createInterface } from "node:readline/promises";

import { describeKitChoiceRole } from "../core/kit-choice-display";
import type { KitChoiceList, NewProjectKitSelection } from "../kits/kit-choices";

export interface KitPromptIo {
	/** One answer line; null when the input ended. */
	ask: (question: string) => Promise<string | null>;
	write: (line: string) => void;
}

const MAX_ATTEMPTS = 3;

export function formatKitChoices(choices: KitChoiceList): string[] {
	const lines = ["Routing kit for the new project (change it later with kanban kit apply):"];
	choices.kits.forEach((kit, index) => {
		const origin = kit.origin === "built-in" ? "built-in" : "user kit";
		lines.push(
			`  ${index + 1}) ${kit.name} (${origin})${kit.name === choices.defaultKitName ? " [default]" : ""}`,
			...(kit.description ? [`       ${kit.description}`] : []),
			kit.name === choices.teamKitName
				? `       models: a preset (${choices.presets.map((preset) => preset.name).join(", ")}), asked next`
				: `       ${kit.roles.map((role) => `${role.role}: ${describeKitChoiceRole(role)}`).join(" · ")}`,
		);
	});
	return lines;
}

export function formatPresetChoices(choices: KitChoiceList): string[] {
	const lines = [
		`Models for the ${choices.teamKitName} kit (the fallback starts without asking, so a paid fallback model runs and costs without approval):`,
	];
	choices.presets.forEach((preset, index) => {
		lines.push(
			`  ${index + 1}) ${preset.name}`,
			...(preset.description ? [`       ${preset.description}`] : []),
			`       ${preset.roles.map((role) => `${role.role}: ${describeKitChoiceRole(role)}`).join(" · ")}`,
		);
	});
	lines.push(
		`  Your own models (a custom team): press Ctrl-C and run again with --kit ${choices.teamKitName} --custom --set roles.dev.agent=<agent> --set roles.qa.agent=<agent> [--set roles.<role>.provider|model=...].`,
	);
	return lines;
}

async function askPreset(choices: KitChoiceList, io: KitPromptIo): Promise<string> {
	for (const line of formatPresetChoices(choices)) {
		io.write(line);
	}
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		const answer = (await io.ask("Preset: "))?.trim() ?? "";
		const byNumber = /^\d+$/.test(answer) ? choices.presets[Number(answer) - 1] : undefined;
		const picked = byNumber ?? choices.presets.find((preset) => preset.name === answer);
		if (picked) {
			return picked.name;
		}
		io.write(`"${answer}" is not one of the presets above; enter its number or name.`);
	}
	throw new Error("No preset chosen.");
}

function selectKit(name: string, preset: string | null = null): NewProjectKitSelection {
	return { name, preset, roleSettings: {} };
}

/**
 * Asks until the answer is a listed kit (number or name), then for the team kit its preset; an empty answer or ended
 * input is `default`.
 */
export async function askProjectKit(choices: KitChoiceList, io: KitPromptIo): Promise<NewProjectKitSelection> {
	for (const line of formatKitChoices(choices)) {
		io.write(line);
	}
	const defaultIndex = choices.kits.findIndex((kit) => kit.name === choices.defaultKitName) + 1;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		const answer = (await io.ask(`Kit [${defaultIndex}, ${choices.defaultKitName}]: `))?.trim() ?? "";
		if (answer === "") {
			return selectKit(choices.defaultKitName);
		}
		const byNumber = /^\d+$/.test(answer) ? choices.kits[Number(answer) - 1] : undefined;
		const picked = byNumber ?? choices.kits.find((kit) => kit.name === answer);
		if (picked) {
			return picked.name === choices.teamKitName
				? selectKit(picked.name, await askPreset(choices, io))
				: selectKit(picked.name);
		}
		io.write(`"${answer}" is not one of the kits above; enter its number or name.`);
	}
	throw new Error("No kit chosen.");
}

/** The terminal prompt, or undefined when stdin is not a terminal (then the project gets `default`). */
export function createTerminalKitPrompt(): ((choices: KitChoiceList) => Promise<NewProjectKitSelection>) | undefined {
	if (!process.stdin.isTTY) {
		return undefined;
	}
	return async (choices) => {
		const prompt = createInterface({ input: process.stdin, output: process.stderr });
		let ended = false;
		let interrupted = false;
		prompt.once("close", () => {
			ended = true;
		});
		// Without a listener readline only pauses on Ctrl-C; the user means "stop", so nothing is changed.
		prompt.once("SIGINT", () => {
			interrupted = true;
			prompt.close();
		});
		const ask = async (question: string): Promise<string | null> => {
			const answer = ended ? null : await prompt.question(question).catch(() => null);
			if (interrupted) {
				throw new Error("Interrupted; nothing was changed.");
			}
			return answer;
		};
		try {
			return await askProjectKit(choices, {
				ask,
				write: (line) => process.stderr.write(`${line}\n`),
			});
		} finally {
			prompt.close();
		}
	};
}
