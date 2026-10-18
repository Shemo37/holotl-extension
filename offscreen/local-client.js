// WebSocket client for the HOLOTLLOCAL pipeline server: HoloLiveTL run
// headless on the user's own GPU (kotoba-whisper ASR + filters + FuguMT /
// DeepL). The wire protocol is defined in that repo's server.py:
//   → binary  one whole utterance, PCM16 little-endian mono 16 kHz
//   ← JSON    {type:"status", status:"loading"|"ready", message}
//             {type:"subtitle", id, jp, en, confidence}
//             {type:"error", message}   fatal; the server exits after it
//
// Whisper decodes whole utterances, so unlike the Gemini Live path nothing
// streams mid-sentence: offscreen.js buffers each VAD window and sends it
// with sendUtterance() when the window closes.

// Close code the server uses when a newer connection displaces this one.
export const CLOSE_REPLACED = 4001;

export class LocalPipelineClient {
  /**
   * @param {object} opts
   * @param {string} opts.url                    e.g. "ws://127.0.0.1:8765"
   * @param {number} opts.reconnectDelayMs
   * @param {number} opts.maxConsecutiveFailures connection attempts that never
   *   open, in a row, before giving up with an "error" status
   * @param {(sub: {jp: string, en: string}) => void} opts.onSubtitleUpdate
   * @param {(status: string, message?: string) => void} opts.onStatusChange
   * @param {(line: string) => void} [opts.onDebug]
   * @param {typeof WebSocket} [opts.WebSocketImpl]  injectable for tests
   */
  constructor(opts) {
    this.url = opts.url;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 500;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 10;
    this.onSubtitleUpdate = opts.onSubtitleUpdate || (() => {});
    this.onStatusChange = opts.onStatusChange || (() => {});
    this.onDebug = opts.onDebug || (() => {});
    this.WebSocketImpl = opts.WebSocketImpl || globalThis.WebSocket;

    this.ws = null;
    this.intentionalClose = false;
    this.consecutiveFailures = 0;
    this._reconnectTimer = null;
    this._opened = false;
    this.ready = false;
  }

  connect() {
    if (this.intentionalClose) return;
    this._opened = false;
    this.ready = false;
    this.onStatusChange(
      this.consecutiveFailures > 0 ? "reconnecting" : "connecting"
    );

    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch (e) {
      // Malformed URL: retrying can't help.
      this._fail(`Bad local server URL "${this.url}": ${e.message}`);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      if (ws !== this.ws) return;
      this._opened = true;
      this.consecutiveFailures = 0;
      this.onDebug(`local pipeline socket open (${this.url})`);
    };

    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      this._handleMessage(event.data);
    };

    ws.onerror = () => {
      /* the paired close event carries the code */
    };

    ws.onclose = (event) => {
      if (ws !== this.ws) return;
      this.ready = false;
      if (this.intentionalClose) {
        this.onStatusChange("stopped");
        return;
      }
      if (event.code === CLOSE_REPLACED) {
        this._fail(
          "Another client connected to the local pipeline server and took " +
            "it over. Stop the other one, then Start again."
        );
        return;
      }
      if (!this._opened) this.consecutiveFailures++;
      this.onDebug(
        `local pipeline socket closed (code ${event.code}` +
          (event.reason ? `, reason "${event.reason}"` : "") +
          `), reconnecting in ${this.reconnectDelayMs}ms`
      );
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        this._fail(
          `Local pipeline server not reachable at ${this.url}. Start ` +
            "HOLOTLLOCAL (StartServer.bat or python server.py), wait for " +
            '"Pipeline ready", then Start again.'
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

  _handleMessage(data) {
    if (typeof data !== "string") {
      this.onDebug("local pipeline sent an unexpected binary frame (ignored)");
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      this.onDebug(`local pipeline sent non-JSON: ${data.slice(0, 120)}`);
      return;
    }
    switch (msg.type) {
      case "status":
        this.ready = msg.status === "ready";
        if (this.ready) {
          this.onDebug(`local pipeline ready (${msg.message || "?"})`);
          this.onStatusChange("connected", msg.message);
        } else {
          // Models still loading; audio sent now would be dropped server-side.
          this.onStatusChange("connecting", msg.message);
        }
        return;
      case "subtitle":
        this.onSubtitleUpdate({ jp: msg.jp || "", en: msg.en || "" });
        return;
      case "error":
        this._fail(`Local pipeline: ${msg.message}`);
        return;
      default:
        this.onDebug(`local pipeline sent unknown type "${msg.type}"`);
    }
  }

  /** Send one whole utterance (ArrayBuffer of PCM16 LE @ 16 kHz). Returns
   * true if sent; false while disconnected or the models are loading. */
  sendUtterance(pcm16Buffer) {
    if (!this.ready || !this.ws || this.ws.readyState !== 1 /* OPEN */) {
      return false;
    }
    this.ws.send(pcm16Buffer);
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

  // Unrecoverable: report once and stop reconnecting.
  _fail(message) {
    this.intentionalClose = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    const ws = this.ws;
    this.ws = null; // its close event must not report "stopped" over this
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    this.onStatusChange("error", message);
  }
}
