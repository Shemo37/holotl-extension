// Shared defaults, prompts, and storage keys. Loaded as a plain <script> by
// the offscreen document and the popup (no modules — everything hangs off
// globalThis.HOLOTL).

const HOLOTL = {};

HOLOTL.SAMPLE_RATE = 16000;
HOLOTL.VAD_FRAME_SIZE = 512; // 32 ms at 16 kHz — the frame Silero VAD expects
HOLOTL.CHUNK_QUEUE_SIZE = 8;

// Hololive JP roster (active as of early 2026), same list the desktop app
// ships as its default hotword preset. Included as prompt context so Gemini
// spells talent names correctly.
HOLOTL.ROSTER_JP =
  "Tokino Sora, Roboco, Sakura Miko, Hoshimachi Suisei, AZKi, " +
  "Shirakami Fubuki, Natsuiro Matsuri, Aki Rosenthal, Akai Haato, " +
  "Murasaki Shion, Nakiri Ayame, Yuzuki Choco, Oozora Subaru, " +
  "Ookami Mio, Nekomata Okayu, Inugami Korone, Usada Pekora, " +
  "Shiranui Flare, Shirogane Noel, Houshou Marine, Amane Kanata, " +
  "Tsunomaki Watame, Tokoyami Towa, Himemori Luna, Yukihana Lamy, " +
  "Momosuzu Nene, Shishiro Botan, Omaru Polka, La+ Darknesss, " +
  "Takane Lui, Hakui Koyori, Kazama Iroha";

HOLOTL.PROMPTS = {
  translate:
    "This audio is live Japanese speech from a stream. Translate the speech " +
    "into natural English. Output ONLY the English translation, with no " +
    "preamble, labels, or quotes. If the audio contains no speech, output " +
    "nothing at all.",
  transcribe:
    "This audio is live Japanese speech from a stream. Transcribe the speech " +
    "verbatim in Japanese. Output ONLY the Japanese transcription, with no " +
    "preamble, labels, or quotes. If the audio contains no speech, output " +
    "nothing at all.",
  both:
    "This audio is live Japanese speech from a stream. Output exactly two " +
    "lines with no preamble, labels, or quotes: line 1 is the verbatim " +
    "Japanese transcription, line 2 is the natural English translation. " +
    "Never omit the English line — always output both. If the audio " +
    "contains no speech, output nothing at all.",
  // Text-only repair call, used when a response contains Japanese but no
  // English (the model skipped the translation line).
  textTranslate:
    "Translate this Japanese line from a live stream into natural English. " +
    "Output ONLY the English translation, with no preamble, labels, or quotes.",
  rosterSuffix: (roster) =>
    " Names that may be spoken or mentioned include: " + roster + ".",
};

HOLOTL.DEFAULT_SETTINGS = {
  apiKey: "",
  // Best translation quality. It cannot fully disable thinking, so responses
  // run 10-30s — the concurrent consumer loop (up to 6 in flight) absorbs
  // that as subtitle delay instead of dropped audio. Swap to
  // gemini-3.5-flash-lite for near-real-time (~1-2s) at lower quality.
  geminiModel: "gemini-3.7-flash",
  outputMode: "translate", // translate | transcribe | both
  rpm: 30, // clamped 1-60
  priceInPer1M: 2.0, // USD per 1M input tokens (editable — verify against pricing docs)
  priceOutPer1M: 12.0, // USD per 1M output tokens
  includeRoster: true,

  vadThreshold: 0.25,
  volumeThreshold: 0.003,
  silenceTimeoutS: 0.9,
  maxChunkS: 8.0,
  minSpeechS: 0.3,
  enhanceAudio: true,

  fontSizePx: 24,
  autoHideS: 6,
  overlayPos: null, // {xPct, yPct} once dragged

  totals: { usd: 0, requests: 0, inTokens: 0, outTokens: 0 },
  schemaVersion: 1,
};

HOLOTL.clampSettings = function (s) {
  const d = HOLOTL.DEFAULT_SETTINGS;
  const num = (v, def, lo, hi) => {
    v = Number(v);
    if (!Number.isFinite(v)) return def;
    return Math.min(hi, Math.max(lo, v));
  };
  return {
    ...d,
    ...s,
    rpm: Math.round(num(s.rpm, d.rpm, 1, 60)),
    priceInPer1M: num(s.priceInPer1M, d.priceInPer1M, 0, 1000),
    priceOutPer1M: num(s.priceOutPer1M, d.priceOutPer1M, 0, 1000),
    vadThreshold: num(s.vadThreshold, d.vadThreshold, 0.05, 0.95),
    volumeThreshold: num(s.volumeThreshold, d.volumeThreshold, 0, 0.02),
    silenceTimeoutS: num(s.silenceTimeoutS, d.silenceTimeoutS, 0.3, 2.0),
    maxChunkS: num(s.maxChunkS, d.maxChunkS, 3, 15),
    // Above ~1.5s this becomes a real filter: chunks carry ~0.3s preroll +
    // the silence tail as padding, so e.g. 2.0 skips utterances shorter than
    // roughly 1s of actual speech (single words, "うん", short interjections).
    minSpeechS: num(s.minSpeechS, d.minSpeechS, 0.1, 3.0),
    fontSizePx: Math.round(num(s.fontSizePx, d.fontSizePx, 12, 48)),
    autoHideS: Math.round(num(s.autoHideS, d.autoHideS, 2, 30)),
    outputMode: ["translate", "transcribe", "both"].includes(s.outputMode)
      ? s.outputMode
      : d.outputMode,
  };
};

// Official rate for Gemini audio input billing; used only when the response
// carries no usageMetadata.
HOLOTL.AUDIO_TOKENS_PER_SECOND = 32;
HOLOTL.OUTPUT_CHARS_PER_TOKEN = 4;

if (typeof globalThis !== "undefined") globalThis.HOLOTL = HOLOTL;
