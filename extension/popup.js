// Popup: API key storage, start/stop, target language, silence gate, and
// the live status/cost readout (offscreen broadcasts reach us directly).

import { DEFAULT_TARGET_LANG } from "./config.js";

const $ = (id) => document.getElementById(id);
const keyInput = $("api-key");
const keySaved = $("key-saved");
const langSelect = $("target-lang");
const gateCheck = $("silence-gate");
const startBtn = $("start");
const stopBtn = $("stop");
const statusEl = $("status");
const costEl = $("cost");

init();

async function init() {
  const {
    apiKey = "",
    silenceGate = true,
    targetLang = DEFAULT_TARGET_LANG,
    totalUsd = 0,
  } = await chrome.storage.local.get([
    "apiKey",
    "silenceGate",
    "targetLang",
    "totalUsd",
  ]);
  if (apiKey) {
    keyInput.value = apiKey;
    keySaved.textContent = "key saved";
  }
  gateCheck.checked = silenceGate;
  langSelect.value = targetLang;
  renderCost(0, totalUsd);

  const state = await chrome.runtime.sendMessage({ action: "GET_STATE" });
  setRunning(!!state?.running);
}

$("save-key").addEventListener("click", async () => {
  await chrome.storage.local.set({ apiKey: keyInput.value.trim() });
  keySaved.textContent = keyInput.value.trim() ? "key saved" : "key cleared";
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === "STATUS_UPDATE") {
    const { status, message } = msg.payload || {};
    setStatus(message ? `${status}: ${message}` : status, status);
    if (status === "error" || status === "stopped") setRunning(false);
  } else if (msg?.action === "COST_UPDATE") {
    renderCost(msg.payload?.sessionUsd, msg.payload?.totalUsd);
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

function renderCost(sessionUsd = 0, totalUsd = 0) {
  costEl.textContent =
    `this session $${(sessionUsd || 0).toFixed(3)} / ` +
    `total $${(totalUsd || 0).toFixed(3)}`;
}
