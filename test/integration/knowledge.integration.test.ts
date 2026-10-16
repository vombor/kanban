import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DevInstance, startDevInstance } from "../../web-ui/tests/mobile/dev-instance";

describe("project knowledge CLI through a real isolated server", () => {
	let instance: DevInstance;
	beforeAll(async () => {
		instance = await startDevInstance({
			fakeCommands: {
				claude: `#!/usr/bin/env node
if(process.argv.includes("--version")){console.log("fake 1.0");process.exit(0);}
process.stdin.resume();
`,
			},
			globalConfig: {
				home: 1,
				selectedAgentId: "claude",
				agents: { cline: { lemonadeContextSync: { mode: "off" } } },
			},
		});
	}, 90_000);
	afterAll(async () => {
		await instance?.stop();
	}, 20_000);
	const run = (args: string[]) => {
		const result = instance.runCli(["knowledge", ...args, "--json"]);
		if (result.status !== 0) throw new Error(`CLI refused: ${result.stderr}`);
		return JSON.parse(result.stdout) as unknown;
	};
	it("publishes, reads sections, searches, proposes/reviews, pins and reports history without creating cards", async () => {
		const empty = run(["list"]) as { documents: unknown[] };
		expect(empty.documents).toEqual([]);
		const file = join(instance.rootDir, "contract.md");
		await writeFile(file, "# Shared API\n\n## Pagination\nUse a cursor.\n\n## Errors\nReturn 409.\n");
		const requestId = randomUUID();
		const publish = [
			"publish",
			"shared-api",
			"--file",
			file,
			"--kind",
			"contract",
			"--title",
			"Shared API",
			"--expected-revision",
			"none",
			"--request-id",
			requestId,
		];
		const first = run(publish) as { kind: "document"; document: { revision: string } };
		expect(run(publish)).toEqual(first);
		const read = run(["read", "shared-api", "--section", "pagination", "--limit", "30"]) as {
			markdown: string;
			authority: string;
			document: { revision: string };
		};
		expect(read.markdown).toContain("Use a cursor");
		expect(read.markdown).not.toContain("Return 409");
		expect(read.authority).toBe("reference_material_not_execution_approval");
		const search = run(["search", "cursor"]) as { results: unknown[] };
		expect(search.results).toHaveLength(1);
		await writeFile(file, "# Shared API\nNew proposed interface.\n");
		const proposal = run([
			"propose",
			"shared-api",
			"--file",
			file,
			"--kind",
			"contract",
			"--title",
			"Shared API",
			"--expected-revision",
			first.document.revision,
			"--reason",
			"Clarify the contract",
		]) as { proposal: { id: string } };
		const proposals = run(["proposals"]) as { proposals: unknown[] };
		expect(proposals.proposals).toHaveLength(1);
		const proposedRead = run(["proposal", proposal.proposal.id]) as { markdown: string; authority: string };
		expect(proposedRead.markdown).toContain("proposed interface");
		expect(proposedRead.authority).toBe("unpublished_proposal");
		const reviewed = run([
			"review",
			proposal.proposal.id,
			"--decision",
			"publish",
			"--expected-revision",
			first.document.revision,
		]) as { proposal: { publishedRevision: string } };
		const pinned = run(["pin", "shared-api", "--expected-revision", reviewed.proposal.publishedRevision]) as {
			document: { pinnedByUser: boolean; revision: string };
		};
		expect(pinned.document.pinnedByUser).toBe(true);
		const old = run(["read", "shared-api", "--revision", first.document.revision]) as { markdown: string };
		expect(old.markdown).toContain("Use a cursor");
		const history = run(["history", "shared-api"]) as { revisions: unknown[] };
		expect(history.revisions).toHaveLength(3);
		const context = run(["context"]) as { authority: string; documents: unknown[] };
		expect(context.authority).toBe("project_index_not_task_approval");
		expect(context.documents).toHaveLength(1);
		const projects = (await (await fetch(`${instance.runtimeUrl}/api/trpc/projects.list`)).json()) as {
			result: { data: { projects: Array<{ taskCounts: Record<string, number> }> } };
		};
		expect(
			projects.result.data.projects
				.flatMap((project) => Object.values(project.taskCounts))
				.every((count) => count === 0),
		).toBe(true);
	}, 90_000);
	it("refuses stale updates and malformed scope/id requests instead of altering knowledge", async () => {
		const file = join(instance.rootDir, "stale.md");
		await writeFile(file, "stale attempt");
		const failed = instance.runCli([
			"knowledge",
			"publish",
			"shared-api",
			"--file",
			file,
			"--kind",
			"contract",
			"--title",
			"Stale",
			"--expected-revision",
			"none",
		]);
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).toContain("changed");
		const escaped = instance.runCli(["knowledge", "read", "../outside"]);
		expect(escaped.status).not.toBe(0);
		const invalidScope = instance.runCli([
			"knowledge",
			"list",
			"--project",
			join(instance.rootDir, "outside-any-registered-project"),
		]);
		expect(invalidScope.status).not.toBe(0);
	});
});
