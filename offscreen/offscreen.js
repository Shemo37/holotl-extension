// Offscreen document: owns the tab-audio capture, the 16 kHz PCM pipeline,
// the audible passthrough, the Silero VAD chunker (with an RMS silence-gate
// fallback), the Gemini Live client, and the cost meter. Created/destroyed
// by background.js.

import * as CFG from "../config.js";
import { GeminiLiveClient } from "./gemini-client.js";
import { SileroVad, DynamicChunker } from "./vad.js";

let client = null;
let mediaStream = null;
let captureCtx = null; // 16 kHz — feeds only the worklet
let playbackCtx = null; // native rate — keeps the tab audible, unresampled
let workletNode = null;
let running = false;

let settings = {
  silenceGate: true,
  targetLang: CFG.DEFAULT_TARGET_LANG,
  vadSettings: null, // popup overrides for CFG.VAD_SETTINGS
};
let apiKey = "";

// User-tunable numbers cross the messaging boundary — clamp them against
// the same ranges the popup sliders advertise before they reach the
// chunker.
function clampNum(v, def, lo, hi) {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
}

function effectiveVadSettings() {
  const d = CFG.VAD_SETTINGS;
  const s = settings.vadSettings || {};
  return {
    vadThreshold: clampNum(s.vadThreshold, d.vadThreshold, 0.05, 0.95),
    volumeThreshold: clampNum(s.volumeThreshold, d.volumeThreshold, 0, 0.02),
    silenceTimeoutS: clampNum(s.silenceTimeoutS, d.silenceTimeoutS, 0.3, 2),
    minSpeechS: clampNum(s.minSpeechS, d.minSpeechS, 0, 0.3),
    softCutAfterS: clampNum(s.softCutAfterS, d.softCutAfterS, 1, 10),
    softCutSilenceS: clampNum(s.softCutSilenceS, d.softCutSilenceS, 0.1, 0.7),
    maxActiveS: clampNum(s.maxActiveS, d.maxActiveS, 2, 30),
  };
}

// VAD pipeline: chunker is set when Silero loaded; null → fallback path.
let chunker = null;
let vadActive = false;
// Sticky across reconnects/language changes: once a session proves the
// model rejects the manual-activity setup field, don't re-learn it (each
// re-learn costs 2 dead sessions).
let manualActivityBroken = false;

// Fallback-path state (no VAD): silence gate + frame batching.
let lastLoudAt = 0;
let batchFrames = [];
const FALLBACK_BATCH_FRAMES = 5; // 5 × 512 samples = 160 ms per send

// Cost meter: bill only audio actually sent (the VAD/silence-gate savings
// are therefore visible in the meter).
let sentSamples = 0;
let sessionStartedAt = 0;
let baseTotalUsd = 0; // all-time total persisted before this session began
let costTimer = null;
let fakeTimer = null;

function sessionUsd() {
  return (sentSamples / 16000 / 60) * CFG.PRICE_PER_MIN;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  switch (msg.action) {
    case "OFFSCREEN_START":
      start(msg)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          console.error("[HoloTL Live] start failed", e);
          broadcastStatus("error", `Capture failed: ${e.message}`);
          sendResponse({ ok: false, error: String(e.message || e) });
        });
      return true;
    case "OFFSCREEN_STOP":
      stop();
      sendResponse({ ok: true });
      return;
    case "SETTINGS_CHANGED":
      applySettings(msg.settings || {});
      sendResponse({ ok: true });
      return;
  }
});

// Silero loads once per document lifetime; chunker state resets per session.
let sileroVadPromise = null;
function getSileroVad() {
  if (!sileroVadPromise) {
    sileroVadPromise = (async () => {
      try {
        const vad = new SileroVad();
        await vad.load();
        debugLog("Silero VAD model loaded (onnxruntime-web)");
        return vad;
      } catch (e) {
        console.warn("[HoloTL Live] Silero VAD failed to load:", e);
        debugLog(`Silero VAD unavailable (${e.message}) — RMS silence gate fallback`);
        return null;
      }
    })();
  }
  return sileroVadPromise;
}

async function start({ streamId, apiKey: key, settings: s, baseTotalUsd: base }) {
  stop(); // clean slate if a previous session leaked
  apiKey = key || "";
  settings = { ...settings, ...s };
  sentSamples = 0;
  sessionStartedAt = Date.now();
  lastLoudAt = Date.now();
  batchFrames = [];
  // Offscreen documents can't use chrome.storage — background reads the
  // all-time total for us and persists it back from our COST_UPDATEs.
  baseTotalUsd = base || 0;
  running = true;

  if (CFG.DEBUG_FAKE_SUBTITLES) {
    startFakeMode();
    return;
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });

  // tabCapture mutes the tab, so play the stream back on a second,
  // native-rate context — the 16 kHz context below feeds only the worklet,
  // keeping music at full quality for the viewer.
  playbackCtx = new AudioContext();
  playbackCtx
    .createMediaStreamSource(mediaStream)
    .connect(playbackCtx.destination);

  const vad = CFG.USE_SILERO_VAD ? await getSileroVad() : null;
  vadActive = vad !== null;
  if (vadActive) {
    chunker = new DynamicChunker(vad, effectiveVadSettings(), {
      onSpeechStart: onSpeechStart,
      onSpeechFrame: queueSpeechFrame,
      onSpeechEnd: onSpeechEnd,
    });
    chunker.reset();
  } else {
    chunker = null;
  }

  captureCtx = new AudioContext({ sampleRate: 16000 });
  await captureCtx.audioWorklet.addModule("pcm-worklet.js");
  const source = captureCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(captureCtx, "pcm-framer");
  source.connect(workletNode);
  workletNode.port.onmessage = (e) => onFrame(new Float32Array(e.data));

  await Promise.all([captureCtx.resume(), playbackCtx.resume()]);

  connectClient();
  costTimer = setInterval(tickCost, 5000);
}

function connectClient() {
  const wantedManualActivity = CFG.MANUAL_ACTIVITY && vadActive;
  // The old client self-disables manualActivity after 2 sessions die before
  // any server message; carry that verdict into every future client.
  if (client && wantedManualActivity && !client.manualActivity) {
    manualActivityBroken = true;
  }
  client?.disconnect();
  const instruction =
    (CFG.SYSTEM_INSTRUCTIONS[settings.targetLang] ||
      CFG.SYSTEM_INSTRUCTIONS[CFG.DEFAULT_TARGET_LANG]) + CFG.ROSTER_HINT;
  client = new GeminiLiveClient({
    apiKey,
    model: CFG.LIVE_MODEL,
    wsUrlBase: CFG.WS_URL_BASE,
    systemInstruction: instruction,
    setupOverrides: CFG.SETUP_OVERRIDES,
    // Utterance-per-turn only works when client-side VAD cuts utterances.
    manualActivity: wantedManualActivity && !manualActivityBroken,
    reconnectDelayMs: CFG.RECONNECT_DELAY_MS,
    maxConsecutiveFailures: CFG.MAX_CONSECUTIVE_FAILURES,
    debug: CFG.DEBUG,
    onSubtitleUpdate: (payload) =>
      broadcast({ action: "UPDATE_SUBTITLES", payload }),
    onStatusChange: (status, message) => {
      // A reconnect (15-min session limit) can land mid-sentence: the new
      // session needs its own activityStart or window audio is ignored.
      if (status === "connected" && chunker?.isSpeaking) {
        client?.startActivity();
      }
      broadcastStatus(status, message);
    },
    onDebug: (line) => debugLog(line),
  });
  debugLog(
    `connecting: lang=${settings.targetLang}, ` +
      (vadActive
        ? `vad=silero, manualActivity=${CFG.MANUAL_ACTIVITY}`
        : `vad=off, silenceGate=${settings.silenceGate}`)
  );
  client.connect();
}

function stop() {
  const wasRunning = running;
  running = false;
  clearInterval(costTimer);
  costTimer = null;
  clearInterval(fakeTimer);
  fakeTimer = null;
  client?.disconnect();
  client = null;
  chunker = null;
  batchFrames = [];
  speechBatch = [];
  try {
    workletNode?.disconnect();
  } catch {}
  workletNode = null;
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  captureCtx?.close().catch(() => {});
  captureCtx = null;
  playbackCtx?.close().catch(() => {});
  playbackCtx = null;
  if (wasRunning) tickCost(); // final COST_UPDATE so background persists the total
}

function applySettings(s) {
  const langChanged =
    s.targetLang !== undefined && s.targetLang !== settings.targetLang;
  settings = { ...settings, ...s };
  // VAD/chunking tuning is purely client-side: re-apply to the live
  // chunker mid-session, no reconnect needed.
  if (s.vadSettings !== undefined && chunker) {
    chunker.applySettings(effectiveVadSettings());
    debugLog(
      `vad settings applied: ${JSON.stringify(effectiveVadSettings())}`
    );
  }
  // The system instruction lives in the per-session setup message, so a
  // language change needs a fresh session (~500 ms gap).
  if (langChanged && running && client) connectClient();
}

function onFrame(frame) {
  if (!running || !client) return;
  if (chunker) {
    chunker.push(frame); // Silero decides; speech windows stream live
    return;
  }
  fallbackStream(frame);
}

// VAD path: audio streams live inside each speech window so the model
// translates while the sentence is still being spoken. Frames go out in
// ~96 ms batches to keep message overhead sane.
const SPEECH_BATCH_FRAMES = 3;
let speechBatch = [];

function onSpeechStart(frames) {
  if (!running || !client) return;
  // New utterance: pair up and display whatever the previous window left
  // pending (covers models that never send a turn marker).
  client.flushTurn();
  client.startActivity();
  speechBatch = [];
  for (const f of frames) queueSpeechFrame(f);
}

function queueSpeechFrame(frame) {
  if (!running || !client) return;
  speechBatch.push(frame);
  if (speechBatch.length >= SPEECH_BATCH_FRAMES) flushSpeechBatch();
}

function flushSpeechBatch() {
  if (!speechBatch.length || !client) return;
  const frames = speechBatch;
  speechBatch = [];
  const total = frames.reduce((n, f) => n + f.length, 0);
  const batch = new Float32Array(total);
  let off = 0;
  for (const f of frames) {
    batch.set(f, off);
    off += f.length;
  }
  if (client.sendAudioChunk(floatToPcm16Base64(batch))) {
    sentSamples += batch.length;
  }
}

function onSpeechEnd({ durationS, forced }) {
  if (!client) return;
  flushSpeechBatch();
  client.endActivity();
  debugLog(
    `utterance: ${durationS.toFixed(2)}s streamed live` +
      (forced ? " (max-length cut)" : "")
  );
}

// No-VAD path: continuous 160 ms batches behind the RMS silence gate (the
// pre-VAD behavior).
function fallbackStream(frame) {
  batchFrames.push(frame);
  if (batchFrames.length < FALLBACK_BATCH_FRAMES) return;
  const frames = batchFrames;
  batchFrames = [];

  const total = frames.reduce((n, f) => n + f.length, 0);
  const batch = new Float32Array(total);
  let off = 0;
  let sumSq = 0;
  for (const f of frames) {
    batch.set(f, off);
    off += f.length;
    for (let i = 0; i < f.length; i++) sumSq += f[i] * f[i];
  }
  const rms = Math.sqrt(sumSq / total);

  const now = Date.now();
  if (rms >= CFG.SILENCE_RMS_THRESHOLD) lastLoudAt = now;
  if (
    settings.silenceGate &&
    rms < CFG.SILENCE_RMS_THRESHOLD &&
    now - lastLoudAt > CFG.SILENCE_HANGOVER_MS
  ) {
    return; // gate closed — don't pay to stream dead air
  }
  if (client.sendAudioChunk(floatToPcm16Base64(batch))) {
    sentSamples += batch.length;
  }
}

function floatToPcm16Base64(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    let s = f32[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return arrayBufferToBase64(i16.buffer);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const STRIDE = 0x8000;
  for (let i = 0; i < bytes.length; i += STRIDE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STRIDE));
  }
  return btoa(binary);
}

function tickCost() {
  broadcast({
    action: "COST_UPDATE",
    payload: {
      audioSeconds: sentSamples / 16000,
      wallSeconds: Math.round((Date.now() - sessionStartedAt) / 1000),
      sessionUsd: sessionUsd(),
      totalUsd: baseTotalUsd + sessionUsd(),
    },
  });
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    /* nobody listening (popup closed) is fine */
  });
}

function broadcastStatus(status, message) {
  broadcast({ action: "STATUS_UPDATE", payload: { status, message } });
}

// Debug log lines for the popup's Debug tab. The offscreen console dies
// with the document, so background persists these in chrome.storage.session.
function debugLog(line) {
  broadcast({ action: "DEBUG_LOG", payload: { line } });
}

// ---- fake-segment mode (DEBUG_FAKE_SUBTITLES): no capture, no socket ----

const FAKE_SEGMENTS = [
  { jp: "こんにちは、みなさん！", en: "Hello, everyone!" },
  { jp: "今日は歌の練習をします。", en: "Today we'll practice singing." },
  { jp: "スパチャありがとう！", en: "Thanks for the superchat!" },
];

function startFakeMode() {
  broadcastStatus("connected", "fake-segment mode");
  let i = 0;
  fakeTimer = setInterval(() => {
    broadcast({
      action: "UPDATE_SUBTITLES",
      payload: FAKE_SEGMENTS[i++ % FAKE_SEGMENTS.length],
    });
    sentSamples += 2 * 16000; // pretend 2s of audio so the cost meter moves
  }, 2000);
  costTimer = setInterval(tickCost, 5000);
}
