# VocalCoach

VocalCoach is a voice agent that teaches you vocabulary over a phone-style call. It borrows its core idea from
[momsalarm](../momsalarm), where an alarm that won't stop until a voice agent decides you're awake. In
VocalCoach, the proof that you're awake is passing today's words.

This is the web prototype: plain JavaScript and Vite, with no backend. The browser talks to the Gemini Live
API directly over a WebSocket.

## Run it

```bash
npm install
npm run dev
```

Open the local URL Vite prints (`http://localhost:5173`). Microphone access requires `localhost` or HTTPS. Then
paste a Gemini API key in **Settings**. The key is stored only in your browser.

Use headphones if you can. The browser's echo cancellation is on, but the coach can still hear itself through
laptop speakers.

## How a call works

Each call covers a small set of words: due reviews first, then new words. Practice calls take up to 5 words;
alarm calls take up to 3. Every word has to clear two **productive** tasks:

1. **Say it:** the coach gives the meaning (or a sentence with a blank), and you say the word.
2. **Use it:** you use the word in a sentence of your own, with enough context to show you understand it.
   Reciting the definition or repeating the example doesn't count.

The coach grades every answer through a `grade_word` tool call, and the app keeps the score. The coach can only
end the call with `end_call`, which the app refuses until every word is passed. This is the same gate as
momsalarm's `stop_alarm`. You can also say "add the word …" mid-call (`add_word`).

As in momsalarm:

- the mic stays open for the whole call, and you can interrupt the coach;
- if you go quiet for 15 seconds, the coach nudges you;
- if the line drops, it calls back and picks up where it left off;
- there is a hard stop at 10 minutes.

The call screen has mute, end and audio. Audio opens a microphone picker, and the choice is remembered. If the
chosen input is silent, or Gemini transcribes none of what it hears, the status line turns amber, says so, and
opens the same picker when tapped.

## Scheduling (Leitner boxes)

| Box | Next review |
| --- | --- |
| 0 | new |
| 1 | 1 day |
| 2 | 2 days |
| 3 | 4 days |
| 4 | 8 days |
| 5 | 16 days |
| 6 | 32 days |

A word passed on the first try moves up one box. Any miss sends it back to box 1, so it comes back tomorrow.
Due dates fall at local midnight, so a morning alarm catches everything due that day.

## Wake-up call

Set a time and switch it on. When the alarm fires, the page rings until you answer, and there is no decline
button. Alarm calls are short. An emergency hang-up exists, but it counts every unfinished word as failed.

Nothing runs once the page is gone or out of sight: the alarm and ringtone only sound while the page is open and
visible, a call hangs up (mic off, connection closed) as soon as you switch away or close the page, and the app
sends no system notifications. A real alarm that works when the screen is off needs the native app path that
momsalarm already solved.

## Files

| File | Role |
| --- | --- |
| `src/main.js` | Screens (home, ring, call, summary), call controller, tool handling, alarm clock |
| `src/live.js` | Gemini Live WebSocket session, mic downsampling worklet, PCM player, goodbye sequencing |
| `src/prompt.js` | Coach personas, system prompt, tool declarations, nudge and opening cues |
| `src/session.js` | Per-call progress (recall/sentence per word); the source of truth for `end_call` |
| `src/deck.js` | Word deck, starter words, Leitner scheduling |
| `src/ringer.js` | WebAudio ringtone and next-alarm time |
| `src/storage.js` | localStorage settings, study days, streak |
