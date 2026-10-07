// Regenerates the legacy-kit fixtures next to this file from the legacy kit's own code (read only, no Kanban
// calls, no live state). Run before cutover, while the legacy kit still exists:
//
//   node test/runtime/kits/fixtures/legacy-team/generate.cjs [<legacy kit root>]   (default ~/.kanban)
//
// Inputs: kit.config.json here (a copy of the live one, 2026-10-07) and the cards in cards.json. A temp dir stands in
// for the kit home (data, qa-log) and Cline's providers.json, so only these files decide the output.
// Outputs: qa-routes.json (what `qa/qa-card.cjs <dev> --dry-run` prints per card: lib/qa-route.cjs qaRouteFor) and
// qa-prompts.json (qa/qa-card.cjs buildPrompt for foo).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const here = __dirname;
const kitRoot = path.resolve(process.argv[2] || path.join(os.homedir(), ".kanban"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-team-fixtures-"));
try {
	const cards = JSON.parse(fs.readFileSync(path.join(here, "cards.json"), "utf8"));
	const providers = path.join(tmp, "providers.json");
	fs.writeFileSync(providers, JSON.stringify(cards.clineProvidersJson));
	const live = JSON.parse(fs.readFileSync(path.join(here, "kit.config.json"), "utf8"));
	// The one key added to the live file: the Cline default model comes from the fixture's providers.json.
	fs.writeFileSync(path.join(tmp, "kit.config.json"), JSON.stringify({ ...live, clineProviders: providers }));
	process.env.KIT_CONFIG = path.join(tmp, "kit.config.json");
	process.env.KANBAN_KIT_HOME = path.join(tmp, "home");
	process.env.KANBAN_HOME = path.join(tmp, "kanban-home"); // no workspaces.<id> entry (K-2): kit.config.json decides
	process.env.KIT_PROJECT = "foo";
	delete process.env.QA_AGENT;

	const { qaRouteFor } = require(path.join(kitRoot, "lib/qa-route.cjs"));
	const { buildPrompt, requirementsOf, PROJECT } = require(path.join(kitRoot, "qa/qa-card.cjs"));

	const routes = cards.routing.map(({ name, card }) => {
		const r = qaRouteFor(card, { flavour: "fork" });
		return { name, card, devModel: r.devModel, qaAgent: r.agent, qaProvider: r.provider, qaModel: r.model, route: r.route, rules: r.rules };
	});
	fs.writeFileSync(path.join(here, "qa-routes.json"), `${JSON.stringify(routes, null, "\t")}\n`);

	fs.mkdirSync(path.dirname(PROJECT.qaLog), { recursive: true });
	const prompts = cards.prompts.map(({ name, card, round, qaId, short, qaLog }) => {
		fs.writeFileSync(PROJECT.qaLog, qaLog ?? "");
		const { rules } = qaRouteFor(card, { flavour: "fork" });
		const requirements = requirementsOf(card.prompt);
		const prompt = buildPrompt({ devId: card.id, round, qaId, short, requirements, rules });
		return { name, card, round, qaId, short, qaLog: qaLog ?? "", rules, prompt };
	});
	fs.writeFileSync(path.join(here, "qa-prompts.json"), `${JSON.stringify(prompts, null, "\t")}\n`);
	console.log(`wrote ${routes.length} routes, ${prompts.length} prompts from ${kitRoot}`);
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
