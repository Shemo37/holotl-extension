// Offscreen document orchestrator: redeems the tab-capture stream id, then
// runs the pipeline over the worklet's 512-sample 16 kHz frames:
// Silero VAD chunking → enhancement → drop-oldest queue → one Gemini
// generateContent call per utterance → string filters → subtitle messages.
//
// NOTE: offscreen documents only have access to the chrome.runtime messaging
// APIs — chrome.storage is undefined here. Settings arrive in the
// start-capture payload (and via "settings-changed" messages); totals are
// banked by messaging the service worker, which owns all storage access.

let state = null; // active session or null

function sendToSw(type, payload) {
  return chrome.runtime.sendMessage({ target: "sw", type, payload }).catch(() => {});
}

function sendToUi(type, payload) {
  return chrome.runtime.sendMessage({ target: "ui", type, payload }).catch(() => {});
}

// Mirror console output to the service worker's ring buffer so the popup's
// "Copy debug log" works without opening DevTools on this document (which
// only exists while a session runs).
for (const level of ["log", "warn", "error"]) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    try {
      const line = args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a).slice(0, 400);
          } catch (e) {
            return String(a);
          }
        })
        .join(" ");
      sendToSw("log", { line: `[off/${level}] ${line}` });
    } catch (e) {
      /* never let logging break the pipeline */
    }
  };
}

// ---------------------------------------------------------------------------

let sileroVadPromise = null;
function getSileroVad() {
  // Load once per document lifetime; VAD state is reset per session.
  if (!sileroVadPromise) {
    sileroVadPromise = (async () => {
      try {
        const vad = new SileroVad();
        await vad.load();
        console.log("🎙️ Silero VAD model loaded (onnxruntime-web).");
        return vad;
      } catch (e) {
        console.warn("⚠️ Failed to load Silero VAD, using volume-based detection:", e);
        return null;
      }
    })();
  }
  return sileroVadPromise;
}

async function startCapture({ streamId, tabId, settings: rawSettings }) {
  if (state) throw new Error("Capture already running.");

  const settings = HOLOTL.clampSettings({ ...HOLOTL.DEFAULT_SETTINGS, ...rawSettings });
  if (!settings.apiKey) throw new Error("No Gemini API key configured.");

  // Redeem the stream id FIRST — it expires within seconds, so it must not
  // wait behind the VAD model load.
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });
  } catch (e) {
    const name = (e && (e.name || e.message)) || String(e);
    throw new Error(
      `Tab capture failed (${name}). Reload the page and try Start again ` +
        `while the tab is focused.`
    );
  }

  const ctx = new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  // Capturing mutes the tab for the user — route the stream back to the
  // speakers FIRST, before anything else can fail.
  source.connect(ctx.destination);

  await ctx.audioWorklet.addModule("pcm-worklet.js");
  const workletNode = new AudioWorkletNode(ctx, "pcm-capture");
  source.connect(workletNode);

  let vad;
  try {
    vad = await getSileroVad();
  } catch (e) {
    vad = null;
  }
  if (vad) vad.reset();

  state = {
    settings,
    stream,
    ctx,
    client: null,
    queue: null,
    chunker: null,
    deliveredHistory: [],
    baselineTotals: settings.totals,
    persistTimer: null,
    stopping: false,
    scheduleTotalsPersist() {
      if (this.persistTimer) return;
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        persistTotals();
      }, 5000);
    },
  };

  const queue = new ChunkQueue();
  const client = new GeminiClient(settings, {
    onCost: (session) => {
      sendToSw("cost-update", session);
      state?.scheduleTotalsPersist();
    },
    onCooldown: (seconds) =>
      sendToSw("engine-status", {
        state: "cooldown",
        message: `Rate limited — cooling down ${seconds}s`,
      }),
  });

  const chunker = new DynamicChunker(
    vad,
    settings,
    (chunk) => {
      if (state?.settings.enhanceAudio) chunk = enhanceAudioQuality(chunk);
      queue.putLatest({ samples: chunk, durationS: chunk.length / HOLOTL.SAMPLE_RATE });
    },
    (rms) => sendToUi("level", { rms })
  );

  workletNode.port.onmessage = (e) => chunker.push(new Float32Array(e.data));

  state.queue = queue;
  state.client = client;
  state.chunker = chunker;
  runConsumerLoop(); // fire and forget

  console.log(
    `🎙️ Capture started for tab ${tabId} (output: ${settings.outputMode}, ` +
      `model: ${settings.geminiModel}).`
  );
}

// Requests overlap so a slow model doesn't throttle throughput: chunks
// arrive every ~4.5s, and a non-lite model at 10-30s/response can only keep
// up if several chunks are in flight at once. Results are delivered in
// chunk order regardless of completion order.
async function runConsumerLoop() {
  const { queue, client } = state;
  const maxInflight = /lite/i.test(client.model) ? 2 : 6;
  const inflight = new Set();
  const results = new Map();
  let seq = 0;
  let nextToDeliver = 0;
  let dead = null;

  // handleChunkedResponse can await an EN-repair call — chain deliveries so
  // subtitles still render strictly in chunk order.
  let deliverChain = Promise.resolve();
  const deliverReady = () => {
    while (results.has(nextToDeliver)) {
      const r = results.get(nextToDeliver);
      results.delete(nextToDeliver);
      nextToDeliver++;
      if (r !== null) {
        deliverChain = deliverChain
          .then(() => (state ? handleChunkedResponse(r.text, r.timing) : null))
          .catch((e) => console.error("🔴 Subtitle delivery error:", e));
      }
    }
  };

  const die = async (e) => {
    if (dead) return;
    dead = e;
    queue.close();
    if (e.name === "GeminiDead") {
      console.error("💀 Gemini engine dead:", e.message);
    } else {
      console.error("🔴 Consumer loop error:", e);
    }
    await persistTotals();
    sendToSw("engine-status", {
      state: "dead",
      message: e.name === "GeminiDead" ? e.message : `Pipeline error: ${e.message}`,
    });
  };

  while (!dead) {
    while (inflight.size >= maxInflight) await Promise.race(inflight);
    const item = await queue.take();
    if (item === null) break; // queue closed — session over

    const wavBase64 = encodeWavBase64(item.samples);
    const id = seq++;
    console.log(
      `📤 sending ${item.durationS.toFixed(1)}s chunk ` +
        `(${inflight.size} in flight, ${queue.items.length} queued behind)`
    );
    const p = (async () => {
      try {
        const res = await client.transcribeChunk(wavBase64, item.durationS);
        results.set(
          id,
          res === null
            ? null // cooldown or transient failure: chunk dropped
            : { text: res.text, timing: { fetchMs: res.fetchMs, waitMs: res.waitMs, queued: queue.items.length } }
        );
      } catch (e) {
        results.set(id, null);
        await die(e);
      } finally {
        inflight.delete(p);
      }
      deliverReady();
    })();
    inflight.add(p);
  }
  await Promise.allSettled([...inflight]);
  deliverReady();
}

async function handleChunkedResponse(rawText, timing) {
  const { settings, deliveredHistory } = state;
  const hasJapanese = (s) => /[぀-ヿ一-鿿]/.test(s);
  const timingStr =
    `[api ${(timing.fetchMs / 1000).toFixed(1)}s` +
    (timing.waitMs > 100 ? `, ratelimit +${(timing.waitMs / 1000).toFixed(1)}s` : "") +
    (timing.queued ? `, ${timing.queued} queued` : "") +
    `]`;
  const text = stripDecorations(rawText);
  if (!text) {
    // Gemini decided there's no speech — correct on music/silence, but log
    // it so "no subtitles" is distinguishable from "no responses".
    console.log(`🕳️ no speech in chunk ${timingStr}`);
    return;
  }

  let ja = null;
  let en = null;

  if (settings.outputMode === "both") {
    const lines = text.split("\n").map((l) => stripDecorations(l)).filter(Boolean);
    if (lines.length >= 2) {
      ja = lines[0];
      en = lines.slice(1).join(" ");
    } else if (lines.length === 1) {
      if (hasJapanese(lines[0])) ja = lines[0];
      else en = lines[0];
    }
  } else if (settings.outputMode === "transcribe") {
    ja = text;
  } else {
    // translate mode — but the model occasionally answers in Japanese
    // (untranslated); treat that as a transcription needing repair.
    if (hasJapanese(text)) ja = text;
    else en = text;
  }

  if (ja) {
    ja = trimDegenerateTail(ja);
    // JA line checks against an empty history (mirrors the desktop app: the
    // JP line is never dedup-filtered against the EN history).
    if (isHallucination(ja, [])) ja = null;
  }
  if (en) {
    en = trimDegenerateTail(en);
    if (en) en = postProcessTranslation(en);
    if (!en || isHallucination(en, deliveredHistory)) en = null;
  }

  // In transcribe mode the JA line is the main line — dedup it vs history.
  if (settings.outputMode === "transcribe" && ja) {
    if (isHallucination(ja, deliveredHistory)) ja = null;
  }

  // The model sometimes skips the English line (both mode) or answers in
  // Japanese (translate mode) — repair with a quick text-only translation.
  if (settings.outputMode !== "transcribe" && ja && !en) {
    const repaired = await state.client.translateText(ja);
    if (!state) return; // stopped while repairing
    if (repaired) {
      let t = stripDecorations(repaired);
      t = trimDegenerateTail(t);
      if (t) t = postProcessTranslation(t);
      if (t && !isHallucination(t, deliveredHistory)) {
        en = t;
        console.log("🩹 EN repaired via text call");
      }
    }
    // translate mode shows English only — keep JA visible just as the
    // fallback when repair failed.
    if (settings.outputMode === "translate" && en) ja = null;
  }

  if (!ja && !en) {
    console.log(`🚫 filtered out: "${text.slice(0, 40)}" ${timingStr}`);
    return;
  }

  const mainLine = settings.outputMode === "transcribe" ? ja : en;
  if (mainLine) {
    deliveredHistory.push(mainLine);
    if (deliveredHistory.length > 10) deliveredHistory.shift();
  }

  console.log(`💬 subtitle: "${(mainLine || ja || "").slice(0, 40)}" ${timingStr}`);
  sendToSw("subtitle", { ja, en, ts: Date.now() });
}

// --- shared ----------------------------------------------------------------

function persistTotals() {
  if (!state) return Promise.resolve();
  const base = state.baselineTotals || HOLOTL.DEFAULT_SETTINGS.totals;
  const s = state.client?.session;
  if (!s) return Promise.resolve();
  // The service worker writes this to chrome.storage.local (unavailable here).
  return sendToSw("bank-totals", {
    usd: (base.usd || 0) + s.usd,
    requests: (base.requests || 0) + s.requests,
    inTokens: (base.inTokens || 0) + s.inTokens,
    outTokens: (base.outTokens || 0) + s.outTokens,
  });
}

async function stopCapture() {
  if (!state || state.stopping) return;
  state.stopping = true;
  try {
    if (state.persistTimer) clearTimeout(state.persistTimer);
    state.queue?.close();
    state.stream.getTracks().forEach((t) => t.stop());
    await state.ctx.close().catch(() => {});
    await persistTotals();
  } finally {
    state = null;
  }
  console.log("🎙️ Capture stopped.");
}

// Live-tunable settings (VAD sliders, rpm, prices, mode, roster toggle),
// forwarded by the service worker on chrome.storage.onChanged. API key /
// model changes require a session restart, documented in the popup.
function applyLiveSettings(rawSettings) {
  if (!state) return;
  const settings = HOLOTL.clampSettings({ ...HOLOTL.DEFAULT_SETTINGS, ...rawSettings });
  state.settings.outputMode = settings.outputMode;
  state.settings.enhanceAudio = settings.enhanceAudio;
  state.chunker?.applySettings(settings);
  state.client?.applySettings({
    ...settings,
    apiKey: state.settings.apiKey,
    geminiModel: state.client.model,
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  (async () => {
    try {
      switch (msg.type) {
        case "ping":
          sendResponse({ ok: true });
          break;
        case "start-capture":
          await startCapture(msg.payload);
          sendResponse({ ok: true });
          break;
        case "stop-capture":
          await stopCapture();
          sendResponse({ ok: true });
          break;
        case "settings-changed":
          applyLiveSettings(msg.payload);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "Unknown message: " + msg.type });
      }
    } catch (e) {
      console.error("🔴 Offscreen error:", e);
      const detail = (e && (e.message || e.name)) || String(e);
      sendResponse({ ok: false, error: detail });
    }
  })();
  return true;
});

// Warm the VAD model as soon as the document loads so a Start never waits
// behind the ~1s ONNX/wasm load.
getSileroVad();
