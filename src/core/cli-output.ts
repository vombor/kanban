import type { Writable } from "node:stream";

/** A forced CLI exit must wait for queued pipe writes; telemetry flushes do not drain stdout/stderr. */
function flushStream(stream: Writable): Promise<void> {
	return new Promise((resolve, reject) => {
		let error: Error | null = null;
		const onError = (value: Error) => {
			error = value;
		};
		stream.on("error", onError);
		try {
			stream.write("", (failure?: Error | null) => {
				// Node may emit the write error after invoking its callback. Keep the listener for that turn.
				setImmediate(() => {
					stream.off("error", onError);
					if (failure || error) reject(failure ?? error);
					else resolve();
				});
			});
		} catch (failure) {
			stream.off("error", onError);
			reject(failure);
		}
	});
}
export async function flushCliOutput(
	streams: readonly Writable[] = [process.stdout, process.stderr],
): Promise<boolean> {
	const results = await Promise.allSettled(streams.map(flushStream));
	return results.every((result) => result.status === "fulfilled");
}
