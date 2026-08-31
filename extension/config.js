// Central configuration for the HoloLiveTL Live-API extension.
//
// Everything that touches the Gemini Live wire schema lives here or in
// offscreen/gemini-client.js, so a schema change on a preview model is a
// one-file fix. Set DEBUG = true and the client logs the first raw server
// frame verbatim — paste that log to diagnose any schema drift.

// The model is ONE constant: swap it here and nothing else changes.
// Default is a general Live model that follows the JP:/EN:/TH: system
// instruction, so transcription AND translation arrive over the socket.
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
// so they win. Empty for general Live models. Hard-won fact from the
// earlier transcribe-live work (see root README): that model needs
//   { inputAudioTranscription: { mode: "VERBATIM" } }
// — mode "SMART" silently produces no output. The wire format is camelCase.
// If the server closes the socket right after setup, this block and the
// model id are the first suspects: check the close code/reason logged in
// the offscreen console (DEBUG) and adjust here.
export const SETUP_OVERRIDES = {};

// Live streaming bills roughly by audio minutes sent.
export const PRICE_PER_MIN = 0.009; // USD per minute of audio

// Silence gate: chunks whose RMS stays below the threshold for longer than
// the hangover are not sent (saves money during BGM lulls / dead air).
export const SILENCE_RMS_THRESHOLD = 0.008;
export const SILENCE_HANGOVER_MS = 1000;

// Reconnect behavior around the ~15-minute Live session limit.
export const RECONNECT_DELAY_MS = 500;
export const MAX_CONSECUTIVE_FAILURES = 10;

// DEBUG logs the first raw server frame verbatim plus close codes/reasons.
export const DEBUG = true;

// Fake-segment mode: no WebSocket, no tab capture — the offscreen document
// emits canned JP/EN pairs so the overlay/popup pipeline can be smoke-tested
// without an API key. Never ship true.
export const DEBUG_FAKE_SUBTITLES = false;
