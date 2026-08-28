// AudioWorkletProcessor: mono mixdown + linear-interpolation resample from the
// context's native rate (usually 48 kHz) down to 16 kHz, packed into exact
// 512-sample frames (the frame size Silero VAD expects — see recorder.py in
// the desktop app, where 32 ms = 512 samples at 16 kHz is load-bearing).

const TARGET_RATE = 16000;
const FRAME_SIZE = 512;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // sampleRate is the worklet global
    this.pos = 0; // fractional read index into [prev, ...quantum]
    this.prev = 0; // last input sample carried across quanta for continuity
    this.frame = new Float32Array(FRAME_SIZE);
    this.frameFill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || input[0].length === 0) return true;

    const n = input[0].length;
    const mono = new Float32Array(n);
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < n; i++) mono[i] += ch[i];
    }
    if (input.length > 1) {
      const inv = 1 / input.length;
      for (let i = 0; i < n; i++) mono[i] *= inv;
    }

    // Virtual buffer [prev, mono[0..n-1]]; interpolate while pos < n so that
    // index pos+1 always exists.
    let pos = this.pos;
    while (pos < n) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? this.prev : mono[i - 1];
      const b = mono[i];
      this.frame[this.frameFill++] = a + (b - a) * frac;
      if (this.frameFill === FRAME_SIZE) {
        const out = this.frame;
        this.port.postMessage(out.buffer, [out.buffer]);
        this.frame = new Float32Array(FRAME_SIZE);
        this.frameFill = 0;
      }
      pos += this.ratio;
    }
    this.pos = pos - n;
    this.prev = mono[n - 1];
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
