// AudioWorkletProcessor: mono mixdown packed into exact 512-sample Float32
// frames (32 ms at 16 kHz — the frame size Silero VAD expects). The capture
// AudioContext runs at 16 kHz, so no resampling happens here. The offscreen
// document converts to PCM16 only for the audio actually sent to Gemini.

const FRAME_SIZE = 512;

class PCMFramer extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(FRAME_SIZE);
    this._len = 0;
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

      this._buf[this._len++] = s;

      if (this._len === FRAME_SIZE) {
        const out = this._buf;
        this.port.postMessage(out.buffer, [out.buffer]);
        this._buf = new Float32Array(FRAME_SIZE);
        this._len = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-framer", PCMFramer);
