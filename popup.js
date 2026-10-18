// Popup: backend choice (Gemini Live or the local HOLOTLLOCAL pipeline),
// API key / server URL storage, start/stop, target language, silence gate,
// plus tabs — Appearance (live-applied overlay styling), Detection, and
// Debug (cost meter + rolling event log). Offscreen broadcasts reach us
// directly.

import {
  DEFAULT_BACKEND,
  DEFAULT_LOCAL_SERVER_URL,
  DEFAULT_TARGET_LANG,
  DEFAULT_APPEARANCE,
  LOCAL_VAD_SETTINGS,
  VAD_SETTINGS,
} from "./config.js";

const $ = (id) => document.getElementById(id);
const backendSelect = $("backend");
const keyInput = $("api-key");
const keySaved = $("key-saved");
const urlInput = $("local-url");
const urlSaved = $("url-saved");
const langSelect = $("target-lang");
const gateCheck = $("silence-gate");
const startBtn = $("start");
const stopBtn = $("stop");
const statusEl = $("status");
const costEl = $("cost");
const costDetailEl = $("cost-detail");
const logEl = $("debug-log");

// Appearance controls: element id → appearance key.
const APPEARANCE_CONTROLS = {
  "font-size": "fontSizePx",
  "jp-color": "jpColor",
  "en-color": "enColor",
  "outline-width": "outlineWidthPx",
  "outline-color": "outlineColor",
  "bg-opacity": "bgOpacity",
};
let appearance = { ...DEFAULT_APPEARANCE };

// Detection (VAD/chunking) controls: element id → vadSettings key + how to
// print the value. Stored per backend (Gemini streams short turns, the
// local Whisper pipeline wants sentence-length utterances) and applied live
// to the running chunker via background's storage.onChanged relay.
const VAD_CONTROLS = {
  "vad-threshold": { key: "vadThreshold", fmt: (v) => v.toFixed(2) },
  "volume-threshold": { key: "volumeThreshold", fmt: (v) => v.toFixed(3) },
  "silence-timeout": { key: "silenceTimeoutS", fmt: (v) => `${v.toFixed(1)}s` },
  "min-speech": { key: "minSpeechS", fmt: (v) => `${v.toFixed(2)}s` },
  "soft-cut-after": { key: "softCutAfterS", fmt: (v) => `${v.toFixed(1)}s` },
  "soft-cut-silence": { key: "softCutSilenceS", fmt: (v) => `${v.toFixed(2)}s` },
  "max-active": { key: "maxActiveS", fmt: (v) => `${v.toFixed(1)}s` },
};
const VAD_DEFAULTS = { gemini: VAD_SETTINGS, local: LOCAL_VAD_SETTINGS };
const VAD_STORAGE_KEY = { gemini: "vadSettings", local: "localVadSettings" };
let backend = DEFAULT_BACKEND;
let vadSettings = { ...VAD_SETTINGS };

init();

async function init() {
  const {
    apiKey = "",
    backend: storedBackend = DEFAULT_BACKEND,
    localServerUrl = DEFAULT_LOCAL_SERVER_URL,
    silenceGate = true,
    targetLang = DEFAULT_TARGET_LANG,
    totalUsd = 0,
    appearance: storedAppearance,
  } = await chrome.storage.local.get([
    "apiKey",
    "backend",
    "localServerUrl",
    "silenceGate",
    "targetLang",
    "totalUsd",
    "appearance",
  ]);
  if (apiKey) {
    keyInput.value = apiKey;
    keySaved.textContent = "key saved";
  }
  urlInput.value = localServerUrl;
  gateCheck.checked = silenceGate;
  langSelect.value = targetLang;
  renderCost(0, totalUsd);

  appearance = { ...DEFAULT_APPEARANCE, ...(storedAppearance || {}) };
  renderAppearanceControls();

  backend = storedBackend;
  renderBackend();
  await loadVadSettings();

  const { debugLog = [] } = await chrome.storage.session.get("debugLog");
  renderLog(debugLog);

  const state = await chrome.runtime.sendMessage({ action: "GET_STATE" });
  setRunning(!!state?.running);
}

// ---- tabs ----

const tabs = [
  { btn: $("tab-btn-appearance"), panel: $("tab-appearance") },
  { btn: $("tab-btn-detection"), panel: $("tab-detection") },
  { btn: $("tab-btn-debug"), panel: $("tab-debug") },
];
for (const tab of tabs) {
  tab.btn.addEventListener("click", () => {
    for (const t of tabs) {
      t.btn.classList.toggle("active", t === tab);
      t.panel.hidden = t !== tab;
    }
  });
}

// ---- main controls ----

$("save-key").addEventListener("click", async () => {
  await chrome.storage.local.set({ apiKey: keyInput.value.trim() });
  keySaved.textContent = keyInput.value.trim() ? "key saved" : "key cleared";
});

function renderBackend() {
  backendSelect.value = backend;
  $("gemini-settings").hidden = backend !== "gemini";
  $("local-settings").hidden = backend !== "local";
  // kotoba-whisper-bilingual and FuguMT are JA↔EN models.
  $("lang-th").disabled = backend === "local";
}

backendSelect.addEventListener("change", async () => {
  backend = backendSelect.value;
  const updates = { backend };
  if (backend === "local" && langSelect.value !== "en") {
    langSelect.value = "en";
    updates.targetLang = "en";
  }
  await chrome.storage.local.set(updates);
  renderBackend();
  await loadVadSettings();
  if (!stopBtn.disabled) setStatus("backend change applies on the next Start");
});

$("save-url").addEventListener("click", async () => {
  const url = urlInput.value.trim() || DEFAULT_LOCAL_SERVER_URL;
  if (!/^wss?:\/\//.test(url)) {
    urlSaved.textContent = "must start with ws:// or wss://";
    return;
  }
  urlInput.value = url;
  await chrome.storage.local.set({ localServerUrl: url });
  urlSaved.textContent = "saved (applies on the next Start)";
});

langSelect.addEventListener("change", () => {
  chrome.storage.local.set({ targetLang: langSelect.value });
});

gateCheck.addEventListener("change", () => {
  chrome.storage.local.set({ silenceGate: gateCheck.checked });
});

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  setStatus("starting…");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await chrome.runtime.sendMessage({
    action: "START_CAPTURE",
    tabId: tab?.id,
  });
  if (res?.ok) {
    setRunning(true);
  } else {
    setRunning(false);
    setStatus(res?.error || "failed to start", "error");
  }
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  await chrome.runtime.sendMessage({ action: "STOP_CAPTURE" });
  setRunning(false);
  setStatus("stopped");
});

// ---- appearance tab ----

function renderAppearanceControls() {
  for (const [id, key] of Object.entries(APPEARANCE_CONTROLS)) {
    $(id).value = appearance[key];
  }
  $("font-size-val").textContent = `${appearance.fontSizePx}px`;
  $("outline-width-val").textContent = `${appearance.outlineWidthPx}px`;
  $("bg-opacity-val").textContent = `${appearance.bgOpacity}%`;
}

for (const [id, key] of Object.entries(APPEARANCE_CONTROLS)) {
  $(id).addEventListener("input", () => {
    const el = $(id);
    appearance[key] = el.type === "range" ? Number(el.value) : el.value;
    renderAppearanceControls();
    // The overlay watches storage.onChanged, so this applies live.
    chrome.storage.local.set({ appearance });
  });
}

$("reset-appearance").addEventListener("click", () => {
  appearance = { ...DEFAULT_APPEARANCE };
  renderAppearanceControls();
  chrome.storage.local.set({ appearance });
});

// ---- detection tab ----

async function loadVadSettings() {
  const key = VAD_STORAGE_KEY[backend];
  const { [key]: stored } = await chrome.storage.local.get(key);
  vadSettings = { ...VAD_DEFAULTS[backend], ...(stored || {}) };
  renderVadControls();
}

function renderVadControls() {
  for (const [id, { key, fmt }] of Object.entries(VAD_CONTROLS)) {
    $(id).value = vadSettings[key];
    $(`${id}-val`).textContent = fmt(vadSettings[key]);
  }
}

for (const [id, { key }] of Object.entries(VAD_CONTROLS)) {
  $(id).addEventListener("input", () => {
    vadSettings[key] = Number($(id).value);
    renderVadControls();
    // background relays storage changes to the offscreen document, which
    // re-applies them to the running chunker — live, no reconnect.
    chrome.storage.local.set({ [VAD_STORAGE_KEY[backend]]: vadSettings });
  });
}

$("reset-vad").addEventListener("click", () => {
  vadSettings = { ...VAD_DEFAULTS[backend] };
  renderVadControls();
  chrome.storage.local.set({ [VAD_STORAGE_KEY[backend]]: vadSettings });
});

// ---- debug tab ----

$("clear-log").addEventListener("click", async () => {
  await chrome.storage.session.set({ debugLog: [] });
  renderLog([]);
});

function renderLog(lines) {
  logEl.textContent = lines.length ? lines.join("\n") : "(no events yet)";
  logEl.scrollTop = logEl.scrollHeight;
}

function appendLogLine(line) {
  if (logEl.textContent === "(no events yet)") logEl.textContent = "";
  logEl.textContent +=
    (logEl.textContent ? "\n" : "") +
    `${new Date().toLocaleTimeString()}  ${line}`;
  logEl.scrollTop = logEl.scrollHeight;
}

// ---- live updates from offscreen/background ----

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === "STATUS_UPDATE") {
    const { status, message } = msg.payload || {};
    setStatus(message ? `${status}: ${message}` : status, status);
    appendLogLine(`status: ${status}${message ? ` — ${message}` : ""}`);
    if (status === "error" || status === "stopped") setRunning(false);
  } else if (msg?.action === "COST_UPDATE") {
    renderCost(
      msg.payload?.sessionUsd,
      msg.payload?.totalUsd,
      msg.payload?.audioSeconds,
      msg.payload?.wallSeconds
    );
  } else if (msg?.action === "DEBUG_LOG") {
    appendLogLine(msg.payload?.line || "");
  }
});

function setRunning(running) {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  if (running && !statusEl.textContent) setStatus("running");
}

function setStatus(text, cls = "") {
  statusEl.textContent = text || "";
  statusEl.className = cls === "connected" || cls === "error" ? cls : "";
}

function renderCost(sessionUsd = 0, totalUsd = 0, audioSeconds, wallSeconds) {
  costEl.textContent =
    `this session $${(sessionUsd || 0).toFixed(3)} / ` +
    `total $${(totalUsd || 0).toFixed(3)}`;
  costDetailEl.textContent =
    audioSeconds !== undefined
      ? `${Math.round(audioSeconds)}s audio sent in ${wallSeconds ?? 0}s wall-clock`
      : "";
}
