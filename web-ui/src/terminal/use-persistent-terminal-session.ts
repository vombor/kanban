import type { MutableRefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getTerminalThemeColors, useTheme } from "@/hooks/use-theme";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { disposePersistentTerminal, ensurePersistentTerminal } from "@/terminal/persistent-terminal-manager";
import { registerTerminalController } from "@/terminal/terminal-controller-registry";
import type { TerminalReadiness } from "@/terminal/terminal-readiness";
import type { TerminalConnectionStatus } from "@/terminal/terminal-reconnect-controller";

interface UsePersistentTerminalSessionInput {
	taskId: string;
	workspaceId: string | null;
	enabled?: boolean;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onConnectionReady?: (taskId: string) => void;
	autoFocus?: boolean;
	isVisible?: boolean;
	// The panel starts the session itself when it has none (the sidebar agent).
	expectsSessionStart?: boolean;
	sessionStartedAt?: number | null;
	terminalBackgroundColor: string;
	cursorColor: string;
}

export interface UsePersistentTerminalSessionResult {
	containerRef: MutableRefObject<HTMLDivElement | null>;
	lastError: string | null;
	connectionStatus: TerminalConnectionStatus | null;
	// Null while no terminal is attached (disabled, or no project).
	readiness: TerminalReadiness | null;
	isStopping: boolean;
	// The viewport is above the newest output (normal buffer only).
	isScrolledUp: boolean;
	clearTerminal: () => void;
	scrollToBottom: () => void;
	stopTerminal: () => Promise<void>;
	retryConnection: () => void;
}

export function usePersistentTerminalSession({
	taskId,
	workspaceId,
	enabled = true,
	onSummary,
	onConnectionReady,
	autoFocus = false,
	isVisible = true,
	expectsSessionStart = false,
	sessionStartedAt = null,
	terminalBackgroundColor,
	cursorColor,
}: UsePersistentTerminalSessionInput): UsePersistentTerminalSessionResult {
	const { themeId } = useTheme();
	const themeColors = useMemo(() => getTerminalThemeColors(themeId), [themeId]);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const terminalRef = useRef<ReturnType<typeof ensurePersistentTerminal> | null>(null);
	const callbackRef = useRef<{
		onSummary?: (summary: RuntimeTaskSessionSummary) => void;
		onConnectionReady?: (taskId: string) => void;
	}>({
		onSummary,
		onConnectionReady,
	});
	const previousSessionRef = useRef<{
		workspaceId: string;
		taskId: string;
		sessionStartedAt: number | null;
	} | null>(null);
	const [lastError, setLastError] = useState<string | null>(null);
	const [connectionStatus, setConnectionStatus] = useState<TerminalConnectionStatus | null>(null);
	const [readiness, setReadiness] = useState<TerminalReadiness | null>(null);
	const [isStopping, setIsStopping] = useState(false);
	const [isScrolledUp, setIsScrolledUp] = useState(false);
	callbackRef.current = {
		onSummary,
		onConnectionReady,
	};

	useEffect(() => {
		if (!enabled) {
			const previousSession = previousSessionRef.current;
			if (previousSession) {
				disposePersistentTerminal(previousSession.workspaceId, previousSession.taskId);
			}
			terminalRef.current?.unmount(containerRef.current);
			terminalRef.current = null;
			previousSessionRef.current = null;
			setLastError(null);
			setConnectionStatus(null);
			setReadiness(null);
			setIsScrolledUp(false);
			setIsStopping(false);
			return;
		}

		if (!workspaceId) {
			const previousSession = previousSessionRef.current;
			if (previousSession) {
				disposePersistentTerminal(previousSession.workspaceId, previousSession.taskId);
			}
			terminalRef.current?.unmount(containerRef.current);
			terminalRef.current = null;
			previousSessionRef.current = null;
			setLastError("No project selected.");
			setConnectionStatus(null);
			setReadiness(null);
			setIsScrolledUp(false);
			return;
		}
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const previousSession = previousSessionRef.current;
		const didSessionRestart =
			previousSession !== null &&
			previousSession.workspaceId === workspaceId &&
			previousSession.taskId === taskId &&
			previousSession.sessionStartedAt !== sessionStartedAt;

		const terminal = ensurePersistentTerminal({
			taskId,
			workspaceId,
			cursorColor,
			terminalBackgroundColor,
			themeColors,
		});
		if (didSessionRestart) {
			terminal.reset();
		}
		previousSessionRef.current = {
			workspaceId,
			taskId,
			sessionStartedAt,
		};
		terminalRef.current = terminal;
		const unsubscribe = terminal.subscribe({
			onConnectionReady: (connectedTaskId) => {
				callbackRef.current.onConnectionReady?.(connectedTaskId);
			},
			onConnectionStatus: setConnectionStatus,
			onLastError: setLastError,
			onReadiness: setReadiness,
			onScrolledUp: setIsScrolledUp,
			onSummary: (summary) => {
				callbackRef.current.onSummary?.(summary);
			},
		});
		terminal.mount(
			container,
			{
				cursorColor,
				terminalBackgroundColor,
				themeColors,
			},
			{
				autoFocus,
				isVisible,
				expectsSessionStart,
			},
		);
		setLastError(null);
		setIsStopping(false);
		return () => {
			unsubscribe();
			terminal.unmount(container);
			if (terminalRef.current === terminal) {
				terminalRef.current = null;
			}
		};
	}, [
		autoFocus,
		cursorColor,
		enabled,
		expectsSessionStart,
		isVisible,
		sessionStartedAt,
		taskId,
		terminalBackgroundColor,
		themeColors,
		workspaceId,
	]);

	useEffect(() => {
		return registerTerminalController(taskId, {
			input: (text) => terminalRef.current?.input(text) ?? false,
			paste: (text) => terminalRef.current?.paste(text) ?? false,
			waitForLikelyPrompt: async (timeoutMs) => await (terminalRef.current?.waitForLikelyPrompt(timeoutMs) ?? false),
		});
	}, [taskId]);

	const stopTerminal = useCallback(async () => {
		const terminal = terminalRef.current;
		if (!terminal) {
			return;
		}
		setIsStopping(true);
		try {
			await terminal.stop();
		} catch {
			// Keep terminal usable even if stop API fails.
		} finally {
			setIsStopping(false);
		}
	}, []);

	const clearTerminal = useCallback(() => {
		terminalRef.current?.clear();
	}, []);

	const scrollToBottom = useCallback(() => {
		terminalRef.current?.scrollToBottom();
	}, []);

	const retryConnection = useCallback(() => {
		terminalRef.current?.retryConnection();
	}, []);

	return {
		containerRef,
		lastError,
		connectionStatus,
		readiness,
		isStopping,
		isScrolledUp,
		clearTerminal,
		scrollToBottom,
		stopTerminal,
		retryConnection,
	};
}
