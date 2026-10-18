import { afterEach, describe, expect, it, vi } from "vitest";
import { receiptRequestId } from "@/utils/receipt-request-id";

afterEach(() => vi.unstubAllGlobals());
describe("receipt identities on HTTP installations", () => {
	it("uses native randomUUID when available", () => {
		vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
		expect(receiptRequestId()).toBe("00000000-0000-4000-8000-000000000001");
	});
	it("formats cryptographic getRandomValues as a version-4 UUID without requiring a secure-context-only API", () => {
		vi.stubGlobal("crypto", {
			getRandomValues: (bytes: Uint8Array) => {
				bytes.fill(255);
				return bytes;
			},
		});
		expect(receiptRequestId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
	});
	it("does not silently replace missing randomness with a weak or non-UUID receipt identity", () => {
		vi.stubGlobal("crypto", undefined);
		expect(() => receiptRequestId()).toThrow("cryptographic randomness");
	});
});
