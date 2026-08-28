// Service worker: owns the capture handshake and message routing. Holds no
// pipeline state — the pipeline lives in the offscreen document, and the last
// status/cost are cached in chrome.storage.session so the popup can render
// instantly after the worker has been suspended.

const OFFSCREEN_URL = "offscreen/offscreen.html";

// Ring buffer of pipeline log lines in chrome.storage.session, surfaced by
// the popup's "Copy debug log" — the offscreen document's own console dies
// with the document, which makes failures invisible without this.
let logWriteChain = Promise.resolve();
function appendLog(line) {
  const stamped = new Date().toISOString().slice(11, 19) + " " + line;
  logWriteChain = logWriteChain
    .then(async () => {
      const { debugLog = [] } = await chrome.storage.session.get("debugLog");
      debugLog.push(stamped);
      if (debugLog.length > 300) debugLog.splice(0, debugLog.length - 300);
      await chrome.storage.session.set({ debugLog });
    })
    .catch(() => {});
  return logWriteChain;
}

async function getCapturedTabId() {
  const { capturedTabId } = await chrome.storage.session.get("capturedTabId");
  return capturedTabId ?? null;
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (!(await hasOffscreenDocument())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA"],
      justification: "Capture tab audio for live subtitle translation",
    });
  }
  // Wait until the document's scripts have loaded and its message listener
  // answers — a start command sent too early gets no response (the open
  // popup's own listener makes sendMessage resolve undefined instead of
  // rejecting, which used to surface as a generic failure).
  for (let i = 0; i < 40; i++) {
    try {
      const pong = await chrome.runtime.sendMessage({ target: "offscreen", type: "ping" });
      if (pong?.ok) return;
    } catch (e) {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Offscreen audio document failed to initialize.");
}

async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/overlay.js"],
    });
  } catch (e) {
    // chrome:// pages, the Web Store, etc. — capture still works, but there
    // is nowhere to draw subtitles.
    console.warn("HoloTL: overlay injection failed:", e.message);
    throw new Error(
      "Cannot show subtitles on this page (restricted URL). Try a normal website tab."
    );
  }
}

async function setStatus(state, message = "") {
  await chrome.storage.session.set({ lastStatus: { state, message, ts: Date.now() } });
  // Broadcast for a live popup; ignore "no receiver" errors.
  chrome.runtime
    .sendMessage({ target: "ui", type: "status", payload: { state, message } })
    .catch(() => {});
}

async function startCapture() {
  if (await getCapturedTabId()) {
    throw new Error("Already capturing a tab. Stop first.");
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");
  appendLog(`[sw] start requested for tab "${(tab.title || "").slice(0, 40)}"`);

  // Offscreen document must exist BEFORE we mint the stream id — ids expire
  // within seconds and must be redeemed promptly.
  await ensureOffscreenDocument();
  await injectOverlay(tab.id);

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });

  // Offscreen documents can't touch chrome.storage — hand them the settings.
  const settings = await chrome.storage.local.get(null);
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "start-capture",
    payload: { streamId, tabId: tab.id, settings },
  });
  if (!response?.ok) {
    appendLog(
      `[sw] start FAILED: ${response?.error || "no response from offscreen (" + JSON.stringify(response) + ")"}`
    );
    await teardown("dead", response?.error || "Failed to start audio capture.");
    throw new Error(response?.error || "Failed to start audio capture.");
  }
  appendLog("[sw] capture started ok");

  await chrome.storage.session.set({
    capturedTabId: tab.id,
    capturedTabTitle: tab.title || "",
  });
  await setStatus("capturing", tab.title || "");
  return { tabId: tab.id, title: tab.title };
}

async function teardown(finalState = "stopped", message = "") {
  appendLog(`[sw] teardown (${finalState}${message ? ": " + message : ""})`);
  const tabId = await getCapturedTabId();

  if (await hasOffscreenDocument()) {
    try {
      await chrome.runtime.sendMessage({ target: "offscreen", type: "stop-capture" });
    } catch (e) {
      /* offscreen already gone */
    }
    try {
      await chrome.offscreen.closeDocument();
    } catch (e) {
      /* already closed */
    }
  }

  if (tabId != null) {
    chrome.tabs
      .sendMessage(tabId, {
        target: "content",
        type: finalState === "dead" ? "engine-dead" : "session-ended",
        payload: { message },
      })
      .catch(() => {});
  }

  await chrome.storage.session.remove(["capturedTabId", "capturedTabTitle"]);
  await setStatus(finalState, message);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "sw") return false;

  (async () => {
    switch (msg.type) {
      case "start": {
        try {
          const info = await startCapture();
          sendResponse({ ok: true, ...info });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }
      case "stop": {
        await teardown("stopped");
        sendResponse({ ok: true });
        break;
      }
      case "subtitle": {
        const tabId = await getCapturedTabId();
        if (tabId != null) {
          chrome.tabs
            .sendMessage(tabId, { target: "content", type: "subtitle", payload: msg.payload })
            .catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }
      case "engine-status": {
        // Offscreen reports engine state transitions (cooldown / dead / ok).
        const { state, message } = msg.payload;
        if (state === "dead") {
          await teardown("dead", message);
        } else {
          await setStatus(state, message);
        }
        sendResponse({ ok: true });
        break;
      }
      case "cost-update": {
        await chrome.storage.session.set({ sessionCost: msg.payload });
        sendResponse({ ok: true });
        break;
      }
      case "log": {
        appendLog(msg.payload.line);
        sendResponse({ ok: true });
        break;
      }
      case "bank-totals": {
        // Offscreen can't write storage; it sends the merged totals here.
        await chrome.storage.local.set({ totals: msg.payload });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message: " + msg.type });
    }
  })();
  return true; // async sendResponse
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === (await getCapturedTabId())) {
    await teardown("stopped", "Captured tab was closed.");
  }
});

// Forward live settings edits (VAD sliders, rpm, prices, mode) to the running
// pipeline — the offscreen document can't observe chrome.storage itself.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (changes.totals && Object.keys(changes).length === 1) return; // our own bank write
  if ((await getCapturedTabId()) == null) return;
  if (!(await hasOffscreenDocument())) return;
  const settings = await chrome.storage.local.get(null);
  chrome.runtime
    .sendMessage({ target: "offscreen", type: "settings-changed", payload: settings })
    .catch(() => {});
});

// In-tab navigation destroys the injected overlay (capture keeps running) —
// re-inject when the captured tab finishes loading a new page.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  if (tabId !== (await getCapturedTabId())) return;
  try {
    await injectOverlay(tabId);
  } catch (e) {
    /* restricted page after navigation; nothing to draw on */
  }
});
