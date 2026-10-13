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
- "Listening…" is shown once the capture source has started: the recognizer's `audiostart` event (or its first
  result, for a browser without that event), until its `end`. Before that the bar says "Starting…". The browser's
  `start` event only means the recognizer is set up. `audiostart` is no proof of audio either: in WebKit it is the
  capture source's `sourceStarted`, sent also for a capture that never delivers a sample (see "Safari: no speech
  after the first session"). A session whose capture hasn't started 4 s after `start` (`RECOGNITION_AUDIO_TIMEOUT_MS`)
  is aborted with "The microphone didn't open, so nothing was heard. Tap the mic to try again." An error ends
  listening with its message, including "No speech was heard" and "was interrupted". After your own stop those two
  stay quiet when something was recognised, and say "Nothing was heard. Tap the mic to try again." when nothing
  was. Safari's `audio-capture` "Source is stopped" says "The microphone delivered no audio." A session that doesn't
  start within 15 s (room for the first permission prompts), or doesn't end within 3 s of a stop, is aborted with a
  message.
- A final result that only repeats the final before it is kept once (`RepeatedFinalFilter` in
  `web-ui/src/voice/speech-apis.ts`). On a stop, Safari can send the last utterance's final twice: "Hello hello hello"
  final at index 0, then again final at index 1 (user's log, 2026-10-12, which sent "Hello hello hello Hello hello
  hello"). WebKit forwards every final the Speech framework reports (`WebSpeechRecognizerTask`'s
  `didFinishRecognition`) and `SpeechRecognition::didReceiveResult` appends each one at a new index; WebKit itself
  doesn't dedupe. A real second utterance with the same words is kept: the recognizer hypothesizes it first (an
  interim result at its index), while the repeat arrives final at once. The same rule drops Chrome Android's
  repeated finals of continuous mode when their text is equal.
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
- **iOS Safari (WebKit):** `start` is sent when the recognizer is set up (`SpeechRecognizer::start`), right before
  the capture source is started; `audiostart` is that source's `sourceStarted`
  (`SpeechRecognitionCaptureSourceImpl`), whether or not any audio sample follows. A muted source sends
  `audio-capture` "Source is muted", a failed one `audio-capture` "Source is stopped". Error events carry a
  `message`, which the log records. `stop()` finishes the SFSpeech task, and `end` follows the final result. A task
  that got no speech ends with `aborted` and the Speech framework's own message "No speech detected"
  (`didFinishSuccessfully:NO`, `task.error.localizedDescription`). Every session gets a new capture source: the
  UI process asks the page's WebContent process to create one per request (`createRealtimeMediaSourceForSpeechRecognition`,
  `SpeechRecognitionRealtimeMediaSourceManager::createSource`), and it is deleted when the session's recognizer
  stops capture.
- **Chrome Android:** `abort()` cancels and destroys Android's recognizer at once and sends `end`; `stop()` ends
  once Android delivers its results. A busy recognizer (`ERROR_RECOGNIZER_BUSY`) is reported as `not-allowed`,
  which reads "Microphone access was denied". In continuous mode Chrome marks every partial result final, so a long
  utterance can show its words more than once (known, not handled yet; nothing reported).

What is still unverified on the real phone, and what the diagnostic log shows for it:

- that `end` comes after `stop()` (a `stop()` line with no `end` before the next `start()`);
- which error iOS sends when the microphone is taken (`error audio-capture: …` with its message).

### Safari: no speech after the first session

User's logs, 2026-10-12 (iPhone, iOS 18.7, Safari 27.0.1, one page load, sessions #1 to #20): a session works on a
fresh page, after a reply was really read aloud, and after Safari reported `audio-capture` "Source is stopped".
Every other session, that is every session right after another one, never hears anything: `start` and
`audiostart` 40 to 55 ms after `start()` (the working ones took 200 ms or more: #1 1.6 s, #7 220 ms, #19 212 ms), no
`speechstart` or result while the user talks (17 s in #14), and on the user's stop `aborted` "No speech
detected". This is a Safari bug the page can't fix; Kanban's handling of the sessions (new instance, start inside
the tap, the old session aborted) is not what decides it.

What WebKit's sources (main, 2026-10) confirm:

- The failing sessions get no audio samples at all, not silent ones. #18 was left listening: exactly 20 s after
  its `audiostart` it got `audio-capture` "Source is stopped". That is `CoreAudioCaptureUnit::verifyIsCapturing`,
  which fails a capture whose microphone callback didn't run once in its interval (20 s while producing samples).
- It isn't a cached capture source: each session gets a new one (above). But every capture source of the process
  is a client of one shared `CoreAudioCaptureUnit`, and `BaseAudioCaptureUnit::continueStartProducingData` skips
  the real start (`startUnit`: audio session category, `AudioOutputUnitStart`) when the unit already counts as
  producing (`isProducingData()`, its `m_ioUnitStarted`). That fast path fits the 50 ms starts, the real start the
  200 ms ones.
- `captureFailed()` clears the unit's clients and stops it (`stopRunning`: `stopInternal` + `cleanupAudioUnit`), so
  the next session starts the unit for real, which is why #19 worked. An audio session interruption suspends the
  unit (`BaseAudioCaptureUnit::suspend` → `stopInternal`) and would have the same effect; that real playback
  interrupts it is likely (the reply is played outside the page's process) but not confirmed in the sources.
- When a capture stops, the unit keeps running while it has clients (`shouldContinueRunning()`: producing count,
  rendering audio, or any client), and since WebKit 2f88bc0b (2026-06-26, "Speech recognition microphone source
  should make sure to keep its audio session active while capturing") the speech recognition source's stop also
  deactivates the page's audio session (`audioCaptureSourceStateChanged(No)` → `maybeDeactivateAudioSession`).
  An audio unit left counting as started while its I/O no longer runs would give exactly the log above, but
  which step leaves it so could not be pinned down in the sources, and Safari 27.0.1's code may differ from main.

What the page can do: nothing found in the sources resets the shared unit from a page except a capture failure or
an audio session interruption. `navigator.audioSession.type = "play-and-record"` keeps the session from being
deactivated on main (`maybeDeactivateAudioSession` returns early for a category override), but not in the code of
2f88bc0b, and nothing shows it would restart the unit, so it is not used. What helps on the phone today: leave the
mic on until the bar says "The microphone delivered no audio" (20 s), or have a reply read aloud, and the next tap
hears again; reloading the page probably does too (a fresh page worked, not verified). Worth reporting to WebKit.
The log shows the signature: `start`/`audiostart` with `+40`–`+55 ms`, then nothing until "No speech detected".

## Diagnostic log

The voice chat records what the browser's recognizer and synthesizer do: each session's `start()`, `start` and
`audiostart` (each with the time since `start()`, `+212 ms`), `soundstart`, `speechstart`, `result` (count, final count, last text), `speechend`, `soundend`,
`audioend`, `nomatch`, `error` (code and message), `end`, Kanban's own `stop()`, `abort()` and "gave up", reply
speech's `speak()`, `cancel()`, its `start` (audio really plays; `speak()` only queues) and its `end`/`error`, and once per page whether it runs as a home-screen web app
and the browser's user agent. Times are UTC, and `#n` is the session's number on the page.

It records always (the page line, then the last 120 entries, in memory only: nothing leaves the page; a long
session's interim results push older sessions out) and is shown only on demand, so
after a failure it already holds what happened:

- **On a phone:** hold the mic for 1 s. The press starts listening as any tap does (that session shows in the log
  too); tap the mic again to stop. Hold it again, or the X in the log's header, to hide the log.
- **Anywhere:** open Kanban with `?voiceDebug=1` (`?voiceDebug=0` hides it). In a home-screen web app the URL is
  fixed, so use the long press there.

The setting is remembered in localStorage (`kanban.voice-debug-log`). Copy puts the whole log on the clipboard for a
report and leaves the log as it is; Clear empties it, and the page line comes back with the next entry's time.

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
- The preview spans the terminal panel edge to edge (no side margin or border), and the X that clears the dictated text
  sits inside it at its right edge, vertically centered however many lines the text takes, beside the text and never
  over it (its own flex item, so no text lies under a finger tapping it); it is not in the row, and has the key pad toggle's size
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
Paste and the arrows (held arrows repeat, arrows follow the TUI's cursor-key mode). There is no Space key, since the
phone keyboard has one. Paste is the only way to paste into a terminal on a phone (user request 2026-10-12, a copied voice
log). It reads the clipboard inside the tap (`navigator.clipboard.readText()`). WebKit's `Clipboard::readText` needs that
tap's transient activation, then asks for paste access, so iOS shows its "Paste" bubble unless the text was copied on this
page. The text goes to the PTY as one paste, the way xterm.js sends a paste: line breaks become Enter, and it is bracketed
while the TUI has bracketed paste on. It goes out after any pending dictation and leaves the keyboard's textarea as it is.
xterm's own `paste()` empties that textarea, which would end the dictation. A refused bubble, an empty clipboard, a page
that isn't https or localhost (no clipboard API there) or a terminal that takes no input shows a short line above the pad
for a few seconds. No button takes the keyboard's focus, so dictation keeps going. The row is part of the bar, not a panel over the terminal (an agent's input line is the
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
  session); its keys, Enter and Paste go through `web-ui/src/terminal/terminal-ime-input.ts` like the keyboard's
  (Paste: `web-ui/src/hooks/use-touch-paste.ts`, `web-ui/src/terminal/clipboard-text.ts`, `terminal-paste.ts`). Its button
  styles are `touch-bar-buttons.ts`; the preview's X taps through `web-ui/src/hooks/use-pointer-tap.ts`.
