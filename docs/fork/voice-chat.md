# Voice chat

The card agent's terminal (the card detail view) and the sidebar orchestrator have a voice bar under the terminal: talk
to the agent, and optionally hear its reply. It works for every agent, whether or not its CLI has a voice mode of its
own, because it uses only the browser's built-in Web Speech APIs. Kanban adds no speech model, server-side service,
dependency or secret for it. Shell terminals don't get the bar.

## Speech in

- The mic button starts listening (`SpeechRecognition`, or Chrome's and Safari's `webkitSpeechRecognition`). Tap
  it again to stop. With a mouse you can also hold it down and talk: releasing a press held 0.4 s or longer stops.
  On touch it is always tap to start, tap to stop.
- While you talk, the preview above the button shows the live transcript, including the words the recognizer hasn't
  settled on yet. When listening stops, only the final text stays, and you can edit it. Recording again appends to
  it.
- Send (or Enter in the preview) delivers the text like typed input: `runtime.deliverTaskInput` types it into the
  agent's TUI, presses Enter and confirms the agent picked it up (`src/terminal/deliver-task-input.ts`). Shift+Enter
  is a line break, Escape or the X discards. Interim results never reach the PTY, and nothing is sent until you press
  Send.
- Starting to talk stops a reply that is being read out.

## Speech out

The speaker toggle reads the agent's reply aloud (`speechSynthesis`) when its turn ends. It is off by default and
remembered per session in localStorage (`kanban.voice-chat.speak-replies:<task id>`), so the orchestrator and each
card keep their own setting.

- The text is the turn's final message from the session summary, read through `readTurnFinalMessage()`
  (`src/core/turn-final-message.ts`, the same reader the orchestrator wait's question check uses): only when the
  session is in Review because of a hook and the latest hook is a turn end. A final message left over under a later
  hook is not read. The PTY output is never read.
- Code blocks are replaced by "code block"; markdown markup, URLs and table pipes are dropped; a long reply is cut
  after about 1200 characters with "The rest is in the terminal." (`web-ui/src/voice/speakable-text.ts`).
- Only turns that end while the panel is open are read, and a turn end has to hold for 1.5 s first (some agents
  flip to Review for a moment mid-turn). The stop button, turning the toggle off, talking, or closing the panel ends
  the reading.

## Browser support

The bar is shown only where the browser has the API. The mic and the speaker are detected separately, and where
neither exists the bar is hidden.

| Browser | Speech in | Speech out |
| --- | --- | --- |
| Chrome, Edge (desktop and Android) | yes | yes |
| Safari (macOS, iOS) | yes | yes |
| Firefox | no (no `SpeechRecognition`) | yes |

The microphone needs a secure context: `https://` or `localhost`. Over plain `http://` to a remote host, the browser
refuses the mic and the bar shows "Microphone access was denied."

**Privacy:** Chrome's (and Edge's) speech recognition is not on-device. The browser sends the audio to Google's (or
Microsoft's) speech service and gets the text back. Safari may use Apple's servers too, depending on the device.
Kanban never sees the audio, only the text you send. Speech out uses the system's voices. Don't use the mic for
anything you wouldn't send to that service.

## Code

- `web-ui/src/voice/speech-apis.ts`: feature detection and the final/interim split of a result list.
- `web-ui/src/voice/use-speech-recognition.ts`, `use-voice-input.ts`, `send-voice-input.ts`: speech in.
- `web-ui/src/voice/use-reply-speech.ts`, `speakable-text.ts`: speech out.
- `web-ui/src/components/detail-panels/voice-chat-bar.tsx`: the bar, shown by `AgentTerminalPanel`'s `voiceChat`
  prop.
