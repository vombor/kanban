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
  is a line break, Escape or the X discards. Nothing is sent until you press Send.
- Send while the mic is on stops listening, waits for the final text of what you were saying (at most 1.5 s,
  `SEND_FINAL_WAIT_MS`) and sends it, with the spinner meanwhile. If the final text doesn't come in time it sends
  what the preview shows, the words not yet final included (the one case where interim text is sent), and drops the
  session. With nothing heard it only stops listening (and sends what an earlier recording left in the preview).
- Starting to talk stops a reply that is being read out, before the microphone opens: the synthesizer is cancelled
  whenever it still speaks, even without a reply of ours (the silent primer, or a reply whose `end` never came),
  since on iOS a speaking synthesizer can keep the audio session from the microphone.
- "Listening…" is shown only once the microphone delivers audio: the recognizer's `audiostart` event (or its first
  result, for a browser without that event), until its `end`. Before that the bar says "Starting…". The browser's
  `start` event only means the recognizer is set up: Safari sends `start` and then nothing at all when its
  capture gets no audio, which used to read "Listening…" with nothing ever heard. A session whose microphone hasn't
  delivered audio 4 s after `start` (`RECOGNITION_AUDIO_TIMEOUT_MS`) is aborted with "The microphone didn't open,
  so nothing was heard. Tap the mic to try again." An error ends listening with its message, including "No speech
  was heard" and "was interrupted" (those two stay quiet after your own stop). A session that doesn't start within
  15 s (room for the first permission prompts), or doesn't end within 3 s of a stop, is aborted with a message, so
  the bar never says it listens while nothing does.
- On desktop, discarding (X, Escape) clears only the text: while listening, the mic keeps listening and what you say
  next fills the empty preview (the recognizer's results from before the clear are skipped by index, the words being
  said at that moment included). On a phone the X also stops the mic (see "On a phone"). Closing the bar, or
  switching it to another session, aborts the recognition. The page keeps its live session until its `end`
  (`web-ui/src/voice/live-recognition.ts`) so a reopened bar can abort it too.
- Every start runs inside the mic's tap: a new `SpeechRecognition` instance, `start()` called at once. It never
  waits for an old session to end. Both engines end the previous session themselves when a new one starts (see
  below), and the earlier 2 s wait for that end (35818fdd) ran the start from a timer, outside the tap, whenever the
  old session's `end` was late.

## Speech out

The speaker toggle reads the agent's reply aloud (`speechSynthesis`) when its turn ends. It is off by default and
remembered per session in localStorage (`kanban.voice-chat.speak-replies:<task id>`), so the orchestrator and each
card keep their own setting.

- The text is the turn's final message from the session summary, read through `readTurnFinalMessage()`
  (`src/core/turn-final-message.ts`, the same reader the orchestrator wait's question check uses): the summary's
  `lastTurnEnd`, the final message of the `to_review` hook that ended the turn,
  only while the session is in Review because of a hook. It survives later hooks of the same Review (Claude Code's
  idle Notification right after Stop replaced the newest event name, so nothing was read until 2026-10-12) and is
  cleared on every state change, so a final message of an older turn is never read. The PTY output is never read.
- Code blocks are replaced by "code block"; markdown markup, URLs and table pipes are dropped; a long reply is cut
  after about 1200 characters with "The rest is in the terminal." (`web-ui/src/voice/speakable-text.ts`).
- Only turns that end while the panel is open are read, each once (keyed by when the turn ended, so the same text in
  a later turn is read again), and a turn end has to hold for 1.5 s first (some agents flip to Review for a moment
  mid-turn). The stop button (on a phone, a tap on the speaker while it reads), turning the toggle off, talking, or
  closing the panel ends the reading.
- Turning the speaker on speaks a silent, empty utterance from that click: some browsers (Safari, some Android
  Chrome builds) speak only after a `speak()` from a user gesture. A speaker left on from an earlier visit has no
  such click; on those browsers turn it off and on once. Each reply also calls `speechSynthesis.resume()` first,
  since Chrome can leave the synthesizer paused after the tab was in the background.

## Engine behaviour this relies on

Checked in the engines' sources (2026-10-12), not in the test fake, which twice didn't match the user's phone:

- **Both:** a new session's start ends the previous one. Chromium's `SpeechRecognitionManagerImpl::StartSession`
  aborts any other microphone session; WebKit's `SpeechRecognitionServer::handleRequest` aborts its recognizer
  with "Another request is started". `start()` has no user-gesture check in either (Blink only for on-device
  models being downloaded). A start inside the tap is kept anyway, since iOS ties audio to user interaction.
- **iOS Safari (WebKit):** `start` is sent when the recognizer is set up, before the capture runs; `audiostart`
  comes from the capture source once it delivers audio. A capture that delivers nothing sends no event at all, a
  muted source sends `audio-capture` with the message "Source is muted". Error events carry a `message`, which the
  log records. `stop()` finishes the SFSpeech task, and `end` follows the final result.
- **Chrome Android:** `abort()` cancels and destroys Android's recognizer at once and sends `end`; `stop()` ends
  once Android delivers its results. A busy recognizer (`ERROR_RECOGNIZER_BUSY`) is reported as `not-allowed`,
  which reads "Microphone access was denied". In continuous mode Chrome marks every partial result final, so a long
  utterance can show its words more than once (known, not handled yet; nothing reported).

What is still unverified on the real phone, and what the diagnostic log shows for it:

- that the second session gets `audiostart` after a reply was read aloud (look for `speech speak()`, `speech
  cancel()` and then the session's `start` without `audiostart`, ending in "gave up");
- that `end` comes after `stop()` (a `stop()` line with no `end` before the next `start()`);
- which error iOS sends when the microphone is taken (`error audio-capture: …` with its message).

## Diagnostic log

The voice chat records what the browser's recognizer and synthesizer do: each session's `start()`, `start`,
`audiostart`, `soundstart`, `speechstart`, `result` (count, final count, last text), `speechend`, `soundend`,
`audioend`, `nomatch`, `error` (code and message), `end`, Kanban's own `stop()`, `abort()` and "gave up", reply
speech's `speak()`, `cancel()` and its `end`/`error`, and once per page whether it runs as a home-screen web app
and the browser's user agent. Times are UTC, and `#n` is the session's number on the page.

It records always (the last 120 entries, in memory only: nothing leaves the page) and is shown only on demand, so
after a failure it already holds what happened:

- **On a phone:** hold the mic for 1 s. The press starts listening as any tap does (that session shows in the log
  too); tap the mic again to stop. Hold it again, or the X in the log's header, to hide the log.
- **Anywhere:** open Kanban with `?voiceDebug=1` (`?voiceDebug=0` hides it). In a home-screen web app the URL is
  fixed, so use the long press there.

The setting is remembered in localStorage (`kanban.voice-debug-log`). Copy puts the whole log on the clipboard for a
report; Clear empties it.

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

On a touch screen every terminal panel (card agent, sidebar orchestrator, shell terminals) has a touch bar under the
terminal, in the panel, so it never covers the TUI and moves above the on-screen keyboard with the panel. Its one row
holds the mic and the speaker on the left (agent sessions only), and on the right, while you are scrolled up, Jump to
bottom, then the key pad toggle and the round Enter. Enter and the toggle stay at the row's right edge whether Jump to
bottom is there or not, and the row keeps its height when it comes and goes. The voice bar's controls live in this
row on a phone, so there is no separate voice bar (user request, 2026-10-12):

- Enter sends the dictated text while the mic is on or the preview above the row holds some, exactly as the
  desktop's Send button: while listening it stops the mic and sends what you said once its final text is in (see
  "Speech in"), with nothing heard it only stops the mic. Otherwise it is the terminal's Enter, the keyboard's own
  submit, so text dictated into the terminal goes out first and stays sent.
- The X that clears the dictated text sits next to the preview, not in the row, and has the key pad toggle's size
  (44 px). A tap clears the text and, while the mic is on (or still opening), stops it without keeping what it heard;
  the next mic tap records afresh. It doesn't keep listening as the desktop's X does, because on iOS the recognizer
  sends one hypothesis that grows at the same index until the utterance ends (WebKit's
  `SpeechRecognition::didReceiveResult`, `WebSpeechRecognizerTask.mm`), so a clear by index would hide everything
  said after the X too.
- The X acts on the touch itself (its `pointerup` over the button), not on the browser's click, like the mic, which
  acts on `pointerdown`. iOS Safari makes a click of a tap only when the tap commits on the element its touch-down
  found, picked by fat-finger targeting that prefers whatever covers most of the finger (WebKit's
  `WebPage::commitPotentialTap`, `LocalFrame::qualifyingNodeAtViewportLocation`). The old 32-px X beside the large
  preview textarea got no clicks there (user report 2026-10-12, iPhone, Safari as a home-screen web app), while the
  44-px row buttons did. Cancelling `pointerdown` to keep the keyboard's focus is not what kept the click away: WebKit
  sends the click anyway (310491@main briefly didn't, and was reverted by 314097@main before any shipping Safari
  branch).
- The speaker turns reading replies aloud on and off. While a reply is being read its icon moves, the row says
  "Reading the reply…", and a tap stops that reading without turning the toggle off.

The toggle opens a row right above the controls with the keys a phone keyboard lacks for an agent's pickers: Esc, Shift+Tab, Tab,
Space and the arrows (held arrows repeat, arrows follow the TUI's cursor-key mode). No button takes the keyboard's
focus, so dictation keeps going. The row is part of the bar, not a panel over the terminal (an agent's input line is the
terminal's last rows, which an overlay would hide), so the terminal refits once when it opens or closes. The desktop
keeps the voice bar with its Send and stop buttons.

## Code

- `web-ui/src/voice/speech-apis.ts`: feature detection and the final/interim split of a result list.
- `web-ui/src/voice/use-speech-recognition.ts`, `live-recognition.ts`, `use-voice-input.ts`, `send-voice-input.ts`:
  speech in.
- `web-ui/src/voice/use-reply-speech.ts`, `speakable-text.ts`: speech out.
- `web-ui/src/voice/use-voice-chat.ts`: the voice chat state both layouts share (when Send/Enter may send, the preview).
- `web-ui/src/voice/voice-debug-log.ts`, `use-voice-debug-log.ts`,
  `web-ui/src/components/detail-panels/voice-debug-panel.tsx`: the diagnostic log.
- `web-ui/src/components/detail-panels/voice-chat-bar.tsx`: the desktop bar, shown by `AgentTerminalPanel`'s
  `voiceChat` prop; its mic, preview and status are `voice-chat-controls.tsx`.
- `web-ui/src/components/detail-panels/terminal-touch-bar.tsx`: the touch bar (`VoiceTerminalTouchBar` on an agent
  session); its keys and Enter go through `web-ui/src/terminal/terminal-ime-input.ts` like the keyboard's. Its button
  styles are `touch-bar-buttons.ts`; the preview's X taps through `web-ui/src/hooks/use-pointer-tap.ts`.
