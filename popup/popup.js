// Popup: settings editor + session dashboard. Reads/writes
// chrome.storage.local directly; live status/cost come from
// chrome.storage.session (cached by the service worker) plus broadcast
// runtime messages while the popup is open.

const $ = (id) => document.getElementById(id);

const NUMERIC_FIELDS = [
  "rpm",
  "priceInPer1M",
  "priceOutPer1M",
  "vadThreshold",
  "volumeThreshold",
  "silenceTimeoutS",
  "maxChunkS",
  "minSpeechS",
  "fontSizePx",
  "autoHideS",
];
const TEXT_FIELDS = ["apiKey", "geminiModel"];
const CHECK_FIELDS = ["includeRoster", "enhanceAudio"];
const RADIO_FIELDS = ["outputMode"];

let capturing = false;

function fmtUsd(v, digits = 4) {
  return "$" + (v || 0).toFixed(digits);
}

function updateSliderOutputs() {
  document.querySelectorAll(".row.slider").forEach((row) => {
    const input = row.querySelector("input[type=range]");
    const output = row.querySelector("output");
    if (input && output) output.textContent = input.value;
  });
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(null);
  const s = HOLOTL.clampSettings({ ...HOLOTL.DEFAULT_SETTINGS, ...stored });

  for (const id of TEXT_FIELDS) $(id).value = s[id] ?? "";
  for (const id of NUMERIC_FIELDS) $(id).value = s[id];
  for (const id of CHECK_FIELDS) $(id).checked = !!s[id];
  for (const name of RADIO_FIELDS) {
    document.querySelector(`input[name=${name}][value="${s[name]}"]`).checked = true;
  }
  updateSliderOutputs();
  renderTotals(s.totals);
  updateStartAvailability();
}

function renderTotals(totals) {
  $("totalUsd").textContent = fmtUsd(totals?.usd ?? 0, 2);
}

function renderSessionCost(c) {
  $("sessionUsd").textContent = fmtUsd(c?.usd ?? 0);
  $("sessionReqs").textContent = String(c?.requests ?? 0);
  $("sessionTokens").textContent = `${c?.inTokens ?? 0} in / ${c?.outTokens ?? 0} out tokens`;
}

function renderStatus(status) {
  const state = status?.state || "idle";
  const message = status?.message || "";
  const dot = $("statusDot");
  const text = $("statusText");
  dot.className = "dot";
  switch (state) {
    case "capturing":
      capturing = true;
      dot.classList.add("capturing");
      text.textContent = message ? `Capturing: ${message}` : "Capturing";
      break;
    case "cooldown":
      capturing = true;
      dot.classList.add("cooldown");
      text.textContent = message || "Cooling down";
      break;
    case "dead":
      capturing = false;
      dot.classList.add("dead");
      text.textContent = message || "Engine stopped";
      text.title = message || "";
      break;
    default:
      capturing = false;
      dot.classList.add("idle");
      text.textContent = "Idle";
  }
  $("toggleBtn").textContent = capturing ? "Stop captioning" : "Start captioning this tab";
  $("toggleBtn").classList.toggle("stop", capturing);
  updateStartAvailability();
}

function updateStartAvailability() {
  const hasKey = $("apiKey").value.trim().length > 0;
  $("toggleBtn").disabled = !capturing && !hasKey;
  $("startHint").classList.toggle("hidden", capturing || hasKey);
}

async function refreshLiveState() {
  const { lastStatus, sessionCost, capturedTabId, debugLog } = await chrome.storage.session.get([
    "lastStatus",
    "sessionCost",
    "capturedTabId",
    "debugLog",
  ]);
  renderDebugLog(debugLog);
  // A cached "capturing" status is only valid while a tab is actually held.
  if (capturedTabId == null && lastStatus?.state === "capturing") {
    renderStatus({ state: "idle" });
  } else {
    renderStatus(lastStatus);
  }
  renderSessionCost(sessionCost);
}

// --- persistence -----------------------------------------------------------

let saveTimer = null;
function saveSettings() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const patch = {};
    for (const id of TEXT_FIELDS) patch[id] = $(id).value.trim();
    for (const id of NUMERIC_FIELDS) patch[id] = Number($(id).value);
    for (const id of CHECK_FIELDS) patch[id] = $(id).checked;
    for (const name of RADIO_FIELDS) {
      patch[name] = document.querySelector(`input[name=${name}]:checked`).value;
    }
    await chrome.storage.local.set(HOLOTL.clampSettings(patch));
  }, 250);
}

// --- wiring ----------------------------------------------------------------

document.addEventListener("input", (e) => {
  if (e.target.matches("input")) {
    updateSliderOutputs();
    updateStartAvailability();
    saveSettings();
  }
});

$("keyReveal").addEventListener("click", (e) => {
  e.preventDefault();
  const input = $("apiKey");
  input.type = input.type === "password" ? "text" : "password";
});

$("toggleBtn").addEventListener("click", async () => {
  $("toggleBtn").disabled = true;
  try {
    if (capturing) {
      await chrome.runtime.sendMessage({ target: "sw", type: "stop" });
    } else {
      const res = await chrome.runtime.sendMessage({ target: "sw", type: "start" });
      if (!res?.ok) {
        renderStatus({ state: "dead", message: res?.error || "Failed to start." });
        return;
      }
    }
  } finally {
    $("toggleBtn").disabled = false;
    await refreshLiveState();
  }
});

$("resetPos").addEventListener("click", () => chrome.storage.local.set({ overlayPos: null }));

$("resetTotals").addEventListener("click", async () => {
  await chrome.storage.local.set({ totals: { usd: 0, requests: 0, inTokens: 0, outTokens: 0 } });
  renderTotals({ usd: 0 });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "ui") return;
  if (msg.type === "level") {
    const pct = Math.min(100, (msg.payload?.rms ?? 0) * 800);
    $("levelBar").style.width = pct + "%";
  } else if (msg.type === "status") {
    renderStatus(msg.payload);
  }
});

function renderDebugLog(lines) {
  if (!lines?.length) return;
  const el = $("debugLog");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  el.textContent = lines.slice(-60).join("\n");
  if (atBottom) el.scrollTop = el.scrollHeight;
}

$("copyLog").addEventListener("click", async () => {
  const { debugLog = [] } = await chrome.storage.session.get("debugLog");
  await navigator.clipboard.writeText(debugLog.join("\n") || "(empty)");
  $("copyLog").textContent = "Copied!";
  setTimeout(() => ($("copyLog").textContent = "Copy debug log"), 1200);
});

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.sessionCost) renderSessionCost(changes.sessionCost.newValue);
  if (changes.lastStatus) renderStatus(changes.lastStatus.newValue);
  if (changes.debugLog) renderDebugLog(changes.debugLog.newValue);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.totals) renderTotals(changes.totals.newValue);
});

loadSettings().then(refreshLiveState);
