# HoloLiveTL Live — Gemini Live API subtitles

Chrome MV3 extension that streams tab audio to the **Gemini Multimodal Live
API over WebSockets** and renders real-time Japanese subtitles with an
English or Thai translation as a draggable on-page overlay.

No build step — plain JS, loaded unpacked.

> An earlier chunk-based engine (Silero VAD → WAV chunks → one
> `generateContent` REST call per utterance) lived in this repo and was
> removed in favor of this Live streaming approach — see git history if
> resurrecting it.

```
tab audio ─tabCapture─▶ offscreen document
   ├─▶ native-rate AudioContext ─▶ speakers (tab stays audible, unresampled)
   └─▶ 16 kHz AudioContext ─▶ AudioWorklet (100 ms PCM16 chunks + RMS)
         └─▶ silence gate ─▶ base64 ─▶ WebSocket BidiGenerateContent
               └─▶ "JP: …" / "EN: …" (or "TH: …") lines ─▶ overlay
```

## Repo layout

- `manifest.json` — MV3, module service worker, on-demand injection (no
  static content scripts).
- `config.js` — **every knob lives here**: model id, WS endpoint, system
  instructions per language, price, silence gate, reconnect policy,
  appearance defaults, DEBUG flags.
- `background.js` — start/stop orchestration, offscreen-document lifecycle,
  message relay to the tab, debug-log persistence.
- `offscreen/offscreen.js` — audio pipeline, silence gate, cost meter.
- `offscreen/gemini-client.js` — **all Live wire-schema knowledge** (setup,
  audio frames, response parsing, reconnect).
- `offscreen/pcm-worklet.js` — 16 kHz Float32→PCM16 chunker with RMS.
- `content/overlay.js` + `content/overlay.css` — the injected subtitle
  overlay.
- `popup.html` / `popup.js` — controls plus the Appearance and Debug tabs.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select this repo folder (`holotl-extension`).
2. Get a Gemini API key at <https://aistudio.google.com/apikey>.
3. Click the toolbar icon → paste the key → **Save**. The key lives only in
   `chrome.storage.local`. **Never commit it, and never publish a build of
   this extension with a key embedded — anyone could extract and bill it.**

All settings live in `chrome.storage.local` under `apiKey`, `targetLang`,
`silenceGate`, `appearance`, and `totalUsd` (all-time spend) — removing the
extension clears all of them, key included.

## Use

1. Open the stream tab, start playback.
2. Popup → pick **Translate to** (English default, or Thai) → **Start**.
3. Subtitles appear in a draggable dark box (`JP` line on top, translation
   beneath), with a status dot: green connected, amber (re)connecting, red
   error. Subtitles clear after 4 s of silence. **Stop** from the popup.

The popup has two tabs:

- **Appearance** — font size, JP/translation text colors, text border
  (outline) width and color, and box background opacity. Every change
  applies to the overlay instantly (stored in `chrome.storage.local`, the
  overlay watches for changes), with a reset-to-defaults button.
- **Debug** — the cost meter (session / all-time, plus audio-seconds sent
  vs wall-clock) and a rolling event log: connection opens, close
  codes/reasons, reconnects, status changes, and the first raw server frame.
  The log survives popup close (session storage) and clears when the
  browser closes or via the Clear button.

Changing the translation language while running reconnects the Live session
(~0.5 s gap) — the language lives in the session's system instruction.

## Model

One constant in `config.js`:

```js
export const LIVE_MODEL = "models/gemini-3.5-live-translate-preview";
```

`gemini-2.0-flash` is the documented alternate. Any general Live model that
follows the system instruction produces both lines. The default is a
preview model whose exact wire schema hasn't been exercised against the
real API yet — the first real run tells you (the Debug tab shows the first
server frame; see Troubleshooting). If you swap in the
dedicated `models/gemini-3.5-transcribe-live` instead, know its quirks
(learned the hard way in this repo's earlier Live experiments):

- it **ignores translation instructions** — you get JP only, the second
  line stays empty (the parser tolerates this);
- it needs `SETUP_OVERRIDES = { inputAudioTranscription: { mode: "VERBATIM" } }`
  in `config.js` — mode `SMART` silently produces no output;
- it refuses to transcribe singing over music.

## Cost

Live streaming bills by audio time sent, `PRICE_PER_MIN` (default $0.009/min
≈ **$0.54 per hour** of wall-clock streaming). Two things keep that visible
and reducible:

- the **silence gate** (popup toggle) stops sending audio after 1 s below an
  RMS threshold, so BGM lulls and dead air cost nothing;
- the popup's **Debug tab** shows **this session / all-time** spend,
  computed from audio seconds actually sent (persisted across sessions).

Verify the price against Google's current pricing and adjust
`PRICE_PER_MIN` in `config.js`.

## Session limit and reconnects

Live API sessions are capped at roughly **15 minutes** server-side. When the
socket closes, the client reconnects after 500 ms automatically — you'll see
the amber dot blink and lose about a second of audio. Guards:

- **Stop** sets an intentional-close flag — no reconnect;
- 10 consecutive connection failures without a single server message (bad
  key, bad model id) stop the session with a red error status instead of
  hammering the endpoint every 500 ms.

## Debugging schema drift

Preview Live models change shape. The popup's **Debug tab** shows the
first server frame (truncated) and every close code/reason without opening
any console. For the full frame, `DEBUG = true` in `config.js` (default on)
logs it verbatim in the offscreen console (`chrome://extensions` →
offscreen document → Inspect) — paste that log and the fix is usually a
one-liner in `gemini-client.js` or `config.js`. The wire format is
camelCase. `DEBUG_FAKE_SUBTITLES = true` runs the whole UI pipeline with
canned subtitles and no API key/capture (for smoke tests only).

## Troubleshooting

Open the popup's **Debug tab** first — it answers most of these.

- **No subtitles, dot stays green** — check the log: if frames are arriving
  but nothing renders, the response shape changed; grab the first-frame log
  line and adjust the parser in `offscreen/gemini-client.js`. If the log is
  quiet, the tab may be silent or the silence gate threshold too high
  (toggle the gate off to test).
- **Red dot / "Connection failed 10 times"** — bad API key, a model id the
  Live endpoint doesn't serve, or no Live API quota. The log shows the
  close code/reason from the server; fix the key or `LIVE_MODEL`, then
  Start again.
- **Cost ticks but no overlay** — you started on a restricted page
  (`chrome://`, Web Store) where the overlay can't render, or the tab
  navigated after Start (Stop, then Start again to re-inject).
- **Second line empty, JP fine** — the model is ignoring the translation
  instruction (the dedicated transcribe model always does; see Model).
- **Tab went silent** — the capture ended abnormally (e.g. the offscreen
  document crashed); Stop, reload the tab, Start again.
- **Amber dot every ~15 minutes** — normal; that's the Live session limit
  rollover (see above).

## Limitations

- Chrome/Chromium only (`chrome.tabCapture` + offscreen documents).
- DRM-protected tabs (Netflix etc.) capture silence.
- Restricted pages (`chrome://`, Web Store) can't render the overlay.
- Requires a Gemini API key with Live API quota.
