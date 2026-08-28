# HoloTL Browser Extension — Live JP Subtitles via Gemini

Chrome (Manifest V3) extension that live-translates Japanese speech from any
browser tab into on-page subtitles, using **only the Google Gemini API** for
transcription/translation. It is a browser port of the
[HoloTL desktop app](../HoloLiveTL-main)'s pipeline: the same Silero VAD
dynamic chunking heuristics run in-browser (onnxruntime-web), each detected
utterance is sent to Gemini as a WAV chunk, and a per-stream cost meter tracks
real token usage.

No build step — plain JS, vendored libraries, loaded unpacked.

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder (`holotl-extension`).
3. Get a Gemini API key at <https://aistudio.google.com/apikey>.

## Use

1. Open the stream/VOD tab (YouTube, Twitch, …) and start playback.
2. Click the HoloTL toolbar icon → paste your API key → **Start captioning
   this tab**.
3. Subtitles appear as a draggable overlay over the page (they follow
   fullscreen video too). Stop from the same popup.

Output modes: **EN** (translate), **JA** (transcribe verbatim), **JA + EN**
(both lines from a single request — same cost as one mode).

## Engine notes

One `generateContent` request per VAD-detected utterance; subtitles appear
~1–2 s after each line ends (lower the silence-cut slider to ~0.5 s for the
snappiest feel).

**Model choice is a quality/latency trade.** The default
`gemini-3.7-flash` gives the best translations but cannot fully disable
thinking (`thinkingLevel: "low"` is its floor; `thinkingBudget` is silently
ignored) and runs 10–30 s per chunk. The consumer loop keeps up regardless —
up to 6 requests fly concurrently (2 for lite models) with results delivered
in stream order — so a slow model costs subtitle *delay*, never dropped
audio. For near-real-time subtitles (~1–2 s) switch Model id to
`gemini-3.5-flash-lite`: lite models don't think by default and answer in
about a second, at somewhat lower translation quality. For non-lite models
the client walks a thinking-config ladder (`minimal` → `low` →
`thinkingBudget: 0` → none) and remembers what the model accepts; models
with "lite" in the id get no thinking config at all, since it could only
turn thinking on. With a fast-talking streamer on a non-lite model, raise
Requests/min toward 60 so dispatch spacing isn't the bottleneck.

A Gemini **Live API** streaming engine (word-by-word partials via
`gemini-3.5-transcribe-live`) existed briefly and was removed by request —
see git/README history if resurrecting it. Hard-won facts from that work:
the Live wire format is camelCase (`serverContent.interimInputTranscription`),
`mode: "SMART"` silently produces no output (use VERBATIM), and the dedicated
transcribe model refuses to transcribe singing over music.

## How it works

```
tab audio ──(tabCapture + offscreen document)──▶ AudioContext
   ├─▶ speakers (playback continues)
   └─▶ AudioWorklet: mono mixdown + resample to 16 kHz + 512-sample frames
         └─▶ Silero VAD v4 (onnxruntime-web, WASM) — desktop app's exact
             frame loop: 0.25 threshold, ~288 ms pre-roll, 0.9 s silence cut,
             8 s max chunk, loud-sound bypass
               └─▶ enhancement (60 Hz low-cut, RMS normalize) ─▶ WAV
                     └─▶ drop-oldest queue (8) ─▶ rate limiter (30 rpm)
                           └─▶ Gemini generateContent (inline WAV, temp 0)
                                 └─▶ string filters (hallucination/boilerplate/
                                     dedup) ─▶ overlay subtitle
```

- Slow API responses never cause lag: the bounded drop-oldest queue discards
  the oldest chunks so subtitles stay live.
- Errors: per-minute 429s trigger a 5–30 s cooldown (chunks silently dropped);
  a daily-quota 429, bad key (401/403), bad model id (404), or 3 consecutive
  failures stop the session with the reason shown in the overlay and popup.
- Cost meter reads `usageMetadata` token counts from every response (falls
  back to 32 audio tokens/s + chars/4 estimates), with editable $/1M-token
  prices. Session cost and an all-time total are shown in the popup.

## Settings notes

- **Model id** defaults to `gemini-3.5-flash-lite` and is editable — but see
  the latency requirement under Engine notes before picking a non-lite
  model. The dedicated `gemini-3.5-transcribe` model is *not* supported: it
  is served only through the Interactions/Live APIs and cannot translate.
- API key and model changes apply on the next Start; everything else
  (VAD sliders, rpm, prices, output mode, overlay) applies live.
- The Hololive JP roster toggle appends ~32 talent names to the prompt so
  Gemini spells names correctly.

## Vendored libraries (`libs/`)

- `ort/` — [onnxruntime-web 1.19.2](https://www.npmjs.com/package/onnxruntime-web)
  dist (`ort.min.js`, `ort-wasm-simd-threaded.{wasm,mjs}`). Single-threaded
  WASM only (`numThreads = 1`) — MV3 CSP blocks the blob workers the threaded
  path spawns. CSP carries `'wasm-unsafe-eval'` for this.
- `silero_vad_legacy.onnx` — Silero VAD v4, from
  [@ricky0123/vad-web 0.0.22](https://www.npmjs.com/package/@ricky0123/vad-web)
  dist. Same model generation as the desktop app's `silero_vad.jit`, so its
  tuned 0.25 threshold transfers.

## Dev smoke test

`dev-test.html` loads the vendored ort + Silero model outside the extension
and prints load time / per-frame latency / sanity probabilities. Serve the
folder with correct MIME types and open it:

```bash
python -c "from http.server import HTTPServer, SimpleHTTPRequestHandler as H; H.extensions_map['.mjs']='text/javascript'; HTTPServer(('127.0.0.1',8622), H).serve_forever()"
```

## Limitations

- Chrome/Chromium only (uses `chrome.tabCapture` + offscreen documents).
- DRM-protected tabs (Netflix etc.) capture silence. YouTube/Twitch are fine.
- Subtitles cannot be drawn on restricted pages (`chrome://`, Web Store);
  capture still works there but there is nowhere to render.
- Requires a Gemini API key with quota; there is no local fallback engine by
  design — when the key/quota dies, captioning stops and tells you why.
