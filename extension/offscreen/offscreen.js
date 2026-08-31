// Offscreen document: owns the tab-audio capture, the 16 kHz PCM pipeline,
// the audible passthrough, the silence gate, the Gemini Live client, and
// the cost meter. Created/destroyed by background.js.

import * as CFG from "../config.js";
import { GeminiLiveClient } from "./gemini-client.js";

let client = null;
let mediaStream = null;
let captureCtx = null; // 16 kHz — feeds only the worklet
let playbackCtx = null; // native rate — keeps the tab audible, unresampled
let workletNode = null;
let running = false;

let settings = {
  silenceGate: true,
  targetLang: CFG.DEFAULT_TARGET_LANG,
};
let apiKey = "";

// Silence gate state.
let lastLoudAt = 0;

// Cost meter: bill only audio actually sent (the silence gate's savings are
// therefore visible in the meter). 1 chunk = 100 ms.
let sentChunks = 0;
let sessionStartedAt = 0;
let baseTotalUsd = 0; // all-time total persisted before this session began
let costTimer = null;
let fakeTimer = null;

function sessionUsd() {
  return ((sentChunks * 0.1) / 60) * CFG.PRICE_PER_MIN;
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

async function start({ streamId, apiKey: key, settings: s, baseTotalUsd: base }) {
  stop(); // clean slate if a previous session leaked
  apiKey = key || "";
  settings = { ...settings, ...s };
  sentChunks = 0;
  sessionStartedAt = Date.now();
  lastLoudAt = Date.now();
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

  captureCtx = new AudioContext({ sampleRate: 16000 });
  await captureCtx.audioWorklet.addModule("pcm-worklet.js");
  const source = captureCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(captureCtx, "pcm-chunker");
  source.connect(workletNode);
  workletNode.port.onmessage = (e) => onChunk(e.data);

  await Promise.all([captureCtx.resume(), playbackCtx.resume()]);

  connectClient();
  costTimer = setInterval(tickCost, 5000);
}

function connectClient() {
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
    reconnectDelayMs: CFG.RECONNECT_DELAY_MS,
    maxConsecutiveFailures: CFG.MAX_CONSECUTIVE_FAILURES,
    debug: CFG.DEBUG,
    onSubtitleUpdate: (payload) =>
      broadcast({ action: "UPDATE_SUBTITLES", payload }),
    onStatusChange: (status, message) => broadcastStatus(status, message),
  });
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
  // The system instruction lives in the per-session setup message, so a
  // language change needs a fresh session (~500 ms gap).
  if (langChanged && running && client) connectClient();
}

function onChunk({ samples, rms }) {
  if (!running || !client) return;
  const now = Date.now();
  if (rms >= CFG.SILENCE_RMS_THRESHOLD) lastLoudAt = now;
  if (
    settings.silenceGate &&
    rms < CFG.SILENCE_RMS_THRESHOLD &&
    now - lastLoudAt > CFG.SILENCE_HANGOVER_MS
  ) {
    return; // gate closed — don't pay to stream dead air
  }
  client.sendAudioChunk(arrayBufferToBase64(samples.buffer));
  sentChunks++;
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
      audioSeconds: sentChunks * 0.1,
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
    sentChunks += 20; // pretend 2s of audio so the cost meter moves
  }, 2000);
  costTimer = setInterval(tickCost, 5000);
}
