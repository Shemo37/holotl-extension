// Central configuration for the HoloLiveTL Live-API extension.
//
// Everything that touches the Gemini Live wire schema lives here or in
// offscreen/gemini-client.js, so a schema change on a preview model is a
// one-file fix. Set DEBUG = true and the client logs the first raw server
// frame verbatim — paste that log to diagnose any schema drift.

// The model is ONE constant: swap it here and nothing else changes.
// Default is a general Live model that follows the JP:/EN:/TH: system
// instruction, so transcription AND translation arrive over the socket.
// In practice this model streams inputTranscription (JA speech) and
// outputTranscription (translation) events rather than prefixed turn text;
// the client handles both shapes and keeps the two streams on separate
// overlay lines.
// "gemini-2.0-flash" is the named alternate. If you swap in the dedicated
// "models/gemini-3.5-transcribe-live" instead: it ignores translation
// instructions (JP-only output, the second line stays empty), it needs
// SETUP_OVERRIDES below, and it refuses to transcribe singing over music.
export const LIVE_MODEL = "models/gemini-3.5-live-translate-preview";

export const WS_URL_BASE =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// Per-target-language system instructions, keyed by the popup's dropdown
// value. Sent in the setup message; changing language mid-session
// reconnects the socket so the new instruction takes effect.
export const SYSTEM_INSTRUCTIONS = {
  en:
    "You are a real-time transcriber and translator for a live Japanese " +
    "stream. For every utterance you hear, output exactly two lines and " +
    "nothing else:\n" +
    "JP: <the verbatim Japanese transcription>\n" +
    "EN: <the natural English translation>\n" +
    "No preamble, no romaji, no quotes, no commentary. If the audio " +
    "contains no speech, output nothing at all.",
  th:
    "You are a real-time transcriber and translator for a live Japanese " +
    "stream. For every utterance you hear, output exactly two lines and " +
    "nothing else:\n" +
    "JP: <the verbatim Japanese transcription>\n" +
    "TH: <the natural Thai translation>\n" +
    "No preamble, no romaji, no quotes, no commentary. If the audio " +
    "contains no speech, output nothing at all.",
};
export const DEFAULT_TARGET_LANG = "en";

// Appended to the system instruction so talent names are spelled right.
// Set to "" to disable.
export const ROSTER_HINT =
  " Names that may be spoken include: Tokino Sora, Roboco, Sakura Miko, " +
  "Hoshimachi Suisei, AZKi, Shirakami Fubuki, Natsuiro Matsuri, " +
  "Aki Rosenthal, Akai Haato, Murasaki Shion, Nakiri Ayame, Yuzuki Choco, " +
  "Oozora Subaru, Ookami Mio, Nekomata Okayu, Inugami Korone, Usada Pekora, " +
  "Shiranui Flare, Shirogane Noel, Houshou Marine, Amane Kanata, " +
  "Tsunomaki Watame, Tokoyami Towa, Himemori Luna, Yukihana Lamy, " +
  "Momosuzu Nene, Shishiro Botan, Omaru Polka, La+ Darknesss, Takane Lui, " +
  "Hakui Koyori, Kazama Iroha.";

// Extra fields merged into the setup payload's `setup` object, applied last
// so they win. Empty for general Live models. Hard-won fact from this
// repo's earlier transcribe-live experiments: that model needs
//   { inputAudioTranscription: { mode: "VERBATIM" } }
// — mode "SMART" silently produces no output. The wire format is camelCase.
// If the server closes the socket right after setup, this block and the
// model id are the first suspects: check the close code/reason logged in
// the offscreen console (DEBUG) and adjust here.
export const SETUP_OVERRIDES = {};

// Live streaming bills roughly by audio minutes sent.
export const PRICE_PER_MIN = 0.009; // USD per minute of audio

// Client-side Silero VAD in front of the Live socket. Silero decides which
// audio is worth streaming (BGM-proof, unlike an RMS gate) and audio is
// STREAMED LIVE inside each detected speech window — the model translates
// while the sentence is still being spoken, so subtitles land near-realtime
// instead of one utterance late. Only window audio is sent, so the cost
// meter reflects speech time, not stream time. Thresholds carry the
// desktop app's tuning.
export const USE_SILERO_VAD = true;
export const VAD_SETTINGS = {
  vadThreshold: 0.25, // Silero speech probability
  volumeThreshold: 0.003, // cheap RMS pre-gate below which VAD never runs
  // This much silence closes the speech window (finalizes the turn).
  silenceTimeoutS: 0.7,
  // Continuous speech required BEFORE a window opens — filters coughs,
  // clicks, and one-frame blips from producing junk sends. Covered by the
  // pre-roll buffer, so raising it costs no audio, just adds that much
  // onset delay. 0 disables.
  minSpeechS: 0.1,
  // The model delivers its translation when the window closes, so run-on
  // speech (radio-style streams) must be cut into short turns like the old
  // chunked engine did: past softCutAfterS a breath-length dip
  // (softCutSilenceS) is enough to close the window, and maxActiveS
  // hard-cuts mid-speech as a last resort. Larger values = better
  // sentence-level translation, smaller = snappier subtitles.
  softCutAfterS: 2.5,
  softCutSilenceS: 0.25,
  maxActiveS: 3.5,
};

// Each VAD speech window is bracketed by the Live API's manual activity
// signals (activityStart when speech begins, activityEnd on the silence
// timeout, with the server's automatic detection disabled in setup), so
// every utterance becomes its own model turn. If the preview model rejects
// the setup field (socket closes before any server message), the client
// auto-retries without the signals after 2 failed sessions and VAD keeps
// working as a pure send gate.
export const MANUAL_ACTIVITY = true;

// Silence gate for the NON-VAD fallback path only (Silero failed to load):
// chunks whose RMS stays below the threshold for longer than the hangover
// are not sent (saves money during BGM lulls / dead air).
export const SILENCE_RMS_THRESHOLD = 0.008;
export const SILENCE_HANGOVER_MS = 1000;

// Reconnect behavior around the ~15-minute Live session limit.
export const RECONNECT_DELAY_MS = 500;
export const MAX_CONSECUTIVE_FAILURES = 10;

// Overlay appearance defaults (popup → Appearance tab). The overlay content
// script can't import this module — keep content/overlay.js's
// APPEARANCE_DEFAULTS in sync when editing.
export const DEFAULT_APPEARANCE = {
  fontSizePx: 24, // JP line; translation line renders at 80%
  jpColor: "#ffffff",
  enColor: "#d3e6ff",
  outlineWidthPx: 2, // 0 disables the outline
  outlineColor: "#000000",
  bgOpacity: 82, // percent, 0 = fully transparent box
};

// DEBUG logs the first raw server frame verbatim plus close codes/reasons.
export const DEBUG = true;

// Fake-segment mode: no WebSocket, no tab capture — the offscreen document
// emits canned JP/EN pairs so the overlay/popup pipeline can be smoke-tested
// without an API key. Never ship true.
export const DEBUG_FAKE_SUBTITLES = false;
