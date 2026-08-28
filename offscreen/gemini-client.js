// Gemini generateContent client: one request per VAD chunk, with a blocking
// min-interval rate limiter, the DeepL-style error taxonomy from the desktop
// app (429 handling extended per the Gemini design doc), and a token-based
// cost meter fed by usageMetadata.

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const MAX_CONSECUTIVE_FAILURES = 3;

class GeminiDead extends Error {
  constructor(message) {
    super(message);
    this.name = "GeminiDead";
  }
}

class GeminiClient {
  /**
   * settings: {apiKey, geminiModel, outputMode, rpm, priceInPer1M,
   *            priceOutPer1M, includeRoster}
   * onCost(sessionStats), onCooldown(seconds) are optional callbacks.
   */
  constructor(settings, { onCost, onCooldown } = {}) {
    this.applySettings(settings);
    this.onCost = onCost;
    this.onCooldown = onCooldown;

    this.lastRequestStart = 0;
    this.cooldownUntil = 0;
    this.consecutiveFailures = 0;
    this.session = { requests: 0, inTokens: 0, outTokens: 0, usd: 0 };
  }

  applySettings(s) {
    this.apiKey = s.apiKey;
    this.model = s.geminiModel;
    this.outputMode = s.outputMode;
    this.minIntervalMs = 60000 / Math.min(60, Math.max(1, s.rpm));
    this.priceInPer1M = s.priceInPer1M;
    this.priceOutPer1M = s.priceOutPer1M;
    this.includeRoster = s.includeRoster;
  }

  buildPrompt() {
    let prompt = HOLOTL.PROMPTS[this.outputMode] || HOLOTL.PROMPTS.translate;
    if (this.includeRoster) {
      prompt += HOLOTL.PROMPTS.rosterSuffix(HOLOTL.ROSTER_JP);
    }
    return prompt;
  }

  get inCooldown() {
    return Date.now() < this.cooldownUntil;
  }

  // Serializes request *spacing* while allowing overlapping flight — with
  // concurrent callers, each acquires the next dispatch slot in turn.
  async rateLimit() {
    const prev = this._rlChain || Promise.resolve();
    let release;
    this._rlChain = new Promise((r) => (release = r));
    await prev;
    try {
      const wait = this.lastRequestStart + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequestStart = Date.now();
    } finally {
      release();
    }
  }

  /**
   * Transcribe/translate one chunk. Returns {text, fetchMs, waitMs} on a
   * response ('' text when Gemini decided there is no speech), or null when
   * the chunk was skipped (cooldown, transient error). Throws GeminiDead
   * when the engine is done for the session. Safe to call concurrently —
   * dispatch spacing is serialized by rateLimit(), flight overlaps.
   */
  async transcribeChunk(wavBase64, chunkSeconds) {
    if (this.inCooldown) return null; // silent skip, chunk dropped

    const callStart = performance.now();
    await this.rateLimit();
    const waitMs = performance.now() - callStart;

    // Thinking burns seconds per chunk and adds nothing to transcription.
    // Gemini 3 models take thinkingLevel; 2.5-era models take thinkingBudget
    // and IGNORE thinkingLevel-style config. Walk the ladder once and
    // remember what the model accepted.
    const generationConfig = { temperature: 0 };
    if (this.thinkingMode === undefined) {
      // Walk the ladder for every model, lite included: explicitly asking
      // for minimal thinking can only reduce it, and a lite model that
      // ships with dynamic thinking on would otherwise silently cost
      // seconds per call. Note Gemini 3 non-lite Flash can NOT fully
      // disable thinking ("low" is its floor — measured 12-30s/chunk on
      // gemini-3.7-flash); the concurrency in the consumer loop absorbs
      // that as delay instead of dropped audio.
      this.thinkingMode = "minimal";
    }
    if (this.thinkingMode === "minimal") {
      generationConfig.thinkingConfig = { thinkingLevel: "minimal" };
    } else if (this.thinkingMode === "level") {
      generationConfig.thinkingConfig = { thinkingLevel: "low" };
    } else if (this.thinkingMode === "budget") {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const fetchStart = performance.now();
    // A hung request must not stall the pipeline silently — abort hard.
    // 45s: non-lite models with thinking at its floor have been measured
    // near 30s on hard audio; aborting those would strike a working session.
    const abort = new AbortController();
    const abortTimer = setTimeout(() => abort.abort(), 45000);
    let response;
    try {
      response = await fetch(
        GEMINI_BASE + encodeURIComponent(this.model) + ":generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: this.buildPrompt() },
                  { inline_data: { mime_type: "audio/wav", data: wavBase64 } },
                ],
              },
            ],
            generationConfig,
          }),
          signal: abort.signal,
        }
      );
    } catch (e) {
      return this._strike(
        e.name === "AbortError" ? "Request timed out after 45s" : `Network error: ${e.message}`
      );
    } finally {
      clearTimeout(abortTimer);
    }
    const fetchMs = performance.now() - fetchStart;

    if (response.status === 400 && this.thinkingMode !== "none") {
      let why = "";
      try {
        why = (await response.clone().json())?.error?.message || "";
      } catch (e) {
        /* non-JSON body */
      }
      const next = { minimal: "level", level: "budget", budget: "none" }[this.thinkingMode];
      console.warn(
        `⚠️ Model rejected thinking config "${this.thinkingMode}" — trying "${next}". API said: ${why}`
      );
      this.thinkingMode = next;
      return this.transcribeChunk(wavBase64, chunkSeconds);
    }

    if (!response.ok) {
      let errorBody = null;
      try {
        errorBody = await response.json();
      } catch (e) {
        /* non-JSON error body */
      }
      return this._handleHttpError(response.status, errorBody);
    }

    let body;
    try {
      body = await response.json();
    } catch (e) {
      return this._strike("Malformed JSON response from Gemini");
    }

    this.consecutiveFailures = 0;
    const text =
      body?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || "")
        .join("") ?? "";
    this._accountCost(body.usageMetadata, chunkSeconds, text);
    return { text, fetchMs, waitMs };
  }

  _handleHttpError(status, body) {
    const apiMessage = body?.error?.message || "";
    if (status === 429) {
      if (this._isDailyQuota(body)) {
        throw new GeminiDead(
          "Gemini daily quota exhausted for this API key. Try again tomorrow or upgrade the key."
        );
      }
      const seconds = this._retryDelaySeconds(body);
      this.cooldownUntil = Date.now() + seconds * 1000;
      console.warn(`⏳ Gemini rate-limited; cooling down ${seconds}s`);
      if (this.onCooldown) this.onCooldown(seconds);
      return null;
    }
    if (status === 401 || status === 403) {
      throw new GeminiDead(`Gemini API key rejected (HTTP ${status}). ${apiMessage}`);
    }
    if (status === 404) {
      throw new GeminiDead(
        `Gemini model "${this.model}" not found (HTTP 404). Check the model id in settings.`
      );
    }
    return this._strike(`Gemini HTTP ${status}: ${apiMessage || "unknown error"}`);
  }

  _isDailyQuota(body) {
    const details = body?.error?.details || [];
    for (const d of details) {
      for (const v of d.violations || []) {
        const id = `${v.quotaId || ""} ${v.quotaMetric || ""}`;
        if (/perday|per_day|daily/i.test(id)) return true;
      }
    }
    return /per day|daily/i.test(body?.error?.message || "");
  }

  _retryDelaySeconds(body) {
    const details = body?.error?.details || [];
    for (const d of details) {
      if (d["@type"]?.includes("RetryInfo") && d.retryDelay) {
        const s = parseFloat(String(d.retryDelay).replace(/s$/i, ""));
        if (Number.isFinite(s)) return Math.min(30, Math.max(5, s));
      }
    }
    return 10;
  }

  _strike(message) {
    this.consecutiveFailures++;
    console.warn(
      `🔴 Gemini failure ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}: ${message}`
    );
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      throw new GeminiDead(`Gemini failed ${MAX_CONSECUTIVE_FAILURES} times in a row: ${message}`);
    }
    return null;
  }

  _accountCost(usage, chunkSeconds, text) {
    // Real token counts when the API provides them; estimates otherwise
    // (32 audio tokens/sec is the documented audio billing rate).
    const inTok =
      usage?.promptTokenCount ?? Math.ceil(chunkSeconds * HOLOTL.AUDIO_TOKENS_PER_SECOND);
    const outTok =
      usage?.candidatesTokenCount ?? Math.ceil(text.length / HOLOTL.OUTPUT_CHARS_PER_TOKEN);

    this.session.requests += 1;
    this.session.inTokens += inTok;
    this.session.outTokens += outTok;
    this.session.usd +=
      (inTok * this.priceInPer1M + outTok * this.priceOutPer1M) / 1e6;

    if (this.onCost) this.onCost({ ...this.session });
  }
}
