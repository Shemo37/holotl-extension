// Port of src/modules/audio_utils.py enhance_audio_quality: 60 Hz low-cut,
// DC removal, RMS normalization toward 0.3 (gain cap 5x, noise floor left
// alone), hard peak cap at 0.95. The Python version uses a 3rd-order
// Butterworth via lfilter; a single RBJ biquad high-pass at 60 Hz is audibly
// identical for a low-cut this far below the speech band.

function highpassBiquad(data, cutoff = 60, fs = HOLOTL.SAMPLE_RATE) {
  const w0 = (2 * Math.PI * cutoff) / fs;
  const cosW0 = Math.cos(w0);
  const q = Math.SQRT1_2; // 0.707
  const alpha = Math.sin(w0) / (2 * q);

  const b0 = (1 + cosW0) / 2;
  const b1 = -(1 + cosW0);
  const b2 = (1 + cosW0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;

  const out = new Float32Array(data.length);
  // Zero initial state per chunk, matching lfilter's default in the app.
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x0 = data[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
  return out;
}

function normalizeAudio(data) {
  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i];
  mean /= data.length || 1;

  let sumSq = 0;
  for (let i = 0; i < data.length; i++) {
    data[i] -= mean;
    sumSq += data[i] * data[i];
  }
  const rms = Math.sqrt(sumSq / (data.length || 1));

  if (rms > 0.001) {
    // leave the noise floor alone — never amplify near-silence
    const gain = Math.min(0.3 / rms, 5.0);
    for (let i = 0; i < data.length; i++) data[i] *= gain;
  }

  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0.95) {
    const scale = 0.95 / peak;
    for (let i = 0; i < data.length; i++) data[i] *= scale;
  }
  return data;
}

function enhanceAudioQuality(data) {
  return normalizeAudio(highpassBiquad(data));
}
