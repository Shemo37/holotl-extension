// AudioWorkletProcessor that turns the 16 kHz capture into ~100 ms PCM16
// chunks (1600 samples) and posts each to the offscreen document together
// with its RMS, so the silence gate can decide whether to send it.

const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz

class PCMChunker extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Int16Array(CHUNK_SAMPLES);
    this._len = 0;
    this._sumSquares = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const frames = input[0].length;
    const channels = input.length;

    for (let i = 0; i < frames; i++) {
      // Mono mixdown across whatever channel count the tab delivers.
      let s = 0;
      for (let c = 0; c < channels; c++) s += input[c][i];
      s /= channels;
      if (s > 1) s = 1;
      else if (s < -1) s = -1;

      this._sumSquares += s * s;
      this._buf[this._len++] = s < 0 ? s * 0x8000 : s * 0x7fff;

      if (this._len === CHUNK_SAMPLES) {
        const rms = Math.sqrt(this._sumSquares / CHUNK_SAMPLES);
        const samples = this._buf;
        this.port.postMessage({ samples, rms }, [samples.buffer]);
        this._buf = new Int16Array(CHUNK_SAMPLES);
        this._len = 0;
        this._sumSquares = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-chunker", PCMChunker);
