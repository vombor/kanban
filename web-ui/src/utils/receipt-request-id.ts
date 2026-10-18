/** Modern HTTP installations expose getRandomValues but not randomUUID. Receipt ids must stay RFC UUIDs. */
export function receiptRequestId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
	if (typeof globalThis.crypto?.getRandomValues !== "function")
		throw new Error("Browser cryptographic randomness is unavailable; no mutation identity was generated.");
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
	bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
