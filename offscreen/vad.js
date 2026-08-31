// Silero VAD (v4 "legacy" ONNX, same generation as the desktop app's
// silero_vad.jit — the 0.25 threshold tuning transfers) plus the
// dynamic-chunking frame loop ported from the old chunked engine (which in
// turn ported src/modules/recorder.py from the desktop app).
//
// `ort` (onnxruntime-web) is a classic-script global loaded by
// offscreen.html before this module — see libs/ort/.

const SAMPLE_RATE = 16000;

export class SileroVad {
  async load() {
    // Resolved lazily so this module imports cleanly outside the extension
    // (the DynamicChunker below is unit-tested in Node with vad=null).
    const modelUrl = chrome.runtime.getURL("libs/silero_vad_legacy.onnx");
    const wasmBase = chrome.runtime.getURL("libs/ort/");
    // MV3 CSP blocks the blob workers multi-threaded ort spawns; force the
    // single-threaded path and point ort at the vendored wasm dist.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = wasmBase;
    this.session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ["wasm"],
    });
    this.srTensor = new ort.Tensor("int64", BigInt64Array.from([16000n]), [1]);
    this.reset();
  }

  reset() {
    // Silero v4 keeps LSTM state across frames; zero it per session.
    this.h = new ort.Tensor("float32", new Float32Array(2 * 1 * 64), [2, 1, 64]);
    this.c = new ort.Tensor("float32", new Float32Array(2 * 1 * 64), [2, 1, 64]);
  }

  /** frame: Float32Array of exactly 512 samples @ 16 kHz. Returns speech prob. */
  async probability(frame) {
    const input = new ort.Tensor("float32", frame, [1, frame.length]);
    const out = await this.session.run({
      input,
      sr: this.srTensor,
      h: this.h,
      c: this.c,
    });
    this.h = out.hn;
    this.c = out.cn;
    const data = out.output.data;
    return Number(data[data.length - 1]);
  }
}

// Per-frame speech-window state machine. Frames arrive from the
// AudioWorklet and are STREAMED while speech is active — nothing is
// buffered until end-of-utterance, so the model hears (and starts
// translating) the sentence while it is still being spoken. Handlers:
//   onSpeechStart(frames)  window opened; frames = pre-roll + first frame
//   onSpeechFrame(frame)   one live 512-sample frame inside the window
//   onSpeechEnd(meta)      window closed ({durationS, forced})
export class DynamicChunker {
  constructor(vad, settings, handlers) {
    this.vad = vad; // may be null → volume-based fallback
    this.onSpeechStart = handlers.onSpeechStart || (() => {});
    this.onSpeechFrame = handlers.onSpeechFrame || (() => {});
    this.onSpeechEnd = handlers.onSpeechEnd || (() => {});
    this.applySettings(settings);

    this.isSpeaking = false;
    this.streamedFrames = 0;
    this.silenceFramesAfterSpeech = 0;
    this.consecSpeechFrames = 0;
    this.preroll = [];
    this.busy = false;
    this.pending = [];
  }

  applySettings(s) {
    this.vadThreshold = s.vadThreshold;
    this.volumeThreshold = s.volumeThreshold;
    this.silenceTimeoutFrames = Math.floor((s.silenceTimeoutS * 1000) / 32);
    // Streaming can't un-send a blip after the fact, so the minimum-speech
    // filter runs BEFORE the window opens: this many frames of continuous
    // speech are required to trigger. The pre-roll ring is sized to hold
    // the confirmation frames plus ~300 ms of context, so nothing is lost.
    this.minSpeechFrames = Math.floor(((s.minSpeechS || 0) * 1000) / 32);
    this.prerollFrames =
      Math.max(1, Math.floor(300 / 32) + 1) + this.minSpeechFrames;
    // Continuous speech would otherwise hold a window open indefinitely and
    // this model delivers its translation when the window closes — so past
    // softCutAfterS a mere breath-length dip closes it, and maxActiveS
    // hard-cuts as a last resort.
    this.softCutAfterFrames = Math.floor((s.softCutAfterS * 1000) / 32);
    this.softCutSilenceFrames = Math.floor((s.softCutSilenceS * 1000) / 32);
    this.maxActiveFrames = Math.floor((s.maxActiveS * 1000) / 32);
  }

  reset() {
    this.isSpeaking = false;
    this.streamedFrames = 0;
    this.silenceFramesAfterSpeech = 0;
    this.consecSpeechFrames = 0;
    this.preroll = [];
    this.pending = [];
    if (this.vad) this.vad.reset();
  }

  // Frames must be processed strictly in order (Silero carries LSTM state),
  // but ONNX inference is async — serialize through a small pending queue.
  push(frame) {
    this.pending.push(frame);
    // Safety valve only: inference is ~1 ms/frame vs 32 ms arrival, so this
    // never trips unless the machine is drowning.
    if (this.pending.length > 300) {
      console.warn("[HoloTL Live] VAD frame backlog overflow - dropping oldest frames");
      this.pending.splice(0, this.pending.length - 300);
    }
    if (!this.busy) this._drain();
  }

  async _drain() {
    this.busy = true;
    try {
      while (this.pending.length > 0) {
        const frame = this.pending.shift();
        try {
          await this._processFrame(frame);
        } catch (e) {
          // One bad inference/emit drops one 32ms decision, never the loop.
          console.warn("[HoloTL Live] VAD frame processing failed:", e);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async _processFrame(frame) {
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i];
      sumSq += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSq / frame.length);
    const isLoudSound = peak > 0.1;

    let isSpeech;
    if (rms < this.volumeThreshold && !isLoudSound) {
      isSpeech = false; // cheap gate: never run the model on near-silence
    } else if (this.vad) {
      const prob = await this.vad.probability(frame);
      // Loud frames get a more sensitive threshold (shrieks and laughter are
      // real speech the model can under-score) but they do NOT bypass the
      // VAD: on tab audio, game BGM sits above the loud threshold
      // continuously, and forcing speech there means silence is never
      // detected — every chunk cuts at the max-length limit and the whole
      // stream, music included, gets transcribed.
      const threshold = isLoudSound ? this.vadThreshold * 0.5 : this.vadThreshold;
      isSpeech = prob > threshold;
    } else {
      isSpeech = rms > this.volumeThreshold || isLoudSound;
    }

    if (this.isSpeaking) {
      this.streamedFrames++;
      this.onSpeechFrame(frame);
      if (isSpeech) {
        this.silenceFramesAfterSpeech = 0;
      } else {
        this.silenceFramesAfterSpeech++;
      }

      const pastSoftCut = this.streamedFrames > this.softCutAfterFrames;
      const timeoutFrames = pastSoftCut
        ? this.softCutSilenceFrames
        : this.silenceTimeoutFrames;
      const forced = this.streamedFrames > this.maxActiveFrames;
      const ended = this.silenceFramesAfterSpeech > timeoutFrames || forced;

      if (ended) {
        this.onSpeechEnd({
          durationS: (this.streamedFrames * frame.length) / SAMPLE_RATE,
          forced,
        });
        this.isSpeaking = false;
        this.streamedFrames = 0;
        this.silenceFramesAfterSpeech = 0;
        this.preroll = [];
      }
    } else {
      this.consecSpeechFrames = isSpeech ? this.consecSpeechFrames + 1 : 0;
      this.preroll.push(frame);
      if (this.preroll.length > this.prerollFrames) this.preroll.shift();
      if (isSpeech && this.consecSpeechFrames > this.minSpeechFrames) {
        this.isSpeaking = true;
        // Seed with pre-roll: it holds the confirmation frames plus the
        // attack before them, so nothing said so far is lost.
        const startFrames = this.preroll;
        this.preroll = [];
        this.streamedFrames = startFrames.length;
        this.silenceFramesAfterSpeech = 0;
        this.consecSpeechFrames = 0;
        this.onSpeechStart(startFrames);
      }
    }
  }
}
