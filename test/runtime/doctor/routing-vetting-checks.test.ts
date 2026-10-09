import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { checkRoutingVetting } from "../../../src/doctor/routing-vetting-checks";
import { getBuiltInKits } from "../../../src/kits/resolve-kit";

const catalog = {
	kits: new Map([...getBuiltInKits()].map(([name, kit]) => [name, { kit, origin: { kind: "built-in" as const } }])),
	errors: [],
};

describe("doctor: every project's routing against the vetted model registry", () => {
	it("passes foo-like routing, warns per refused route with the vet command, and notes default-kit projects", () => {
		const { config } = parsePipelineConfig({
			workspaces: {
				foo: {
					kit: {
						name: "team",
						overrides: {
							"roles.dev.agent": "codex",
							"roles.dev.model": "us.openai.gpt-6.1-sol",
							"roles.fallback.model": "us.moonshotai.kimi-k3",
							"roles.qa.agent": "cline",
							"roles.qa.model": "us.anthropic.claude-haiku-5-5",
							"roles.plan.agent": "cline",
							"roles.plan.model": "us.anthropic.claude-opus-5-5",
						},
					},
				},
				bar: { kit: { name: "team", overrides: { "roles.dev.agent": "codex", "roles.dev.model": "gpt-9" } } },
				local: { kit: { name: "team-local" }, models: { allowProvisional: true } },
			},
		});
		const findings = checkRoutingVetting({
			config,
			catalog,
			entries: [{ workspaceId: "foo" }, { workspaceId: "bar" }, { workspaceId: "local" }, { workspaceId: "plain" }],
		});
		const of = (workspaceId: string) => findings.filter((finding) => finding.message.startsWith(`${workspaceId}:`));
		expect(of("foo")).toEqual([
			expect.objectContaining({ level: "pass", message: expect.stringContaining("routes only to combinations") }),
		]);
		const bar = of("bar");
		expect(bar.every((finding) => finding.level === "warn")).toBe(true);
		expect(bar.find((finding) => finding.message.includes("roles.dev →"))).toMatchObject({
			hint: "kanban models vet --agent codex --model gpt-9 --role dev",
		});
		expect(of("local")).toEqual([
			expect.objectContaining({ level: "pass", message: expect.stringContaining("(provisional allowed)") }),
		]);
		expect(of("plain")).toEqual([expect.objectContaining({ level: "info" })]);
	});
});
