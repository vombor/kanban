// Project isolation's decisions (src/isolation/access-policy.ts, isolation-settings.ts, grants.ts).
import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { decideProjectChange, decideWorkspaceAccess } from "../../../src/isolation/access-policy";
import { createIsolationGrantStore } from "../../../src/isolation/grants";
import { resolveIsolationMode, resolveReachIsolationMode } from "../../../src/isolation/isolation-settings";
import type { AgentSessionIdentity, RuntimeCaller } from "../../../src/isolation/session-identity";

const ORCHESTRATOR_A: AgentSessionIdentity = {
	workspaceId: "a",
	taskId: "__home_agent__:a:claude",
	role: "orchestrator",
	agentId: "claude",
	cwd: "/projects/a",
};
const SESSION_A: RuntimeCaller = { kind: "session", session: ORCHESTRATOR_A, via: "credential" };
const USER: RuntimeCaller = { kind: "user" };

function config(raw: Record<string, unknown>) {
	return parsePipelineConfig(raw).config;
}

describe("isolation modes", () => {
	it("is off by default, and a workspace overrides the machine-wide mode", () => {
		expect(resolveIsolationMode(config({}), "a")).toBe("off");
		const parsed = config({ isolation: { mode: "report" }, workspaces: { a: { isolation: { mode: "enforce" } } } });
		expect(resolveIsolationMode(parsed, "a")).toBe("enforce");
		expect(resolveIsolationMode(parsed, "b")).toBe("report");
	});

	it("a reach between two workspaces takes the stricter mode, so an enforced project is protected", () => {
		const parsed = config({ workspaces: { b: { isolation: { mode: "enforce" } } } });
		expect(resolveReachIsolationMode(parsed, "a", "b")).toBe("enforce");
		expect(resolveReachIsolationMode(parsed, "b", "a")).toBe("enforce");
		expect(resolveReachIsolationMode(parsed, "a", "c")).toBe("off");
	});

	it("orchestrator messages are denied unless the workspace allows them", () => {
		expect(config({}).workspaces.a).toBeUndefined();
		expect(config({ workspaces: { a: {} } }).workspaces.a?.isolation).toEqual({ mode: null, messages: "deny" });
	});
});

describe("decideWorkspaceAccess", () => {
	it("allows the user everything and a session its own workspace", () => {
		const enforce = config({ isolation: { mode: "enforce" } });
		expect(decideWorkspaceAccess({ config: enforce, caller: USER, toWorkspaceId: "b", grant: null }).outcome).toBe(
			"allow",
		);
		expect(
			decideWorkspaceAccess({ config: enforce, caller: SESSION_A, toWorkspaceId: "a", grant: null }).outcome,
		).toBe("allow");
	});

	it("refuses another workspace under enforce, reports it under report, allows it when off", () => {
		const decide = (mode: string) =>
			decideWorkspaceAccess({
				config: config({ isolation: { mode } }),
				caller: SESSION_A,
				toWorkspaceId: "b",
				grant: null,
			}).outcome;
		expect(decide("enforce")).toBe("refuse");
		expect(decide("report")).toBe("report");
		expect(decide("off")).toBe("allow");
	});

	it("a user's grant lets the session reach the granted workspace only, until it expires", () => {
		let now = Date.parse("2026-10-07T12:00:00Z");
		const grants = createIsolationGrantStore(() => now);
		const grant = grants.add({
			workspaceId: "a",
			session: "orchestrator",
			reach: ["b"],
			reason: "migration",
			minutes: 30,
		});
		expect(grants.find(ORCHESTRATOR_A, "b")?.id).toBe(grant.id);
		expect(grants.find(ORCHESTRATOR_A, "c")).toBeNull();
		expect(grants.find({ ...ORCHESTRATOR_A, taskId: "card1", role: "card" }, "b")).toBeNull();
		const enforce = config({ isolation: { mode: "enforce" } });
		expect(
			decideWorkspaceAccess({
				config: enforce,
				caller: SESSION_A,
				toWorkspaceId: "b",
				grant: grants.find(ORCHESTRATOR_A, "b"),
			}).outcome,
		).toBe("allow");
		now += 31 * 60_000;
		expect(grants.find(ORCHESTRATOR_A, "b")).toBeNull();
		expect(grants.list()).toEqual([]);
	});
});

describe("decideProjectChange", () => {
	it("refuses create, add and remove from every agent session whatever the mode, except re-adding its own", () => {
		expect(decideProjectChange({ caller: SESSION_A, kind: "create", targetWorkspaceId: null }).allowed).toBe(false);
		expect(decideProjectChange({ caller: SESSION_A, kind: "add", targetWorkspaceId: null }).allowed).toBe(false);
		expect(decideProjectChange({ caller: SESSION_A, kind: "add", targetWorkspaceId: "b" }).allowed).toBe(false);
		expect(decideProjectChange({ caller: SESSION_A, kind: "remove", targetWorkspaceId: "a" }).allowed).toBe(false);
		expect(decideProjectChange({ caller: SESSION_A, kind: "add", targetWorkspaceId: "a" }).allowed).toBe(true);
		expect(decideProjectChange({ caller: USER, kind: "create", targetWorkspaceId: null }).allowed).toBe(true);
	});

	it("tells the agent not to ask another project's orchestrator either", () => {
		const decision = decideProjectChange({ caller: SESSION_A, kind: "create", targetWorkspaceId: null });
		expect(decision.allowed ? "" : decision.message).toContain("must not ask another project's orchestrator");
	});
});
