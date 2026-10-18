import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { addRootOptions, registerCliCommands } from "../../../src/cli-program";
import { parseKnowledgeExpectedRevision, parseKnowledgeNumber } from "../../../src/commands/knowledge";

describe("knowledge CLI option parsing", () => {
	it("registers the read-only and curated commands with their real options", async () => {
		const root = new Command();
		addRootOptions(root);
		registerCliCommands(root, "test");
		const knowledge = root.commands.find((command) => command.name() === "knowledge");
		expect(knowledge?.commands.map((command) => command.name())).toEqual([
			"sources",
			"source-read",
			"source-graph",
			"source-policy",
			"source-opt-in",
			"source-collection",
			"task-attempts",
			"task-context",
			"task-read",
			"task-adopt",
			"list",
			"read",
			"search",
			"context",
			"history",
			"proposals",
			"proposal",
			"publish",
			"propose",
			"review",
			"pin",
			"unpin",
		]);
		const read = knowledge?.commands.find((command) => command.name() === "read");
		if (!read) throw new Error("Missing command");
		let result: unknown;
		read.action((id, options) => {
			result = { id, options };
		});
		await root.parseAsync(
			[
				"knowledge",
				"read",
				"api-contract",
				"--section",
				"pagination",
				"--offset",
				"10",
				"--limit",
				"100",
				"--project",
				"alpha",
			],
			{ from: "user" },
		);
		expect(result).toMatchObject({
			id: "api-contract",
			options: { section: "pagination", offset: 10, limit: 100, project: "alpha" },
		});
	});
	it("parses exact revisions and numeric continuations without accepting partial numbers", () => {
		expect(parseKnowledgeExpectedRevision("none")).toBeNull();
		expect(parseKnowledgeExpectedRevision("a".repeat(64))).toBe("a".repeat(64));
		for (const value of ["latest", "../file", "short"]) expect(() => parseKnowledgeExpectedRevision(value)).toThrow();
		for (const value of ["-1", "10x", "Infinity", "1.2"]) expect(() => parseKnowledgeNumber(value)).toThrow();
		expect(parseKnowledgeNumber("10")).toBe(10);
	});
});
