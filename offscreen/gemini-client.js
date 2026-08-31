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

// Window display for the transcription streams: everything a speech window
// produces accumulates hidden, and the window's FULL Japanese + FULL
// translation appear together as one subtitle at the turn boundary
// (turnComplete/generationComplete from the server, or flushTurn() when
// the next VAD window opens). No mid-window fragments, no word-by-word
// growth, nothing discarded.
const PHRASE_MAX_CHARS = 120;

export class GeminiLiveClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.model            e.g. "models/gemini-3.5-live-translate-preview"
   * @param {string} opts.wsUrlBase        wss://…/BidiGenerateContent
   * @param {string} opts.systemInstruction
   * @param {object} opts.setupOverrides   merged last into the setup object
   * @param {boolean} [opts.manualActivity] client-side VAD marks utterance
   *   boundaries: setup disables the server's automatic activity detection
   *   and startActivity()/endActivity() bracket each streamed speech window
   * @param {number} opts.reconnectDelayMs
   * @param {number} opts.maxConsecutiveFailures
   * @param {boolean} opts.debug
   * @param {(sub: {jp: string, en: string}) => void} opts.onSubtitleUpdate
   * @param {(status: string, message?: string) => void} opts.onStatusChange
   * @param {(line: string) => void} [opts.onDebug]  wire-level event log
   */
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.wsUrlBase = opts.wsUrlBase;
    this.systemInstruction = opts.systemInstruction;
    this.setupOverrides = opts.setupOverrides || {};
    this.manualActivity = !!opts.manualActivity;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 500;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 10;
    this.debug = !!opts.debug;
    this.onSubtitleUpdate = opts.onSubtitleUpdate || (() => {});
    this.onStatusChange = opts.onStatusChange || (() => {});
    this.onDebug = opts.onDebug || (() => {});

    this.ws = null;
    this.intentionalClose = false;
    this.consecutiveFailures = 0;
    this._reconnectTimer = null;
    this._sessionSawMessage = false;
    this._loggedFirstFrame = false;

    // Subtitle assembly state (per model turn). Input (JA speech) and
    // output (the model's translation) transcription events are separate
    // streams and must never share a line — merging them interleaves
    // Japanese with the translation on screen. Each stream accumulates its
    // window's text hidden (phrase) until the turn boundary shows it
    // (shown).
    this._turnText = "";
    this._input = { phrase: "", shown: "" };
    this._output = { phrase: "", shown: "" };
    this._lastSub = { jp: "", en: "" };
  }

  connect() {
    if (this.intentionalClose) return;
    this._sessionSawMessage = false;
    // A session that dies mid-utterance never sends turnComplete; without
    // this reset its partial lines would prepend to the next session's
    // first subtitle.
    this._turnText = "";
    this._input = { phrase: "", shown: "" };
    this._output = { phrase: "", shown: "" };
    this._lastSub = { jp: "", en: "" };
    this.onStatusChange(
      this.consecutiveFailures > 0 ? "reconnecting" : "connecting"
    );

    const url = `${this.wsUrlBase}?key=${encodeURIComponent(this.apiKey)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.onDebug(`socket open → sending setup for ${this.model}`);
      const setup = {
        model: this.model,
        systemInstruction: { parts: [{ text: this.systemInstruction }] },
        ...(this.manualActivity
          ? { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } }
          : {}),
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
        // A preview model may reject the manual-activity setup field and
        // close before sending anything. Rather than burning through the
        // whole failure budget, drop the field and let the server's own
        // VAD segment turns; client-side VAD still gates what is sent.
        if (this.manualActivity && this.consecutiveFailures >= 2) {
          this.manualActivity = false;
          const line =
            "2 sessions died before any server message — retrying WITHOUT " +
            "manual activity detection (server VAD takes over turn-taking)";
          console.warn(`[HoloTL Live] ${line}`);
          this.onDebug(line);
        }
      }
      const closeLine =
        `session closed (code ${event.code}` +
        (event.reason ? `, reason "${event.reason}"` : "") +
        ") — likely the ~15-min session limit; reconnecting in " +
        `${this.reconnectDelayMs}ms`;
      console.log(`[HoloTL Live] ${closeLine}`);
      this.onDebug(closeLine);
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

  /** Send one base64-encoded 16 kHz PCM16 chunk. Returns true if sent. */
  sendAudioChunk(base64) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64 }],
        },
      })
    );
    return true;
  }

  /** Open a speech window: with manual activity detection the server is
   * told a turn's audio is starting; audio then streams via sendAudioChunk
   * while the speaker talks, and endActivity() finalizes the turn. No-ops
   * (returns false) when disconnected or manual activity is off. */
  startActivity() {
    if (!this.manualActivity) return false;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
    return true;
  }

  /** Close the current speech window (see startActivity). */
  endActivity() {
    if (!this.manualActivity) return false;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    return true;
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
      this.onDebug(
        `first server frame: ${text.length > 600 ? text.slice(0, 600) + "…" : text}`
      );
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
    // transcribe/translate Live models): inputTranscription is the JA
    // speech, outputTranscription is the model's translation — they feed
    // the two separate subtitle lines. Interim frames are ignored: chunk
    // display renders only completed phrases, never streaming partials.
    if (typeof sc.inputTranscription?.text === "string" && sc.inputTranscription.text) {
      this._appendPhrase(this._input, sc.inputTranscription.text);
      updated = true;
    }
    if (typeof sc.outputTranscription?.text === "string" && sc.outputTranscription.text) {
      this._appendPhrase(this._output, sc.outputTranscription.text);
      updated = true;
    }

    if (updated) {
      const sub = this._composeSubtitle();
      // Emit only visible changes: hidden accumulation must not blank or
      // re-trigger the overlay.
      if (sub.jp !== this._lastSub.jp || sub.en !== this._lastSub.en) {
        this._lastSub = sub;
        this.onSubtitleUpdate(sub);
      }
    }

    // Some Live models mark the end of a turn with generationComplete
    // instead of turnComplete; either way, the window's JP+translation pair
    // is done — show it together and start the next window clean.
    if (sc.turnComplete || sc.generationComplete) {
      this._finishTurn();
    }
  }

  /** End-of-turn: flush both pending lines as one paired update, then
   * reset all assembly state so the next utterance starts clean. Also
   * called by the capture pipeline when a new VAD speech window opens, for
   * models that never send a turn marker — without this, JP and the
   * translation accumulate across windows and drift out of sync. */
  flushTurn() {
    this._finishTurn();
  }

  _finishTurn() {
    let flushed = false;
    for (const state of [this._input, this._output]) {
      if (state.phrase) {
        state.shown = state.phrase;
        state.phrase = "";
        flushed = true;
      }
    }
    if (flushed) {
      const sub = this._composeSubtitle();
      if (sub.jp !== this._lastSub.jp || sub.en !== this._lastSub.en) {
        this.onSubtitleUpdate(sub);
      }
    }
    this._turnText = "";
    this._input = { phrase: "", shown: "" };
    this._output = { phrase: "", shown: "" };
    // Next turn may legitimately repeat the same phrase; let it re-emit.
    this._lastSub = { jp: "", en: "" };
  }

  _appendPhrase(state, text) {
    state.phrase = state.phrase
      ? state.phrase + text
      : text.replace(/^\s+/, "");
    // Keep the window's line bounded (windows are ≤3.5s so this rarely
    // trips); a truncated line gets a leading ellipsis so it doesn't read
    // as a sentence that starts mid-word.
    if (state.phrase.length > PHRASE_MAX_CHARS) {
      state.phrase =
        "…" + state.phrase.slice(state.phrase.length - PHRASE_MAX_CHARS);
    }
  }

  // Parse the accumulated turn text for JP:/EN:/TH: prefixed lines. The
  // translation lands in `en` whichever target language it is (the overlay
  // has one translation slot). Unprefixed text counts as JP so a model that
  // ignores the instruction still renders. Transcription events fill the
  // lines the model turn didn't: input transcription → JP, output
  // transcription (the translation) → the translation slot.
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
      jp = this._input.shown;
    }
    if (!en) {
      en = this._output.shown;
    }
    return { jp, en };
  }
}
