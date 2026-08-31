// MV3 service worker: orchestrates start/stop, owns the offscreen document,
// and relays subtitle/status messages from the offscreen document to the
// captured tab's overlay (content scripts can't receive runtime broadcasts).

import { DEBUG_FAKE_SUBTITLES, DEFAULT_TARGET_LANG } from "./config.js";

let activeTabId = null;
let running = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.action) {
    case "START_CAPTURE":
      startCapture(msg.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case "STOP_CAPTURE":
      stopCapture()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case "GET_STATE":
      sendResponse({ running, tabId: activeTabId });
      return;
    case "UPDATE_SUBTITLES":
      relayToTab(msg);
      return;
    case "COST_UPDATE":
      // Offscreen documents can't use chrome.storage; persist for them.
      if (typeof msg.payload?.totalUsd === "number") {
        chrome.storage.local.set({ totalUsd: msg.payload.totalUsd });
      }
      return;
    case "DEBUG_LOG":
      appendDebugLog(msg.payload?.line);
      return;
    case "STATUS_UPDATE":
      relayToTab(msg);
      appendDebugLog(
        `status: ${msg.payload?.status}` +
          (msg.payload?.message ? ` — ${msg.payload.message}` : "")
      );
      if (msg.payload?.status === "error" && running) {
        // Reconnect cutoff or capture failure — tear down so the popup shows
        // Start again and the offscreen document doesn't linger.
        stopCapture({ silent: true }).catch(() => {});
      }
      return;
  }
});

async function startCapture(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("No target tab");
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
  if (!apiKey && !DEBUG_FAKE_SUBTITLES) {
    throw new Error("Save your Gemini API key first");
  }

  // Overlay first (activeTab was granted by the popup click). Restricted
  // pages (chrome://, Web Store) can't render subtitles; capture still works.
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content/overlay.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/overlay.js"],
    });
  } catch (e) {
    console.warn("[HoloTL Live] overlay injection failed:", e.message);
  }

  const streamId = DEBUG_FAKE_SUBTITLES
    ? null
    : await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  await ensureOffscreenDocument();
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    action: "OFFSCREEN_START",
    streamId,
    apiKey,
    settings: { silenceGate, targetLang },
    baseTotalUsd: totalUsd,
  });
  if (res && res.ok === false) throw new Error(res.error || "capture failed");

  activeTabId = tabId;
  running = true;
  appendDebugLog(`capture started on tab ${tabId}`);
}

async function stopCapture({ silent = false } = {}) {
  if (running) appendDebugLog("capture stopped");
  running = false;
  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "OFFSCREEN_STOP",
    });
  } catch {
    /* offscreen already gone */
  }
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* not open */
  }
  if (!silent) {
    relayToTab({
      action: "STATUS_UPDATE",
      payload: { status: "stopped" },
    });
  }
  activeTabId = null;
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification:
      "Capture tab audio and stream it to the Gemini Live API for subtitles",
  });
}

// Rolling debug log (popup Debug tab). chrome.storage.session survives the
// service worker idling but clears when the browser closes — right scope
// for diagnostics. Serialized through a promise chain so concurrent
// appends don't drop lines.
const DEBUG_LOG_MAX = 100;
let debugLogChain = Promise.resolve();
function appendDebugLog(line) {
  if (!line) return;
  debugLogChain = debugLogChain.then(async () => {
    const { debugLog = [] } = await chrome.storage.session.get("debugLog");
    debugLog.push(`${new Date().toLocaleTimeString()}  ${line}`);
    await chrome.storage.session.set({
      debugLog: debugLog.slice(-DEBUG_LOG_MAX),
    });
  });
}

function relayToTab(msg) {
  if (activeTabId === null) return;
  chrome.tabs.sendMessage(activeTabId, msg).catch(() => {
    /* tab navigated or closed — overlay will be re-injected on next Start */
  });
}

// Live-applied settings (silence gate toggle, target language). API key
// changes apply on the next Start.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !running) return;
  const settings = {};
  if (changes.silenceGate) settings.silenceGate = changes.silenceGate.newValue;
  if (changes.targetLang) settings.targetLang = changes.targetLang.newValue;
  if (Object.keys(settings).length === 0) return;
  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "SETTINGS_CHANGED",
      settings,
    });
  } catch {
    /* offscreen gone */
  }
});
