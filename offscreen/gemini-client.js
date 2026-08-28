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

  async rateLimit() {
    const wait = this.lastRequestStart + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestStart = Date.now();
  }

  /**
   * Transcribe/translate one chunk. Returns the raw response text ('' when
   * Gemini decided there is no speech), or null when the chunk was skipped
   * (cooldown, transient error). Throws GeminiDead when the engine is done
   * for the session.
   */
  async transcribeChunk(wavBase64, chunkSeconds) {
    if (this.inCooldown) return null; // silent skip, chunk dropped

    const callStart = performance.now();
    await this.rateLimit();
    this.lastWaitMs = performance.now() - callStart;

    // Thinking burns seconds per chunk and adds nothing to transcription.
    // Gemini 3 models take thinkingLevel; 2.5-era models take thinkingBudget
    // and IGNORE thinkingLevel-style config. Walk the ladder once and
    // remember what the model accepted.
    const generationConfig = { temperature: 0 };
    if (this.thinkingMode === undefined) this.thinkingMode = "level";
    if (this.thinkingMode === "level") {
      generationConfig.thinkingLevel = "low";
    } else if (this.thinkingMode === "budget") {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const fetchStart = performance.now();
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
        }
      );
    } catch (e) {
      return this._strike(`Network error: ${e.message}`);
    }
    this.lastFetchMs = performance.now() - fetchStart;

    if (response.status === 400 && this.thinkingMode !== "none") {
      const next = this.thinkingMode === "level" ? "budget" : "none";
      console.warn(
        `⚠️ Model rejected thinking config "${this.thinkingMode}" — trying "${next}".`
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
    return text;
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
