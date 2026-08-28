// Silero VAD (v4 "legacy" ONNX, same generation as the desktop app's
// silero_vad.jit — the 0.25 threshold tuning transfers) plus a faithful port
// of the dynamic-chunking frame loop from src/modules/recorder.py.

const VAD_MODEL_URL = chrome.runtime.getURL("libs/silero_vad_legacy.onnx");
const ORT_WASM_BASE = chrome.runtime.getURL("libs/ort/");

class SileroVad {
  async load() {
    // MV3 CSP blocks the blob workers multi-threaded ort spawns; force the
    // single-threaded path and point ort at the vendored wasm dist.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = ORT_WASM_BASE;
    this.session = await ort.InferenceSession.create(VAD_MODEL_URL, {
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

// Port of dynamic_recorder_thread's per-frame state machine (recorder.py
// lines 110-196). Frames arrive from the AudioWorklet; emitted utterance
// chunks go to onChunk(Float32Array, {durationS, peak, isLoud}).
class DynamicChunker {
  constructor(vad, settings, onChunk, onLevel) {
    this.vad = vad; // may be null → volume-based fallback, like the app
    this.onChunk = onChunk;
    this.onLevel = onLevel;
    this.applySettings(settings);

    this.isSpeaking = false;
    this.speechBuffer = [];
    this.silenceFramesAfterSpeech = 0;
    // ~300 ms pre-roll so the first mora isn't clipped when VAD fires late
    this.prerollFrames = Math.max(1, Math.floor(300 / 32));
    this.preroll = [];
    this.lastLevelTs = 0;
    this.busy = false;
    this.pending = [];
  }

  applySettings(s) {
    this.vadThreshold = s.vadThreshold;
    this.volumeThreshold = s.volumeThreshold;
    this.silenceTimeoutFrames = Math.floor((s.silenceTimeoutS * 1000) / 32);
    this.maxChunkFrames = Math.floor((s.maxChunkS * 1000) / 32);
    this.minSpeechS = s.minSpeechS;
  }

  reset() {
    this.isSpeaking = false;
    this.speechBuffer = [];
    this.silenceFramesAfterSpeech = 0;
    this.preroll = [];
    this.pending = [];
    if (this.vad) this.vad.reset();
  }

  // Frames must be processed strictly in order (Silero carries LSTM state),
  // but ONNX inference is async — serialize through a small pending queue.
  push(frame) {
    this.pending.push(frame);
    // Safety valve only: inference is ~1 ms/frame vs 32 ms arrival, so this
    // never trips unless the machine is drowning. Dropping corrupts the
    // current utterance, but at that point subtitles are doomed anyway.
    if (this.pending.length > 300) {
      console.warn("⚠️ VAD frame backlog overflow - dropping oldest frames");
      this.pending.splice(0, this.pending.length - 300);
    }
    if (!this.busy) this._drain();
  }

  async _drain() {
    this.busy = true;
    try {
      while (this.pending.length > 0) {
        await this._processFrame(this.pending.shift());
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

    const now = performance.now();
    if (this.onLevel && now - this.lastLevelTs >= 100) {
      this.lastLevelTs = now;
      this.onLevel(rms);
    }

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
      this.speechBuffer.push(frame);
      if (isSpeech) {
        this.silenceFramesAfterSpeech = 0;
      } else {
        this.silenceFramesAfterSpeech++;
      }

      const chunkEnded =
        this.silenceFramesAfterSpeech > this.silenceTimeoutFrames ||
        this.speechBuffer.length > this.maxChunkFrames;

      if (chunkEnded) {
        this._emitChunk();
        this.isSpeaking = false;
        this.speechBuffer = [];
        this.silenceFramesAfterSpeech = 0;
        this.preroll = [];
      }
    } else if (isSpeech) {
      this.isSpeaking = true;
      // Seed with pre-roll: VAD fires a frame or two into the utterance, so
      // the attack lives in these frames.
      this.speechBuffer = this.preroll.slice();
      this.speechBuffer.push(frame);
      this.silenceFramesAfterSpeech = 0;
    } else {
      this.preroll.push(frame);
      if (this.preroll.length > this.prerollFrames) this.preroll.shift();
    }
  }

  _emitChunk() {
    const total = this.speechBuffer.reduce((n, f) => n + f.length, 0);
    const chunk = new Float32Array(total);
    let off = 0;
    for (const f of this.speechBuffer) {
      chunk.set(f, off);
      off += f.length;
    }
    const durationS = chunk.length / HOLOTL.SAMPLE_RATE;
    let peak = 0;
    for (let i = 0; i < chunk.length; i++) {
      const a = Math.abs(chunk[i]);
      if (a > peak) peak = a;
    }
    const isLoudChunk = peak > 0.1;

    // Loud chunks get relaxed minimums (shrieks/laughter are short but real).
    const minDuration = isLoudChunk ? this.minSpeechS * 0.5 : this.minSpeechS;
    const minSamples = isLoudChunk
      ? Math.floor(HOLOTL.SAMPLE_RATE * 0.5)
      : Math.floor(HOLOTL.SAMPLE_RATE * 1.0);

    if (durationS > minDuration && chunk.length >= minSamples) {
      console.log(
        `🎤 Detected ${isLoudChunk ? "LOUD" : "speech"} chunk of ` +
          `${durationS.toFixed(2)}s (peak: ${peak.toFixed(3)}).`
      );
      this.onChunk(chunk, { durationS, peak, isLoud: isLoudChunk });
    } else {
      console.log(`⏩ Skipped short chunk: ${durationS.toFixed(2)}s (peak: ${peak.toFixed(3)})`);
    }
  }
}
