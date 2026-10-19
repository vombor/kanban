import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { flushCliOutput } from "../../src/core/cli-output";
import { createGitTestEnv } from "../utilities/git-env";

describe("CLI pipe output (#70)", () => {
	it("waits for every queued write, including stream backpressure", async () => {
		let output = "";
		const stream = new Writable({
			highWaterMark: 8,
			write(chunk, _encoding, done) {
				setImmediate(() => {
					output += chunk.toString();
					done();
				});
			},
		});
		const expected = JSON.stringify({ large: "owned-fixture".repeat(100000) });
		stream.write(expected);
		expect(await flushCliOutput([stream])).toBe(true);
		expect(output).toBe(expected);
	});
	it("reports broken output streams as unsuccessful instead of claiming full output", async () => {
		const stream = new Writable({
			write(_chunk, _encoding, done) {
				done(new Error("owned pipe failure"));
			},
		});
		expect(await flushCliOutput([stream])).toBe(false);
	});
	it("preserves large JSON byte-for-byte through a real slow pipe before forced exit", async () => {
		const helper = fileURLToPath(new URL("../../src/core/cli-output.ts", import.meta.url));
		const code = `import {flushCliOutput} from ${JSON.stringify(helper)};process.stdout.write(JSON.stringify({fixture:'owned-large-json',data:'🌱'.repeat(300000)}));process.exit(await flushCliOutput()?0:1);`;
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
			env: createGitTestEnv({ NODE_NO_WARNINGS: "1" }),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.stdout.on("data", (chunk) => {
			chunks.push(Buffer.from(chunk));
			child.stdout.pause();
			setTimeout(() => child.stdout.resume(), 1);
		});
		const status = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		expect(stderr).toBe("");
		expect(status).toBe(0);
		const text = Buffer.concat(chunks).toString("utf8");
		expect(Buffer.byteLength(text)).toBeGreaterThan(1048576);
		expect(JSON.parse(text)).toEqual({ fixture: "owned-large-json", data: "🌱".repeat(300000) });
	});
});
