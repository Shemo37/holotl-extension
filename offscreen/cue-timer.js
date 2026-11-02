// Times subtitles for the end-of-session .srt. Each VAD speech window gets
// a number, and its start and end are mapped to the page video's playback
// position. Each subtitle is then matched to its window (exactly by id on
// the local pipeline, by "newest window" on Gemini) and handed on as a
// finished cue {seq, start, end, jp, en}.

export class CueTimer {
  /**
   * @param {object} opts
   * @param {() => Promise<?{time: number, paused: boolean, rate: number}>}
   *   opts.getVideoTime  the page video's position right now (null: none)
   * @param {(cue: object) => void} opts.onCue
   * @param {() => void} [opts.onNoVideo]  first time a window falls back to
   *   time since Start
   * @param {number} [opts.sampleRate]
   * @param {number} [opts.history]  windows kept for late subtitles
   */
  constructor(opts) {
    this.getVideoTime = opts.getVideoTime;
    this.onCue = opts.onCue;
    this.onNoVideo = opts.onNoVideo || (() => {});
    this.sampleRate = opts.sampleRate ?? 16000;
    this.history = opts.history ?? 50;
    this.windows = new Map(); // seq → {start: Promise<s>, end: Promise<s>}
    this.reset();
  }

  reset() {
    this.samplesReceived = 0; // audio clock: samples in from the worklet
    this.latestSeq = 0;
    this.windows.clear();
    this.warnedNoVideo = false;
  }

  addSamples(n) {
    this.samplesReceived += n;
  }

  beginWindow(startSample) {
    const seq = ++this.latestSeq;
    const w = { start: this._videoTimeAt(startSample) };
    w.end = new Promise((resolve) => (w.resolveEnd = resolve));
    this.windows.set(seq, w);
    this.windows.delete(seq - this.history);
    return seq;
  }

  endWindow(seq, speechEndSample) {
    this.windows.get(seq)?.resolveEnd(this._videoTimeAt(speechEndSample));
  }

  /** Emit the cue for subtitle `sub` once its window's times are known. */
  async recordCue(seq, sub) {
    const w = this.windows.get(seq);
    if (!w || !(sub.jp || sub.en)) return;
    const [start, end] = await Promise.all([w.start, w.end]);
    this.onCue({ seq, start, end, jp: sub.jp || "", en: sub.en || "" });
  }

  // Video position (s) at an audio sample position: read the video's
  // current time, then step back by how far the audio clock has run past
  // that sample (VAD + messaging lag; half the round trip for the read).
  // No <video> on the page → time since Start instead.
  async _videoTimeAt(sample) {
    const lagS = (this.samplesReceived - sample) / this.sampleRate;
    const sentAt = performance.now();
    let res = null;
    try {
      res = await this.getVideoTime();
    } catch {
      /* unreachable: fall through */
    }
    if (typeof res?.time !== "number") {
      if (!this.warnedNoVideo) {
        this.warnedNoVideo = true;
        this.onNoVideo();
      }
      return sample / this.sampleRate;
    }
    if (res.paused) return res.time;
    const readLagS = lagS + (performance.now() - sentAt) / 2000;
    return Math.max(0, res.time - readLagS * (res.rate || 1));
  }
}
