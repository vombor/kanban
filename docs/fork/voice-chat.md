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
- "Listening…" is shown only between the recognizer's own `start` and `end` events ("Starting…" before the browser
  has started it). An error ends listening with its message, including "No speech was heard" and "was interrupted"
  (those two stay quiet after your own stop). A session that doesn't start within 15 s, or doesn't end within 3 s of
  a stop, is aborted with a message, so the bar never says it listens while nothing does.
- Discarding (X, Escape) clears only the text: while listening, the mic keeps listening and what you say next fills
  the empty preview (the recognizer's results from before the clear are skipped by index, the words being said at
  that moment included). Closing the bar, or switching it to another session, aborts the recognition, but the
  browser ends a session (and lets go of the mic) a moment later, and a phone's recognizer serves one session at a
  time. So the page keeps one live session until its `end` (`web-ui/src/voice/live-recognition.ts`), and the next
  start waits for that (at most 2 s, then it aborts the old one again and starts anyway). Before this, recording
  again after a discard showed "Listening…" with no speech recognised until the page was reloaded (phone reports,
  2026-10-12): a discard used to abort too, and a tap on the mic right after it started a session while the
  aborted one was still ending.

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

## On a phone

On a touch screen every terminal panel (card agent, sidebar orchestrator, shell terminals) has a touch bar between the
terminal and the voice bar, in the panel, so it never covers the TUI and moves above the on-screen keyboard with the
panel. It holds the key pad toggle and, while you are scrolled up, Jump to bottom. The toggle opens a second row
with the keys a phone keyboard lacks for an agent's pickers: Esc, Shift+Tab, Tab, Space and the arrows (held arrows
repeat, arrows follow the TUI's cursor-key mode). There is no Enter button: use the voice bar's Send or the
keyboard's Enter (user request, 2026-10-12). No button takes the keyboard's focus, so dictation keeps going.

## Code

- `web-ui/src/voice/speech-apis.ts`: feature detection and the final/interim split of a result list.
- `web-ui/src/voice/use-speech-recognition.ts`, `live-recognition.ts`, `use-voice-input.ts`, `send-voice-input.ts`:
  speech in.
- `web-ui/src/voice/use-reply-speech.ts`, `speakable-text.ts`: speech out.
- `web-ui/src/components/detail-panels/voice-chat-bar.tsx`: the bar, shown by `AgentTerminalPanel`'s `voiceChat`
  prop.
- `web-ui/src/components/detail-panels/terminal-touch-bar.tsx`: the touch bar; its keys go through
  `web-ui/src/terminal/terminal-ime-input.ts` like the keyboard's.
