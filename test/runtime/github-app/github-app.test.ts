// The machine's Kanban GitHub App (src/github-app/, src/trpc/github-api.ts, docs/fork/github-bots.md): the manifest
// flow, the app JWT, installation tokens, who may post for which workspace, the attribution line and the PAT
// fallback, all against the fake GitHub (never the network). The private key is generated per run, so no key-shaped
// string is in this file.
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { statSync } from "node:fs";
import { chmod } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { checkGitHubApp } from "../../../src/doctor/github-app-checks";
import {
	GITHUB_APP_CREDENTIALS_VERSION,
	type GitHubAppCredentials,
	readGitHubAppCredentials,
	readGitHubAppFileModes,
	writeGitHubAppCredentials,
} from "../../../src/github-app/app-credentials";
import { createGitHubAppJwt } from "../../../src/github-app/app-jwt";
import {
	buildGitHubAppManifest,
	createGitHubAppCreationFlow,
	GITHUB_APP_CALLBACK_PATH,
	GITHUB_APP_LOGO_PATH,
	GITHUB_APP_PERMISSIONS,
	GITHUB_APP_START_PATH,
} from "../../../src/github-app/app-manifest";
import { appendAttribution, formatAttributionLine } from "../../../src/github-app/attribution";
import { createGitHubAppTokenSource } from "../../../src/github-app/installation-tokens";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import { createGitHubAppRequestHandler } from "../../../src/server/github-app-route";
import { createGitHubApi, decideGitHubPoster } from "../../../src/trpc/github-api";
import { createFakeGitHub, type FakeGitHub } from "../../utilities/fake-github";
import { createTempDir } from "../../utilities/temp-dir";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});
const KEY_BODY_LINE = privateKey.split("\n")[1] ?? "";

const CREDENTIALS: GitHubAppCredentials = {
	version: GITHUB_APP_CREDENTIALS_VERSION,
	appId: 4242,
	slug: "kanban-agents",
	name: "Kanban agents",
	ownerLogin: "vombor",
	ownerIsOrg: false,
	htmlUrl: "https://github.com/apps/kanban-agents",
	clientId: "Iv1.abc",
	privateKey,
	createdAt: "2026-10-09T11:00:00.000Z",
};

const REMOTES = [{ name: "origin", url: "git@github.com:vombor/notes.git" }];

function session(workspaceId: string, role: "card" | "orchestrator", taskId = "abc12"): RuntimeCaller {
	return {
		kind: "session",
		session: { workspaceId, taskId, role, agentId: "claude", cwd: "/w" },
		via: "credential",
	};
}

let temp: { path: string; cleanup: () => void };
let github: FakeGitHub;
let logs: string[];
let isolationLog: unknown[];

beforeEach(() => {
	temp = createTempDir("kanban-github-app-");
	github = createFakeGitHub("vombor/notes");
	github.app.now = () => NOW;
	logs = [];
	isolationLog = [];
});

afterEach(() => {
	temp.cleanup();
});

function createApi(options: { app?: GitHubAppCredentials | null; pat?: string | null } = {}) {
	const app = options.app === undefined ? CREDENTIALS : options.app;
	const tokenSource = createGitHubAppTokenSource({
		readCredentials: async () => app,
		fetch: github.fetch,
		now: () => NOW,
	});
	const flow = createGitHubAppCreationFlow({
		writeCredentials: async () => {},
		fetch: github.fetch,
		now: () => NOW,
		log: (line) => logs.push(line),
	});
	return createGitHubApi({
		tokenSource,
		flow,
		log: async (_targets, record) => {
			isolationLog.push(record);
		},
		warn: (line) => logs.push(line),
		readSettings: async () => parsePipelineConfig({}).config.github,
		listRemotes: async () => REMOTES,
		readCardRole: async () => "qa",
		resolvePat: async () =>
			options.pat === null
				? { source: "anonymous", token: null }
				: { source: "GH_TOKEN", token: options.pat ?? "pat-value" },
		http: { fetch: github.fetch, now: () => NOW },
	});
}

describe("the app manifest", () => {
	it("asks for Issues write and Metadata read only, with no active webhook and no events", () => {
		const manifest = buildGitHubAppManifest({ name: "Kanban agents", origin: "http://localhost:3485/" });
		expect(manifest.default_permissions).toEqual({ issues: "write", metadata: "read" });
		expect(manifest.default_events).toEqual([]);
		expect(manifest.hook_attributes.active).toBe(false);
		expect(manifest.public).toBe(false);
		expect(manifest.redirect_url).toBe(`http://localhost:3485${GITHUB_APP_CALLBACK_PATH}`);
		expect(manifest.setup_url).toBe("http://localhost:3485/api/github/app/installed");
	});

	it("exchanges the code once, stores the key 0600 without the client or webhook secret, and spends the state", async () => {
		const path = join(temp.path, "secrets", "github-app.json");
		const flow = createGitHubAppCreationFlow({
			writeCredentials: async (credentials) => await writeGitHubAppCredentials(credentials, path),
			fetch: github.fetch,
			now: () => NOW,
			log: (line) => logs.push(line),
		});
		const started = flow.start({ name: "Kanban agents", origin: "http://localhost:3485", org: null });
		expect(started.startUrl).toBe(`http://localhost:3485${GITHUB_APP_START_PATH}?state=${started.state}`);
		const page = flow.renderStartPage(started.state) ?? "";
		expect(page).toContain(`action="https://github.com/settings/apps/new?state=${started.state}"`);
		expect(page).toContain("&quot;issues&quot;:&quot;write&quot;");
		expect(flow.renderStartPage("forged")).toBeNull();

		github.app.manifestCodes.set("code123", {
			id: 4242,
			slug: "kanban-agents",
			name: "Kanban agents",
			html_url: "https://github.com/apps/kanban-agents",
			client_id: "Iv1.abc",
			client_secret: "client-secret-value",
			webhook_secret: "webhook-secret-value",
			pem: privateKey,
			owner: { login: "vombor", type: "User" },
		});
		expect((await flow.complete({ state: "forged", code: "code123" })).ok).toBe(false);
		const done = await flow.complete({ state: started.state, code: "code123" });
		expect(done.ok && done.app.installUrl).toBe("https://github.com/apps/kanban-agents/installations/new");
		// A state works once.
		expect((await flow.complete({ state: started.state, code: "code123" })).ok).toBe(false);

		const stored = await readGitHubAppCredentials(path);
		expect(stored?.privateKey).toBe(privateKey);
		expect(JSON.stringify(stored)).not.toContain("client-secret-value");
		expect(JSON.stringify(stored)).not.toContain("webhook-secret-value");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(temp.path, "secrets")).mode & 0o777).toBe(0o700);
		expect(logs.join("\n")).not.toContain(KEY_BODY_LINE);
	});

	it("posts to the organization's page for --org", () => {
		const flow = createGitHubAppCreationFlow({ writeCredentials: async () => {}, now: () => NOW });
		const started = flow.start({ name: "Kanban agents", origin: "http://localhost:3485", org: "acme" });
		expect(flow.renderStartPage(started.state)).toContain(
			`https://github.com/organizations/acme/settings/apps/new?state=${started.state}`,
		);
	});
});

describe("the browser routes", () => {
	async function request(handler: ReturnType<typeof createGitHubAppRequestHandler>, url: string) {
		const response: { status: number; headers: Record<string, string>; body: string | Buffer } = {
			status: 0,
			headers: {},
			body: "",
		};
		const res = {
			writeHead: (status: number, headers: Record<string, string> = {}) => {
				response.status = status;
				response.headers = headers;
			},
			end: (body?: string | Buffer) => {
				response.body = body ?? "";
			},
		} as unknown as ServerResponse;
		const handled = await handler(
			{ method: "GET", url, headers: {} } as IncomingMessage,
			res,
			url.split("?")[0] ?? "",
		);
		return { handled, ...response };
	}

	it("sends a created app on to its install page, refuses an unknown state and serves the logo", async () => {
		const flow = createGitHubAppCreationFlow({
			writeCredentials: async () => {},
			fetch: github.fetch,
			now: () => NOW,
		});
		const handler = createGitHubAppRequestHandler({
			flow,
			tokenSource: createGitHubAppTokenSource({ readCredentials: async () => CREDENTIALS, fetch: github.fetch }),
			webUiDir: join(__dirname, "../../../web-ui/public"),
		});
		const started = flow.start({ name: "Kanban agents", origin: "http://localhost:3485", org: null });
		github.app.manifestCodes.set("c1", {
			id: 1,
			slug: "kanban-agents",
			name: "Kanban agents",
			html_url: "h",
			pem: privateKey,
			owner: { login: "vombor" },
		});
		const redirect = await request(handler, `${GITHUB_APP_CALLBACK_PATH}?code=c1&state=${started.state}`);
		expect(redirect.status).toBe(302);
		expect(redirect.headers.Location).toBe("https://github.com/apps/kanban-agents/installations/new");
		expect((await request(handler, `${GITHUB_APP_CALLBACK_PATH}?code=c1&state=nope`)).status).toBe(400);

		const logo = await request(handler, GITHUB_APP_LOGO_PATH);
		expect(logo.status).toBe(200);
		expect(logo.headers["Content-Type"]).toBe("image/png");
		expect(Buffer.isBuffer(logo.body) && logo.body.length).toBeLessThan(1024 * 1024);

		const installed = await request(handler, "/api/github/app/installed?installation_id=7");
		expect(String(installed.body)).toContain("https://github.com/settings/apps/kanban-agents");
		expect(String(installed.body)).not.toContain(KEY_BODY_LINE);
		expect((await request(handler, "/api/other")).handled).toBe(false);
	});
});

describe("app JWT and installation tokens", () => {
	it("signs an RS256 JWT for the app that lives under 10 minutes", () => {
		const jwt = createGitHubAppJwt({ appId: 4242, privateKey, now: NOW });
		const [header, payload, signature] = jwt.split(".");
		const verifier = createVerify("RSA-SHA256");
		verifier.update(`${header}.${payload}`);
		expect(verifier.verify(createPublicKey(publicKey), Buffer.from(signature ?? "", "base64url"))).toBe(true);
		const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"));
		expect(claims.iss).toBe("4242");
		expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
		expect(claims.iat).toBeLessThan(NOW / 1000);
	});

	it("mints a token scoped to the one repository and Issues, caches it, and refreshes it before it expires", async () => {
		github.app.installations.set("vombor/notes", 77);
		let now = NOW;
		github.app.now = () => now;
		const source = createGitHubAppTokenSource({
			readCredentials: async () => CREDENTIALS,
			fetch: github.fetch,
			now: () => now,
		});
		const first = await source.tokenForRepo("vombor/notes");
		expect(first).toMatchObject({ kind: "app", token: "ghs_fake1", installationId: 77 });
		expect(github.app.minted[0]?.body).toEqual({ repositories: ["notes"], permissions: GITHUB_APP_PERMISSIONS });
		expect((await source.tokenForRepo("vombor/notes")).kind === "app" && github.app.minted).toHaveLength(1);
		now += 56 * 60 * 1000;
		const refreshed = await source.tokenForRepo("vombor/notes");
		expect(refreshed.kind === "app" && refreshed.token).toBe("ghs_fake2");
	});

	it("answers not installed with the install link, and no app without credentials", async () => {
		const source = createGitHubAppTokenSource({ readCredentials: async () => CREDENTIALS, fetch: github.fetch });
		const missing = await source.tokenForRepo("vombor/other");
		expect(missing.kind).toBe("not_installed");
		expect(missing.kind === "not_installed" && missing.message).toContain(
			"https://github.com/apps/kanban-agents/installations/new",
		);
		const none = createGitHubAppTokenSource({ readCredentials: async () => null, fetch: github.fetch });
		expect((await none.tokenForRepo("vombor/notes")).kind).toBe("no_app");
	});
});

describe("attribution", () => {
	it("names the project and the role, or only the project", () => {
		expect(formatAttributionLine({ project: "notes", role: "orchestrator" })).toBe("— notes · orchestrator (Kanban)");
		expect(formatAttributionLine({ project: "notes", role: null })).toBe("— notes (Kanban)");
		expect(
			formatAttributionLine(
				{ project: "notes", role: "dev" },
				{ attribution: "posted by {project}/{role}\nmore", attributionWithoutRole: "{project}" },
			),
		).toBe("posted by notes/dev more");
		expect(appendAttribution("Body\n\n", { project: "notes", role: "qa" })).toBe("Body\n\n— notes · qa (Kanban)");
		const once = appendAttribution("Body", { project: "notes", role: "qa" });
		expect(appendAttribution(once, { project: "notes", role: "qa" })).toBe(once);
	});
});

describe("github.issue", () => {
	it("maps the caller to the workspace: the user, its own sessions; never another workspace's or an unknown one", () => {
		expect(decideGitHubPoster({ kind: "user" }, "notes", null)).toMatchObject({
			allowed: true,
			author: { project: "notes", role: "user" },
			restrictRepos: false,
		});
		expect(decideGitHubPoster(session("notes", "orchestrator"), "notes", null)).toMatchObject({
			allowed: true,
			author: { project: "notes", role: "orchestrator" },
		});
		expect(decideGitHubPoster(session("notes", "card"), "notes", "dev")).toMatchObject({
			allowed: true,
			author: { project: "notes", role: "dev" },
			restrictRepos: true,
		});
		expect(decideGitHubPoster(session("foo", "card"), "notes", "dev").allowed).toBe(false);
		expect(decideGitHubPoster({ kind: "unknown", reason: "outside its tree" }, "notes", null).allowed).toBe(false);
	});

	it("posts a card's issue as the app with the attribution line, and never hands back the token or key", async () => {
		github.app.installations.set("vombor/notes", 77);
		const api = createApi();
		const response = await api.issue({
			caller: session("notes", "card"),
			workspaceId: "notes",
			workspacePath: "/projects/notes",
			request: { action: "create", repo: "vombor/notes", title: "Broken link", body: "The link is broken." },
		});
		expect(response).toMatchObject({ ok: true, via: "app", number: 1001, postedAs: "notes · qa", warning: null });
		const write = github.writes[0];
		expect(write?.authorization).toBe("Bearer ghs_fake1");
		expect(write?.body).toEqual({ title: "Broken link", body: "The link is broken.\n\n— notes · qa (Kanban)" });
		const everything = JSON.stringify(response) + logs.join("\n") + JSON.stringify(isolationLog);
		expect(everything).not.toContain("ghs_fake1");
		expect(everything).not.toContain(KEY_BODY_LINE);
	});

	it("lets a project's sessions reach the shared Kanban repo but not another repository", async () => {
		github.app.installations.set("vombor/kanban", 78);
		const api = createApi();
		const bug = await api.issue({
			caller: session("notes", "orchestrator", "__home_agent__:notes"),
			workspaceId: "notes",
			workspacePath: "/projects/notes",
			request: { action: "comment", repo: "vombor/kanban", number: 14, body: "Seen here too." },
		});
		expect(bug).toMatchObject({ ok: true, via: "app", postedAs: "notes · orchestrator" });
		expect(github.writes[0]?.body).toEqual({ body: "Seen here too.\n\n— notes · orchestrator (Kanban)" });

		const elsewhere = await api.issue({
			caller: session("notes", "card"),
			workspaceId: "notes",
			workspacePath: "/projects/notes",
			request: { action: "comment", repo: "vombor/pawsome", number: 1, body: "hi" },
		});
		expect(elsewhere.ok).toBe(false);
		expect(elsewhere.error).toContain("not vombor/pawsome");
		expect(github.writes).toHaveLength(1);
	});

	it("refuses an unknown caller and another workspace's session, and logs the refusal", async () => {
		const api = createApi();
		for (const caller of [
			session("foo", "card"),
			{ kind: "unknown", reason: "credential outside its tree" } as const,
		]) {
			const response = await api.issue({
				caller,
				workspaceId: "notes",
				workspacePath: "/projects/notes",
				request: { action: "close", repo: "vombor/notes", number: 3 },
			});
			expect(response.ok).toBe(false);
		}
		expect(isolationLog).toHaveLength(2);
		expect(github.writes).toHaveLength(0);
	});

	it("refuses a repository the app isn't installed on, with the install link", async () => {
		const response = await createApi().issue({
			caller: session("notes", "card"),
			workspaceId: "notes",
			workspacePath: "/projects/notes",
			request: { action: "comment", repo: "vombor/notes", number: 3, body: "x" },
		});
		expect(response).toMatchObject({
			ok: false,
			installUrl: "https://github.com/apps/kanban-agents/installations/new",
		});
		expect(github.writes).toHaveLength(0);
	});

	it("falls back to the user's PAT with a warning while there is no app", async () => {
		const response = await createApi({ app: null }).issue({
			caller: session("notes", "card"),
			workspaceId: "notes",
			workspacePath: "/projects/notes",
			request: { action: "edit", repo: "vombor/notes", number: 3, title: "New title" },
		});
		expect(response).toMatchObject({ ok: true, via: "pat" });
		expect(response.warning).toContain("kanban github bot create");
		expect(github.writes[0]?.authorization).toBe("Bearer pat-value");
		expect(github.writes[0]?.body).toEqual({ title: "New title" });

		const noLogin = await createApi({ app: null, pat: null }).issue({
			caller: { kind: "user" },
			workspaceId: "notes",
			workspacePath: "/projects/notes",
			request: { action: "comment", repo: "vombor/notes", number: 3, body: "x" },
		});
		expect(noLogin.ok).toBe(false);
	});

	it("closes with a comment first, and says when GitHub's rate limit lifts", async () => {
		github.app.installations.set("vombor/notes", 77);
		const api = createApi();
		const closed = await api.issue({
			caller: { kind: "user" },
			workspaceId: "notes",
			workspacePath: "/projects/notes",
			request: { action: "close", repo: "vombor/notes", number: 3, reason: "not_planned", comment: "Won't do." },
		});
		expect(closed).toMatchObject({ ok: true, number: 3 });
		expect(github.writes.map((write) => [write.method, write.path, write.body])).toEqual([
			["POST", "/repos/vombor/notes/issues/3/comments", { body: "Won't do.\n\n— notes · user (Kanban)" }],
			["PATCH", "/repos/vombor/notes/issues/3", { state: "closed", state_reason: "not_planned" }],
		]);

		github.rateLimit = { status: 403, resetAt: NOW + 120_000 };
		const limited = await api.issue({
			caller: { kind: "user" },
			workspaceId: "notes",
			workspacePath: "/projects/notes",
			request: { action: "comment", repo: "vombor/notes", number: 3, body: "x" },
		});
		expect(limited.ok).toBe(false);
		expect(limited.error).toContain("rate limit");
		expect(limited.retryAfter).toBe(new Date(NOW + 120_000).toISOString());
	});

	it("starts the app creation only for the user", async () => {
		const api = createApi();
		const refused = await api.startAppCreation({
			caller: session("notes", "orchestrator"),
			request: { name: "Kanban agents", origin: "http://localhost:3485" },
		});
		expect(refused.ok).toBe(false);
		expect(refused.error).toContain("the user's");
		const started = await api.startAppCreation({
			caller: { kind: "user" },
			request: { name: "Kanban agents", origin: "http://localhost:3485" },
		});
		expect(started.ok && started.startUrl).toContain(GITHUB_APP_START_PATH);
		expect(started.existing?.slug).toBe("kanban-agents");
	});
});

describe("doctor's GitHub App rows", () => {
	it("says there is no app, then which repositories the installation doesn't cover, and tightens the file mode", async () => {
		const settings = parsePipelineConfig({}).config.github;
		const entries = [
			{ workspaceId: "notes", repoPath: "/projects/notes" },
			{ workspaceId: "foo", repoPath: "/projects/pawsome" },
		];
		const remotes: Record<string, string> = {
			"/projects/notes": "https://github.com/vombor/notes.git",
			"/projects/pawsome": "git@github.com:vombor/pawsome.git",
		};
		const path = join(temp.path, "secrets", "github-app.json");
		const deps = (app: GitHubAppCredentials | null) => ({
			tokenSource: createGitHubAppTokenSource({ readCredentials: async () => app, fetch: github.fetch }),
			readModes: async () => await readGitHubAppFileModes(path),
			listRemotes: async (repoPath: string) => [{ name: "origin", url: remotes[repoPath] ?? "" }],
		});
		const none = await checkGitHubApp(settings, entries, deps(null));
		expect(none).toHaveLength(1);
		expect(none[0]?.message).toContain("no Kanban GitHub App");

		await writeGitHubAppCredentials(CREDENTIALS, path);
		await chmod(path, 0o644);
		github.app.installations.set("vombor/notes", 77);
		github.app.installations.set("vombor/kanban", 77);
		const findings = await checkGitHubApp(settings, entries, deps(CREDENTIALS));
		const modeRow = findings.find((finding) => finding.message.includes("readable by others"));
		expect(modeRow?.fix).toBeDefined();
		await modeRow?.fix?.();
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const coverage = findings.find((finding) => finding.message.includes("not installed on"));
		expect(coverage?.message).toContain("vombor/pawsome (foo)");
		expect(coverage?.message).not.toContain("vombor/notes");
		expect(coverage?.hint).toContain("https://github.com/apps/kanban-agents/installations/new");
		expect(JSON.stringify(findings)).not.toContain(KEY_BODY_LINE);
	});
});
