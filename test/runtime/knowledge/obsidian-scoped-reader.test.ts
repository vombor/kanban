import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createScopedObsidianReader } from "../../../src/knowledge/obsidian/scoped-reader";

describe("optional vault GET transport", () => {
	it("uses only bounded vault GETs and refuses redirects, credential echoes and unsafe paths", async () => {
		const calls: Array<{ method: string | undefined; url: string | undefined; accept: string | undefined }> = [];
		const server = createServer((request, response) => {
			calls.push({ method: request.method, url: request.url, accept: request.headers.accept });
			expect(request.headers.authorization).toBe("Bearer fake-reader-credential");
			if (request.url === "/vault/Own/redirect.md") {
				response.writeHead(302, { Location: "/active/" });
				response.end();
				return;
			}
			response.setHeader("Content-Type", "application/json");
			if (request.url === "/vault/Own/") {
				response.end(JSON.stringify({ files: ["note.md"] }));
				return;
			}
			response.end(
				JSON.stringify({
					path: request.url === "/vault/Own/echo.md" ? "Own/echo.md" : "Own/note.md",
					content: request.url === "/vault/Own/echo.md" ? "fake-reader-credential" : "# Native note",
					links: [],
					backlinks: [],
					tags: [],
				}),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No owned port");
		const reader = createScopedObsidianReader({
			version: 1,
			revision: null,
			settings: { enabled: true, baseUrl: `http://127.0.0.1:${address.port}`, caCertificate: "" },
			apiKey: "fake-reader-credential",
		});
		try {
			expect(await reader.list("Own")).toEqual(["note.md"]);
			expect((await reader.read("Own/note.md")).content).toBe("# Native note");
			await expect(reader.read("Own/redirect.md")).rejects.toThrow();
			await expect(reader.read("Own/echo.md")).rejects.toThrow();
			await expect(reader.read("../active/")).rejects.toThrow();
			expect(calls.every((call) => call.method === "GET" && call.url?.startsWith("/vault/"))).toBe(true);
			expect(calls.find((call) => call.url === "/vault/Own/note.md")?.accept).toBe(
				"application/vnd.olrapi.note+json",
			);
		} finally {
			await reader.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
