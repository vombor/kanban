import { useEffect, useRef, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	ObsidianConnectorProbe,
	ObsidianConnectorSettings,
	ObsidianConnectorView,
	ObsidianConnectorWrite,
} from "@/runtime/types";
import { useUnmount } from "@/utils/react-use";

const EMPTY_SETTINGS: ObsidianConnectorSettings = { enabled: false, baseUrl: "", caCertificate: "" };

/** Private key draft lives only while the settings section is open, and is never filled from the server. */
export function useObsidianConnector(active: boolean) {
	const [settings, setSettings] = useState<ObsidianConnectorSettings>(EMPTY_SETTINGS);
	const [view, setView] = useState<ObsidianConnectorView | null>(null);
	const [key, setKey] = useState("");
	const [removeKey, setRemoveKey] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [probe, setProbe] = useState<ObsidianConnectorProbe | null>(null);
	const generation = useRef(0);
	useUnmount(() => {
		generation.current += 1;
	});
	useEffect(() => {
		const id = ++generation.current;
		setKey("");
		setRemoveKey(false);
		setProbe(null);
		setError(null);
		setNotice(null);
		setView(null);
		setSettings(EMPTY_SETTINGS);
		setBusy(active);
		if (active) {
			void getRuntimeTrpcClient(null)
				.obsidianConnector.get.query()
				.then((response) => {
					if (id !== generation.current) return;
					setView(response);
					setSettings(response.settings);
				})
				.catch(() => {
					if (id === generation.current) setError("Could not load Obsidian connector settings.");
				})
				.finally(() => {
					if (id === generation.current) setBusy(false);
				});
		}
	}, [active]);
	const update = (next: Partial<ObsidianConnectorSettings>) => {
		setSettings((current) => ({ ...current, ...next }));
		setNotice(null);
		setProbe(null);
	};
	const run = async (action: "save" | "test") => {
		if (!view || busy || !active) return;
		const id = generation.current;
		const input: ObsidianConnectorWrite = {
			settings,
			expectedRevision: view.revision,
			...(removeKey ? { apiKey: null } : key ? { apiKey: key } : {}),
		};
		setBusy(true);
		setError(null);
		setNotice(null);
		setProbe(null);
		try {
			const client = getRuntimeTrpcClient(null).obsidianConnector;
			if (action === "save") {
				const response = await client.save.mutate(input);
				if (id !== generation.current) return;
				setView(response);
				setSettings(response.settings);
				setKey("");
				setRemoveKey(false);
				setNotice("Obsidian connector settings saved.");
			} else {
				const result = await client.test.mutate(input);
				if (id === generation.current) setProbe(result);
			}
		} catch {
			if (id === generation.current)
				setError(
					"Could not finish. Check the endpoint/key or reopen this section if settings changed in another window.",
				);
		} finally {
			if (id === generation.current) setBusy(false);
		}
	};
	return {
		settings,
		update,
		key,
		setKey: (value: string) => {
			setKey(value);
			setProbe(null);
			setNotice(null);
		},
		removeKey,
		setRemoveKey,
		busy,
		error,
		notice,
		probe,
		configured: view?.apiKeyConfigured ?? false,
		loaded: view !== null,
		save: () => run("save"),
		test: () => run("test"),
	};
}
