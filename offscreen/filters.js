// Port of src/modules/filters.py — pure string work. The phrase-based English
// hallucination lists were removed there by request (short real utterances
// like "thank you" are legitimate subtitles); only structural junk detection
// remains. Do not reintroduce them here.

// Refusal boilerplate: the desktop list (leaked by kotoba-whisper's
// LLM-generated training data) plus Gemini-flavored refusals/no-speech
// markers. Plain substring matching — \b word boundaries don't work inside
// Japanese text.
const BOILERPLATE_FILTER = [
  "正確な翻訳を提供できません",
  "翻訳を提供できません",
  "文脈が不明確",
  "翻訳できません",
  "cannot provide an accurate translation",
  "the context is unclear",
  // Gemini-style refusals / empty-audio markers
  "i cannot ",
  "i'm unable to",
  "i am unable to",
  "no speech",
  "[no speech]",
  "(no speech)",
  "（音声なし）",
  "音声が含まれていません",
  "audio contains no",
  "no audible speech",
  "there is no speech",
];

const QUALITY_INDICATORS = [
  // repetitive patterns
  /(.{1,10})\1{3,}/i,
  /(\w+\s+)\1{2,}/i,
  // nonsense patterns
  /[a-z]{20,}/,
  /\b\w\s+\w\s+\w\b/,
  // filler heavy
  /\b(um|uh|ah|eh|mm)\b.*\b(um|uh|ah|eh|mm)\b.*\b(um|uh|ah|eh|mm)\b/,
];

// Patterns marking the onset of decoder degeneration. Used to TRIM the junk
// tail off a line rather than discard the whole line.
const DEGENERATE_TAIL_PATTERNS = [/(.{1,10})\1{3,}/i, /(\w+\s+)\1{2,}/i, /[a-z]{25,}/];

// Equivalent of Python's string.punctuation for the punctuation-only check.
const PUNCT_RE = /[!-\/:-@\[-`{-~]/g;

function trimDegenerateTail(text) {
  let cut = text.length;
  for (const pattern of DEGENERATE_TAIL_PATTERNS) {
    const m = pattern.exec(text);
    if (m) cut = Math.min(cut, m.index);
  }
  if (cut >= text.length) return text;
  return text.slice(0, cut).replace(/[\s,;:\-–—]+$/, "");
}

function postProcessTranslation(text) {
  text = text.split(/\s+/).join(" ");
  text = text.replace(/^[\s,;:]+/, "");
  text = text.replace(/\s+([,.!?;:])/g, "$1");
  text = text.replace(/([.!?])\s*([a-z])/g, "$1 $2");
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
  text = text.replace(/([.!?]){2,}/g, "$1");
  text = text.replace(/\bi\b/g, "I");
  text = text.replace(/\bim\b/g, "I'm");
  text = text.replace(/\bdont\b/g, "don't");
  text = text.replace(/\bcant\b/g, "can't");
  text = text.replace(/\bwont\b/g, "won't");

  if (text.split(" ").filter(Boolean).length === 1) {
    text = text.replace(/\.+$/, "");
  }
  return text.trim();
}

function isHallucination(text, translationHistory) {
  if (!text || !text.trim()) return true;

  const textLower = text.toLowerCase().trim();
  const textClean = text.replace(PUNCT_RE, "").toLowerCase().trim();

  // Punctuation-only output ('.', '!!', '...') carries no content.
  if (!textClean) return true;

  for (const phrase of BOILERPLATE_FILTER) {
    if (text.includes(phrase) || textLower.includes(phrase)) return true;
  }

  for (const pattern of QUALITY_INDICATORS) {
    if (pattern.test(textLower)) return true;
  }

  if (translationHistory.length >= 3) {
    const recent = translationHistory.slice(-3).map((t) => t.toLowerCase().trim());
    if (recent.includes(textLower)) return true;
  }

  return false;
}

// Strip markdown fences / wrapping quotes Gemini sometimes adds despite the
// "output only" prompt.
function stripDecorations(text) {
  let t = text.trim();
  t = t.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "");
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["「", "」"],
  ];
  for (const [open, close] of pairs) {
    if (t.startsWith(open) && t.endsWith(close) && t.length > 1) {
      t = t.slice(open.length, t.length - close.length).trim();
    }
  }
  return t.trim();
}
