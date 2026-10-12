// The web-ui typechecks src/trpc/app-router.ts for its `AppRouter` type, with every file the router imports (type-only
// imports included), under its own stricter tsconfig (noUncheckedIndexedAccess). The image build runs that typecheck,
// the pipeline's checks (`lint`, `test`) don't, so 6ce84a54 shipped a router whose graph reached the agent adapters
// and failed only in the image's `npm run build`. A route's schemas and API interface go in a file the router can
// import without the route's server code (restart-update-contract.ts), and a route depends on narrow interfaces
// (OrchestratorInboxReader), not on a server module's types. This walks the graph statically, so it stays fast.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");

/** Server-only entry points that pull most of the runtime into the web-ui's program. */
const FORBIDDEN = [
	"src/terminal/session-manager.ts",
	"src/terminal/agent-session-adapters.ts",
	"src/pipeline/engine.ts",
	"src/pipeline/restart-prepare.ts",
	"src/update/update.ts",
	"src/update/container-image.ts",
	"src/server/runtime-server.ts",
];

function resolveLocalImport(fromFile: string, specifier: string): string | null {
	if (!specifier.startsWith(".")) {
		return null;
	}
	const base = resolve(dirname(fromFile), specifier);
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
		if (candidate.startsWith(join(repoRoot, "src")) && existsSync(candidate) && candidate.match(/\.tsx?$/u)) {
			return candidate;
		}
	}
	return null;
}

/** Every file reachable from `entry` through relative imports, each with the file that first imported it. */
function collectImportGraph(entry: string): Map<string, string | null> {
	const importedBy = new Map<string, string | null>([[entry, null]]);
	const queue = [entry];
	for (let file = queue.shift(); file; file = queue.shift()) {
		const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
		for (const { fileName } of importedFiles) {
			const target = resolveLocalImport(file, fileName);
			if (target && !importedBy.has(target)) {
				importedBy.set(target, file);
				queue.push(target);
			}
		}
	}
	return importedBy;
}

function describeChain(graph: Map<string, string | null>, file: string): string {
	const chain: string[] = [];
	for (let current: string | null | undefined = file; current; current = graph.get(current)) {
		chain.push(relative(repoRoot, current));
	}
	return chain.reverse().join(" -> ");
}

describe("the app router's import graph (typechecked by the web-ui)", () => {
	it("doesn't reach the server-only entry points", () => {
		const graph = collectImportGraph(join(repoRoot, "src/trpc/app-router.ts"));
		const reached = FORBIDDEN.map((path) => join(repoRoot, path))
			.filter((path) => graph.has(path))
			.map((path) => describeChain(graph, path));
		expect(reached).toEqual([]);
	});
});
