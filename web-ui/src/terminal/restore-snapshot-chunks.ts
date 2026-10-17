/** xterm parse budget for restore writes, not a second scrollback cap. */
export const RESTORE_WRITE_CHUNK_BYTES = 16 * 1024;

export function* iterateRestoreSnapshot(
	snapshot: string,
	chunkBytes: number = RESTORE_WRITE_CHUNK_BYTES,
): Generator<string> {
	if (!Number.isFinite(chunkBytes) || chunkBytes < 4)
		throw new Error("Terminal write chunks must hold at least one UTF-8 code point");
	if (snapshot.length === 0) {
		return;
	}

	let start = 0;
	let usedBytes = 0;
	let index = 0;

	while (index < snapshot.length) {
		const codePoint = snapshot.codePointAt(index);
		if (codePoint === undefined) {
			break;
		}
		const charBytes = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
		if (usedBytes > 0 && usedBytes + charBytes > chunkBytes) {
			yield snapshot.slice(start, index);
			start = index;
			usedBytes = 0;
		}
		usedBytes += charBytes;
		index += codePoint > 0xffff ? 2 : 1;
	}

	if (start < snapshot.length) {
		yield snapshot.slice(start);
	}
}

export function splitRestoreSnapshot(snapshot: string, chunkBytes: number = RESTORE_WRITE_CHUNK_BYTES): string[] {
	return [...iterateRestoreSnapshot(snapshot, chunkBytes)];
}
