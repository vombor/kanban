import { Square, Volume2, VolumeX } from "lucide-react";
import type { ReactElement } from "react";

import { VoiceError, VoiceMicButton, VoicePreview, VoiceStatus } from "@/components/detail-panels/voice-chat-controls";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useVoiceChat } from "@/voice/use-voice-chat";

export interface VoiceChatBarProps {
	taskId: string;
	workspaceId: string | null;
	summary: RuntimeTaskSessionSummary | null;
}

/**
 * Voice chat for an agent session, built on the browser's Web Speech APIs only (docs/fork/voice-chat.md): a mic that
 * fills an editable preview and sends its final text like typed input, and a per-session toggle that reads the
 * agent's reply aloud when its turn ends. Renders nothing where the browser has neither API. Desktop only: on a phone
 * the same controls sit in the touch bar's row (terminal-touch-bar.tsx).
 */
export function VoiceChatBar({ taskId, workspaceId, summary }: VoiceChatBarProps): ReactElement | null {
	const voice = useVoiceChat(workspaceId, taskId, summary);
	const { voiceInput, replySpeech } = voice;

	if (!voice.supported) {
		return null;
	}

	return (
		<div className="flex flex-col gap-2 border-t border-border px-2 py-2">
			<VoicePreview voice={voice} showSend />
			<VoiceError voice={voice} />
			<div className="flex items-center gap-2">
				{voiceInput.supported ? <VoiceMicButton voice={voice} /> : null}
				<VoiceStatus voice={voice} />
				{replySpeech.supported && replySpeech.speaking ? (
					<Button
						variant="ghost"
						size="md"
						icon={<Square size={14} />}
						aria-label="Stop reading the reply"
						onClick={replySpeech.stop}
					/>
				) : null}
				{replySpeech.supported ? (
					<Tooltip side="top" content={replySpeech.enabled ? "Stop reading replies aloud" : "Read replies aloud"}>
						<Button
							variant="ghost"
							size="md"
							icon={replySpeech.enabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
							aria-label="Read replies aloud"
							aria-pressed={replySpeech.enabled}
							className={cn(replySpeech.enabled && "text-accent")}
							onClick={() => replySpeech.setEnabled(!replySpeech.enabled)}
						/>
					</Tooltip>
				) : null}
			</div>
		</div>
	);
}
