import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTempDir } from "../../utilities/temp-dir";

const SCRIPT = resolve(__dirname, "../../../deploy/patch-cline-bedrock-cache.mjs");

// The Bedrock cache-point helpers as minified in cline 3.0.69 (@cline/llms 0.0.91): dist/providers.js names, and the
// second copy in the Bun binary bin/.cline (other names and parameter letters).
const B5 =
	'function b5(e,t){let i=t.provider.metadata?.routing?.promptCache;if(i?.format!=="bedrock-cache-point")return;return i.routes.find((a)=>ve(a,{modelId:e.modelId,family:pe(t),capabilities:t.model.capabilities}))}';
const UPSTREAM_JS = `${B5}function Jp(e,t){return b5(e,t)!==void 0}function W5(){return{bedrock:{cachePoint:{type:"default"}}}}function ec(e){for(let t=e.length-1;t>=0;t--){let i=e[t];if(i?.role!=="user")continue;i.providerOptions={...i.providerOptions,...W5()};return}}`;
const PLACEMENT_ONLY_JS = UPSTREAM_JS.replace('if(i?.role!=="user")continue;', 'if(i.role[0]=="a")continue;  ');
const UPSTREAM_BIN =
	'function W2e(i,o){let m=o.provider.metadata?.routing?.promptCache;if(m?.format!=="bedrock-cache-point")return;return m.routes.find((f)=>zs(f,{modelId:i.modelId,family:ga(o),capabilities:o.model.capabilities}))}function P2e(i,o){return W2e(i,o)!==void 0}function C2e(){return{bedrock:{cachePoint:{type:"default"}}}}function O2e(i){for(let o=i.length-1;o>=0;o--){let m=i[o];if(m?.role!=="user")continue;m.providerOptions={...m.providerOptions,...C2e()};return}}';
const CALL_SITE = "var vo=1;function nw(e,t,i){let a=hw(e.messages);if(Jp(e,t))return ec(a),a;return a}";

let tempDir: { path: string; cleanup: () => void };

beforeEach(() => {
	tempDir = createTempDir("patch-cline-bedrock-cache-");
});

afterEach(() => {
	tempDir.cleanup();
});

function runPatch(args: string[]) {
	const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeFixture(name: string, content: string | Buffer): string {
	const path = join(tempDir.path, name);
	writeFileSync(path, content);
	return path;
}

interface Message {
	role: string;
	providerOptions?: { bedrock?: { cachePoint?: { type: string } } };
}

/** Runs the (patched) helpers the way cline's request builder does: `if(Jp(e,t))return ec(a),a;`. */
function placeCachePoint(helpers: string, family: string | undefined, modelId: string, roles: string[]): number[] {
	const pe = (t: { model: { metadata?: { family?: string } } }) => t.model.metadata?.family;
	// stands in for cline's route matcher: the Bedrock route is {matcher:"anthropic-compatible"}
	const ve = (_route: unknown, info: { modelId: string }) => /claude|anthropic/.test(info.modelId);
	const { Jp, ec } = new Function("pe", "ve", `${helpers};return {Jp,ec};`)(pe, ve) as {
		Jp: (e: unknown, t: unknown) => boolean;
		ec: (messages: Message[]) => void;
	};
	const messages: Message[] = roles.map((role) => ({ role }));
	const request = { modelId };
	const provider = {
		provider: {
			metadata: {
				routing: { promptCache: { format: "bedrock-cache-point", routes: [{ matcher: "anthropic-compatible" }] } },
			},
		},
		model: { metadata: { family }, capabilities: ["prompt-cache"] },
	};
	if (Jp(request, provider)) {
		ec(messages);
	}
	return messages.flatMap((message, index) => (message.providerOptions?.bedrock?.cachePoint ? [index] : []));
}

describe("patch-cline-bedrock-cache", () => {
	it("widens the route to Nova and fixes the placement, keeping the length", () => {
		const file = writeFixture("providers.js", `${UPSTREAM_JS}${CALL_SITE}`);
		const result = runPatch([file]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("route+placement 1 to patch, 0 already patched");
		const patched = readFileSync(file, "utf8");
		expect(patched.length).toBe(UPSTREAM_JS.length + CALL_SITE.length);
		expect(patched.endsWith(CALL_SITE)).toBe(true);
		expect(patched.startsWith(B5)).toBe(true);
		expect(patched).toContain('function Jp(e,t){return(ec.n=pe(t)=="nova")||b5(e,t)!==void 0}');
	});

	it("puts the checkpoint on the last non-assistant message for Anthropic and the last user message for Nova", () => {
		const file = writeFixture("providers.js", UPSTREAM_JS);
		expect(runPatch([file]).status).toBe(0);
		const helpers = readFileSync(file, "utf8");
		const agentLoop = ["user", "assistant", "tool", "assistant", "tool"];

		expect(placeCachePoint(helpers, undefined, "us.anthropic.claude-opus-5-5", agentLoop)).toEqual([4]);
		// Nova rejects a cachePoint after a toolResult or a toolUse: only user (text) messages carry it
		expect(placeCachePoint(helpers, "nova", "us.amazon.nova-2-lite-v1:0", agentLoop)).toEqual([0]);
		expect(placeCachePoint(helpers, "nova", "us.amazon.nova-2-lite-v1:0", [...agentLoop, "user"])).toEqual([5]);
		// models whose Converse API rejects a cachePoint stay off the route
		expect(placeCachePoint(helpers, "qwen", "qwen.qwen3-vl-235b-a22b", agentLoop)).toEqual([]);
		expect(placeCachePoint(helpers, "mistral-large", "mistral.mistral-large-3-675b-instruct", agentLoop)).toEqual([]);
		expect(placeCachePoint(helpers, undefined, "deepseek.v3-v1:0", agentLoop)).toEqual([]);
		// Nova 1 families are not verified yet
		expect(placeCachePoint(helpers, "nova-pro", "us.amazon.nova-pro-v1:0", agentLoop)).toEqual([]);
	});

	it("the unpatched helpers keep the checkpoint on the first prompt (the bug the patch fixes)", () => {
		const agentLoop = ["user", "assistant", "tool", "assistant", "tool"];
		expect(placeCachePoint(UPSTREAM_JS, undefined, "us.anthropic.claude-opus-5-5", agentLoop)).toEqual([0]);
		expect(placeCachePoint(UPSTREAM_JS, "nova", "us.amazon.nova-2-lite-v1:0", agentLoop)).toEqual([]);
	});

	it("upgrades a file that only has the earlier placement fix", () => {
		const file = writeFixture("providers.js", PLACEMENT_ONLY_JS);
		const result = runPatch([file]);
		expect(result.status).toBe(0);
		const patched = readFileSync(file, "utf8");
		expect(patched.length).toBe(PLACEMENT_ONLY_JS.length);
		expect(placeCachePoint(patched, "nova", "us.amazon.nova-2-lite-v1:0", ["user", "assistant", "tool"])).toEqual([
			0,
		]);
		expect(placeCachePoint(patched, undefined, "anthropic.claude-haiku-4-5", ["user", "assistant", "tool"])).toEqual([
			2,
		]);
	});

	it("patches every copy in a binary byte for byte, outside the helpers too", () => {
		const prefix = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0xc3, 0x28, 0x00]);
		const binary = Buffer.concat([
			prefix,
			Buffer.from(UPSTREAM_BIN, "latin1"),
			prefix,
			Buffer.from(UPSTREAM_JS),
			prefix,
		]);
		const file = writeFixture("cline-bin", binary);
		const result = runPatch([file]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("route+placement 2 to patch");
		const patched = readFileSync(file);
		expect(patched.length).toBe(binary.length);
		expect(patched.subarray(0, prefix.length).equals(prefix)).toBe(true);
		expect(patched.subarray(patched.length - prefix.length).equals(prefix)).toBe(true);
		const text = patched.toString("latin1");
		expect(text).toContain('function P2e(i,o){return(O2e.n=ga(o)=="nova")||W2e(i,o)!==void 0}');
		// the new placement's locals don't reuse a name it calls
		expect(text).toContain('function O2e(m){let i=m.findLast((x)=>x.role>=(O2e.n?"u":"b"));');
	});

	it("is idempotent", () => {
		const file = writeFixture("providers.js", UPSTREAM_JS);
		expect(runPatch([file]).status).toBe(0);
		const once = readFileSync(file, "utf8");
		const again = runPatch([file]);
		expect(again.status).toBe(0);
		expect(again.stdout).toContain("route+placement 0 to patch, 1 already patched");
		expect(readFileSync(file, "utf8")).toBe(once);
	});

	it("--check reports without writing", () => {
		const file = writeFixture("providers.js", UPSTREAM_JS);
		const result = runPatch([file, "--check"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("route+placement 1 to patch");
		expect(readFileSync(file, "utf8")).toBe(UPSTREAM_JS);
	});

	it("falls back to the placement fix alone with a WARNING when the route helpers moved", () => {
		const moved = UPSTREAM_JS.replace("function W5()", "var zz=1;function W5()");
		const file = writeFixture("providers.js", moved);
		const result = runPatch([file]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("WARNING");
		expect(result.stderr).toContain("Nova prompt caching NOT enabled");
		const patched = readFileSync(file, "utf8");
		expect(patched.length).toBe(moved.length);
		expect(patched).toContain('if(i.role[0]=="a")continue;  i.providerOptions=');
	});

	it("warns and leaves a file alone when no cache-point code is found", () => {
		const file = writeFixture("providers.js", "function unrelated(){return 1}");
		const result = runPatch([file]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("WARNING");
		expect(readFileSync(file, "utf8")).toBe("function unrelated(){return 1}");
	});
});
