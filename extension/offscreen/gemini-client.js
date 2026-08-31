// WebSocket client for the Gemini Multimodal Live API
// (BidiGenerateContent). All wire-schema knowledge lives here and in
// ../config.js.
//
// Live sessions are capped at ~15 minutes server-side; the server closes
// the socket and this client transparently reconnects after
// RECONNECT_DELAY_MS. `disconnect()` sets intentionalClose so Stop never
// reconnects, and MAX_CONSECUTIVE_FAILURES sessions that die without a
// single server message (bad key, bad model id) stop the client with an
// "error" status instead of hammering the endpoint every 500 ms.

export class GeminiLiveClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.model            e.g. "models/gemini-3.5-live-translate-preview"
   * @param {string} opts.wsUrlBase        wss://…/BidiGenerateContent
   * @param {string} opts.systemInstruction
   * @param {object} opts.setupOverrides   merged last into the setup object
   * @param {number} opts.reconnectDelayMs
   * @param {number} opts.maxConsecutiveFailures
   * @param {boolean} opts.debug
   * @param {(sub: {jp: string, en: string}) => void} opts.onSubtitleUpdate
   * @param {(status: string, message?: string) => void} opts.onStatusChange
   */
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.wsUrlBase = opts.wsUrlBase;
    this.systemInstruction = opts.systemInstruction;
    this.setupOverrides = opts.setupOverrides || {};
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 500;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 10;
    this.debug = !!opts.debug;
    this.onSubtitleUpdate = opts.onSubtitleUpdate || (() => {});
    this.onStatusChange = opts.onStatusChange || (() => {});

    this.ws = null;
    this.intentionalClose = false;
    this.consecutiveFailures = 0;
    this._reconnectTimer = null;
    this._sessionSawMessage = false;
    this._loggedFirstFrame = false;

    // Subtitle assembly state (per model turn).
    this._turnText = "";
    this._transcriptLine = "";
    this._interimText = "";
  }

  connect() {
    if (this.intentionalClose) return;
    this._sessionSawMessage = false;
    this.onStatusChange(
      this.consecutiveFailures > 0 ? "reconnecting" : "connecting"
    );

    const url = `${this.wsUrlBase}?key=${encodeURIComponent(this.apiKey)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (ws !== this.ws) return;
      const setup = {
        model: this.model,
        systemInstruction: { parts: [{ text: this.systemInstruction }] },
        ...this.setupOverrides,
      };
      ws.send(JSON.stringify({ setup }));
    };

    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      this._handleMessage(event.data);
    };

    ws.onerror = () => {
      // The paired close event carries the actionable code/reason.
      if (ws === this.ws && this.debug) {
        console.warn("[HoloTL Live] websocket error (close event follows)");
      }
    };

    ws.onclose = (event) => {
      if (ws !== this.ws) return;
      if (this.intentionalClose) {
        this.onStatusChange("stopped");
        return;
      }
      if (!this._sessionSawMessage) {
        this.consecutiveFailures++;
      }
      console.log(
        `[HoloTL Live] session closed (code ${event.code}` +
          (event.reason ? `, reason "${event.reason}"` : "") +
          ") — likely the ~15-min session limit; reconnecting in " +
          `${this.reconnectDelayMs}ms`
      );
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.onStatusChange(
          "error",
          `Connection failed ${this.consecutiveFailures} times in a row ` +
            `(last close code ${event.code}` +
            (event.reason ? `: ${event.reason}` : "") +
            "). Check your API key and the model id, then Start again."
        );
        return;
      }
      this.onStatusChange("reconnecting");
      this._reconnectTimer = setTimeout(
        () => this.connect(),
        this.reconnectDelayMs
      );
    };
  }

  /** Send one base64-encoded 16 kHz PCM16 chunk. */
  sendAudioChunk(base64) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64 }],
        },
      })
    );
  }

  disconnect() {
    this.intentionalClose = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }

  async _handleMessage(data) {
    let text;
    try {
      text = data instanceof Blob ? await data.text() : String(data);
    } catch (e) {
      console.warn("[HoloTL Live] unreadable frame", e);
      return;
    }
    if (this.debug && !this._loggedFirstFrame) {
      this._loggedFirstFrame = true;
      console.log("[HoloTL Live] first server frame:", text);
    }

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      console.warn("[HoloTL Live] non-JSON frame:", text.slice(0, 500));
      return;
    }

    // Any parsed server message proves the key/model are accepted.
    this._sessionSawMessage = true;
    this.consecutiveFailures = 0;

    if (msg.setupComplete !== undefined) {
      this.onStatusChange("connected");
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    let updated = false;

    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        if (typeof part.text === "string" && part.text) {
          this._turnText += part.text;
          updated = true;
        }
      }
    }

    // Transcription-shaped fallbacks (camelCase wire format; used by the
    // dedicated transcribe model): interim frames replace, finals append.
    const interim = sc.interimInputTranscription ?? sc.interimTranscription;
    if (typeof interim?.text === "string") {
      this._interimText = interim.text;
      updated = true;
    }
    const finals = [sc.inputTranscription, sc.outputTranscription];
    for (const t of finals) {
      if (typeof t?.text === "string" && t.text) {
        this._transcriptLine = this._appendTranscript(
          this._transcriptLine,
          t.text
        );
        this._interimText = "";
        updated = true;
      }
    }

    if (updated) this.onSubtitleUpdate(this._composeSubtitle());

    if (sc.turnComplete) {
      this._turnText = "";
      this._transcriptLine = "";
      this._interimText = "";
    }
  }

  _appendTranscript(line, text) {
    line = line ? line + text : text;
    // Keep the visible line bounded; the overlay is one line of context.
    const MAX = 120;
    return line.length > MAX ? line.slice(line.length - MAX) : line;
  }

  // Parse the accumulated turn text for JP:/EN:/TH: prefixed lines. The
  // translation lands in `en` whichever target language it is (the overlay
  // has one translation slot). Unprefixed text counts as JP so a model that
  // ignores the instruction still renders. Transcription events fill JP
  // when the model turn carried none.
  _composeSubtitle() {
    let jp = "";
    let en = "";
    for (const rawLine of this._turnText.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = /^(JP|JA|EN|TH)\s*[:：]\s*(.*)$/i.exec(line);
      if (m) {
        const tag = m[1].toUpperCase();
        if (tag === "JP" || tag === "JA") jp = m[2];
        else en = m[2];
      } else {
        jp = jp ? jp + " " + line : line;
      }
    }
    if (!jp) {
      jp = this._transcriptLine + this._interimText;
    }
    return { jp, en };
  }
}
