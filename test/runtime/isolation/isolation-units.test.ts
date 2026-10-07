// Smaller isolation pieces: the command path matcher, message text and addresses, the watchdog's server-side check,
// and doctor's rows.
import { describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import { checkIsolation } from "../../../src/doctor/isolation-checks";
import { findDeniedPathInCommand, findProtectedFileWrite } from "../../../src/guardrails/command-patterns";
import { createMessageNoticeQueue, type NoticeTarget } from "../../../src/isolation/message-notices";
import { buildMessageNotice, resolveProjectAddress, sanitizeMessageText } from "../../../src/isolation/messages";
import type { AgentSessionIdentity } from "../../../src/isolation/session-identity";
import { createWatchdogActionHandler } from "../../../src/server/watchdog-actions";
import { describeAgentIsolation } from "../../../src/terminal/agent-guardrails";
import { evaluateClaudeGuard } from "../../../src/terminal/claude-guard";

describe("findDeniedPathInCommand", () => {
	const roots = ["/projects/other", "/home/u/.kanban/data/other"];
	it("finds absolute, ~/, ../ and --opt=/path words inside a denied root", () => {
		expect(findDeniedPathInCommand("cat /projects/other/README.md", roots, "/projects/mine")).toBe(
			"/projects/other/README.md",
		);
		expect(findDeniedPathInCommand("cd /projects/other && git status", roots, "/projects/mine")).toBe(
			"/projects/other",
		);
		expect(findDeniedPathInCommand("ls ../other/src", roots, "/projects/mine")).toBe("../other/src");
		expect(findDeniedPathInCommand("grep -r x ~/.kanban/data/other", roots, "/x", "/home/u")).toBe(
			"~/.kanban/data/other",
		);
		expect(findDeniedPathInCommand("kanban task list --project-path=/projects/other", roots, "/x")).toBe(
			"--project-path=/projects/other",
		);
		expect(findDeniedPathInCommand("sh -c 'cat /projects/other/a'", roots, "/x")).toBeNull();
	});

	it("leaves other paths alone, including a sibling with the same prefix", () => {
		expect(findDeniedPathInCommand("cat /projects/other2/a /projects/mine/b", roots, "/projects/mine")).toBeNull();
		expect(findDeniedPathInCommand("git push origin main", roots, "/projects/mine")).toBeNull();
		expect(findDeniedPathInCommand("cat /projects/other", [], "/x")).toBeNull();
	});
});

describe("shell writes to the machine-wide config", () => {
	const roots = ["/h/.kanban/config.json", "/h/.claude/settings.json"];
	it("refuses redirects into it and writing programs naming it", () => {
		for (const command of [
			"echo {} > ~/.kanban/config.json",
			"echo x >>/h/.kanban/config.json",
			"sed -i s/off/enforce/ /h/.kanban/config.json",
			"python3 -c \"open('/h/.kanban/config.json','w')\"",
			"cp a /h/.claude/settings.json",
			"jq . x | tee ~/.claude/settings.json",
		]) {
			expect(findProtectedFileWrite(command, roots, "/p", "/h"), command).not.toBeNull();
		}
	});

	it("lets reads through", () => {
		for (const command of ["cat /h/.kanban/config.json", "jq . ~/.kanban/config.json > /tmp/x", "ls /h/.kanban"]) {
			expect(findProtectedFileWrite(command, roots, "/p", "/h"), command).toBeNull();
		}
	});

	it("is part of the Claude Code guard hook", () => {
		const denied = evaluateClaudeGuard(
			{ tool_name: "Bash", tool_input: { command: "echo {} > /h/.kanban/config.json" } },
			{ deniedCommands: [], protectedWriteRoots: roots, cwd: "/p" },
		);
		expect(denied?.hookSpecificOutput.permissionDecision).toBe("deny");
	});
});

describe("orchestrator message notices", () => {
	function queue(target: NoticeTarget | null, now = { value: 100_000 }) {
		const deliver = vi.fn(async (_workspaceId: string, _taskId: string, _text: string) => true);
		const notices = createMessageNoticeQueue({
			findOrchestratorSession: () => target,
			deliver,
			settleMs: 12_000,
			now: () => now.value,
			rateLimit: 2,
			rateWindowMs: 60_000,
		});
		return { notices, deliver, now };
	}
	const settled = (overrides: Partial<NoticeTarget> = {}): NoticeTarget => ({
		taskId: "__home_agent__:b:claude",
		summary: { state: "awaiting_review", stateChangedAt: 50_000, startedAt: 40_000, lastHookAt: null } as never,
		hasDraft: false,
		...overrides,
	});

	it("delivers one notice per settled Review, never while running, unsettled or with a draft typed", async () => {
		const running = queue(settled({ summary: { state: "running", stateChangedAt: 50_000 } as never }));
		running.notices.enqueue("b", "n1");
		expect(await running.notices.flush()).toBe(0);
		const draft = queue(settled({ hasDraft: true }));
		draft.notices.enqueue("b", "n1");
		expect(await draft.notices.flush()).toBe(0);
		const fresh = queue(settled({ summary: { state: "awaiting_review", stateChangedAt: 95_000 } as never }));
		fresh.notices.enqueue("b", "n1");
		expect(await fresh.notices.flush()).toBe(0);
		expect(fresh.notices.pending("b")).toBe(1);
		const ready = queue(settled());
		ready.notices.enqueue("b", "n1");
		ready.notices.enqueue("b", "n2");
		expect(await ready.notices.flush()).toBe(1);
		expect(ready.deliver).toHaveBeenCalledWith("b", "__home_agent__:b:claude", "n1");
		expect(ready.notices.pending("b")).toBe(1);
		const none = queue(null);
		none.notices.enqueue("b", "n1");
		expect(await none.notices.flush()).toBe(0);
	});

	it("rate-limits sends per sender → receiver pair", () => {
		const { notices, now } = queue(settled());
		expect(notices.allowSend("a", "b")).toBe(true);
		expect(notices.allowSend("a", "b")).toBe(true);
		expect(notices.allowSend("a", "b")).toBe(false);
		expect(notices.allowSend("c", "b")).toBe(true);
		now.value += 61_000;
		expect(notices.allowSend("a", "b")).toBe(true);
	});
});

describe("orchestrator message text", () => {
	it("drops terminal escapes and control characters, keeps newlines and tabs", () => {
		expect(sanitizeMessageText("  a\u001b[2Jb\u0007\r\nc\td\u009b  ")).toBe("a[2Jb\nc\td");
	});

	it("addresses projects by id or name, never by path, and refuses an ambiguous name", () => {
		const config = parsePipelineConfig({ workspaces: { w1: { name: "shop" } } }).config;
		const entries = [
			{ workspaceId: "w1", repoPath: "/p/shop-repo" },
			{ workspaceId: "w2", repoPath: "/p/api" },
			{ workspaceId: "w3", repoPath: "/q/api" },
		];
		expect(resolveProjectAddress("w2", entries, config)).toEqual({ workspaceId: "w2" });
		expect(resolveProjectAddress("shop", entries, config)).toEqual({ workspaceId: "w1" });
		expect(resolveProjectAddress("api", entries, config)).toEqual({ error: '"api" names more than one project.' });
		expect(resolveProjectAddress("/p/api", entries, config)).toEqual({
			error: "Address the project by name, not by path.",
		});
	});

	it("the notice carries ids only, never the text", () => {
		const notice = buildMessageNotice({
			id: "m-1",
			at: "",
			fromWorkspaceId: "a",
			toWorkspaceId: "b",
			kind: "request",
			inReplyTo: null,
			text: "/clear && rm -rf ~",
		});
		expect(notice.startsWith("[Kanban]")).toBe(true);
		expect(notice).not.toContain("rm -rf");
	});
});

describe("watchdog actions under project isolation", () => {
	function handler(raw: Record<string, unknown>) {
		const startTaskSession = vi.fn(async () => ({ ok: true, summary: null }));
		const issued: AgentSessionIdentity[] = [];
		const bound: { credential: string; pid: number }[] = [];
		const handle = createWatchdogActionHandler({
			getWorkspacePathById: (workspaceId) => `/projects/${workspaceId}`,
			getTerminal: async () => ({}) as never,
			startTaskSession,
			runProcessSweep: async () => ({ supported: false, lastSweep: null }),
			onBoardMutated: async () => {},
			readConfig: async () => parsePipelineConfig(raw).config,
			credentials: {
				issueCredential: (identity) => {
					issued.push(identity);
					return "cred-1";
				},
				bindCredential: (credential, pid) => {
					bound.push({ credential, pid });
					return true;
				},
			},
		});
		return { handle, startTaskSession, issued, bound };
	}

	it("issues a headless run the workspace's orchestrator credential and binds it to the run's pid", async () => {
		const { handle, issued, bound } = handler({});
		expect(await handle({ kind: "issueOrchestratorCredential", workspaceId: "a", agentId: "claude" })).toEqual({
			ok: true,
			credential: "cred-1",
		});
		expect(issued).toEqual([
			{
				workspaceId: "a",
				taskId: createHomeAgentSessionId("a", "claude"),
				role: "orchestrator",
				agentId: "claude",
				cwd: "/projects/a",
			},
		]);
		expect(await handle({ kind: "bindOrchestratorCredential", credential: "cred-1", pid: 77 })).toEqual({ ok: true });
		expect(bound).toEqual([{ credential: "cred-1", pid: 77 }]);
	});

	it("B's board can't start or type into A's orchestrator under enforce", async () => {
		const { handle, startTaskSession } = handler({ isolation: { mode: "enforce" } });
		const started = await handle({
			kind: "startOrchestratorSession",
			workspaceId: "a",
			agentId: "claude",
			prompt: "wake",
			fromWorkspaceId: "b",
		});
		expect(started).toMatchObject({ ok: false });
		expect(startTaskSession).not.toHaveBeenCalled();
		const typed = await handle({
			kind: "deliverInput",
			workspaceId: "a",
			taskId: createHomeAgentSessionId("a", "claude"),
			text: "wake",
			fromWorkspaceId: "b",
		});
		expect(typed).toMatchObject({ ok: false, status: "error" });
	});

	it("never types into another workspace's orchestrator session under any mode", async () => {
		const { handle } = handler({});
		const typed = await handle({
			kind: "deliverInput",
			workspaceId: "b",
			taskId: createHomeAgentSessionId("a", "claude"),
			text: "wake",
		});
		expect(typed).toMatchObject({ ok: false, error: expect.stringContaining("not b's orchestrator session") });
	});

	it("a workspace's own wake goes through", async () => {
		const { handle, startTaskSession } = handler({ isolation: { mode: "enforce" } });
		expect(
			await handle({
				kind: "startOrchestratorSession",
				workspaceId: "a",
				agentId: "claude",
				prompt: "w",
				fromWorkspaceId: "a",
			}),
		).toMatchObject({ ok: true });
		expect(startTaskSession).toHaveBeenCalledTimes(1);
	});
});

describe("doctor isolation rows", () => {
	const entries = [
		{ workspaceId: "a", repoPath: "/p/a" },
		{ workspaceId: "b", repoPath: "/p/b" },
	];
	const installed = { isInstalled: (binary: string) => ["claude", "codex", "copilot", "cline"].includes(binary) };

	it("says isolation is off and that project changes are the user's", () => {
		const findings = checkIsolation(parsePipelineConfig({}).config, entries, installed);
		expect(findings.every((finding) => finding.area === "isolation")).toBe(true);
		expect(findings.map((finding) => finding.message).join("\n")).toContain("project isolation is off");
		expect(findings[0]?.message).toContain("refuse it from every agent session");
	});

	it("shows each workspace's mode with each agent's level, and warns on a cross-project wake target", () => {
		const config = parsePipelineConfig({
			orchestrator: { wake: { target: "b" } },
			workspaces: { a: { isolation: { mode: "enforce", messages: "allow" } } },
		}).config;
		const findings = checkIsolation(config, entries, installed);
		const row = findings.find((finding) => finding.message.startsWith("workspace a:"));
		expect(row?.message).toContain("isolation enforce; orchestrator messages allow");
		expect(row?.message).toContain("Claude Code partial");
		expect(row?.message).toContain("OpenAI Codex prompt-only");
		expect(row?.level).toBe("warn");
		expect(findings.some((finding) => finding.message.startsWith("orchestrator.wake.target is b"))).toBe(true);
	});

	it("agent levels: Claude, Cline and Copilot partial, Codex and unverified agents prompt-only", () => {
		expect(describeAgentIsolation("claude").overall).toBe("partial");
		expect(describeAgentIsolation("cline").overall).toBe("partial");
		expect(describeAgentIsolation("copilot").overall).toBe("partial");
		expect(describeAgentIsolation("codex").overall).toBe("prompt-only");
		expect(describeAgentIsolation("gemini").overall).toBe("prompt-only");
	});
});
