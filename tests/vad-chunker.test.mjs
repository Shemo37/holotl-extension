// Unit tests for the DynamicChunker speech-window state machine. The
// volume-based fallback path (vad=null) and a stubbed VAD cover both
// branches without any ONNX runtime. Frame math: 512 samples = 32 ms.
//
// Streaming contract: onSpeechStart(preroll+first frames) opens a window,
// every in-window frame is forwarded immediately via onSpeechFrame, and
// onSpeechEnd fires after the silence timeout (or the safety cap) — no
// buffering until end-of-utterance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DynamicChunker } from "../offscreen/vad.js";

const SETTINGS = {
  vadThreshold: 0.25,
  volumeThreshold: 0.003,
  silenceTimeoutS: 0.7, // 21 frames
  softCutAfterS: 2.5, // 78 frames
  softCutSilenceS: 0.25, // 7 frames
  maxActiveS: 3.5, // 109 frames
};

const speechFrame = () => new Float32Array(512).fill(0.05); // rms 0.05
const silentFrame = () => new Float32Array(512);
const loudFrame = () => new Float32Array(512).fill(0.5); // peak > 0.1

function makeChunker(vad = null, settings = SETTINGS) {
  const events = [];
  const chunker = new DynamicChunker(vad, settings, {
    onSpeechStart: (frames) => events.push({ type: "start", frames }),
    onSpeechFrame: (frame) => events.push({ type: "frame", frame }),
    onSpeechEnd: (meta) => events.push({ type: "end", meta }),
  });
  return { chunker, events };
}

async function push(chunker, frames) {
  for (const f of frames) chunker.push(f);
  // push() drains asynchronously; wait for the queue to empty.
  while (chunker.busy || chunker.pending.length) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

test("speech opens a window, streams every frame, closes on silence", async () => {
  const { chunker, events } = makeChunker();

  // Short enough (~1.3s) that the window never ages past softCutAfterS —
  // the normal 21-frame silence timeout is what closes it.
  const speech = Array.from({ length: 40 }, speechFrame);
  const silence = Array.from({ length: 25 }, silentFrame); // > 21-frame timeout
  await push(chunker, [...speech, ...silence]);

  const starts = events.filter((e) => e.type === "start");
  const frames = events.filter((e) => e.type === "frame");
  const ends = events.filter((e) => e.type === "end");
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  // Frames stream DURING speech: 39 after the first (in the start batch)
  // plus the silence frames until the timeout closed the window.
  assert.ok(frames.length >= 39 + 21, `only ${frames.length} frames streamed`);
  assert.equal(ends[0].meta.forced, false);
});

test("frames stream immediately, not after the window closes", async () => {
  const { chunker, events } = makeChunker();

  // Speech with NO trailing silence: the window never closes, but the
  // audio must already have been forwarded.
  await push(chunker, Array.from({ length: 40 }, speechFrame));

  assert.equal(events.filter((e) => e.type === "end").length, 0);
  assert.ok(events.filter((e) => e.type === "frame").length >= 39);
  assert.equal(chunker.isSpeaking, true);
});

test("pre-roll frames are delivered in the start batch", async () => {
  const { chunker, events } = makeChunker();

  const silence = Array.from({ length: 15 }, silentFrame);
  const speech = Array.from({ length: 5 }, speechFrame);
  await push(chunker, [...silence, ...speech]);

  const start = events.find((e) => e.type === "start");
  // 9 pre-roll frames (~300 ms) + the triggering frame.
  assert.equal(start.frames.length, 9 + 1);
});

test("blips shorter than minSpeechS never open a window", async () => {
  const settings = { ...SETTINGS, minSpeechS: 0.15 }; // 4 frames to trigger
  const { chunker, events } = makeChunker(null, settings);

  // Repeated 2-frame blips (~64ms) separated by silence: all ignored.
  for (let i = 0; i < 5; i++) {
    await push(chunker, [speechFrame(), speechFrame(), ...Array.from({ length: 10 }, silentFrame)]);
  }
  assert.equal(events.length, 0);
});

test("sustained speech past minSpeechS opens with confirmation frames intact", async () => {
  const settings = { ...SETTINGS, minSpeechS: 0.15 }; // 4 frames to trigger
  const { chunker, events } = makeChunker(null, settings);

  await push(chunker, Array.from({ length: 10 }, speechFrame));

  const start = events.find((e) => e.type === "start");
  assert.ok(start, "window never opened");
  // The confirmation frames arrive in the start batch — no audio lost.
  assert.ok(start.frames.length >= 5, `confirmation frames dropped: ${start.frames.length}`);
});

test("silence alone never opens a window", async () => {
  const { chunker, events } = makeChunker();
  await push(chunker, Array.from({ length: 100 }, silentFrame));
  assert.equal(events.length, 0);
});

test("continuous speech is hard-cut at maxActiveS", async () => {
  const settings = { ...SETTINGS, softCutAfterS: 10, maxActiveS: 2 }; // 62 frames
  const { chunker, events } = makeChunker(null, settings);

  await push(chunker, Array.from({ length: 80 }, speechFrame));

  const ends = events.filter((e) => e.type === "end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].meta.forced, true);
  // Speech continues → a fresh window opens after the cut.
  assert.equal(events.filter((e) => e.type === "start").length, 2);
});

test("past softCutAfterS, a breath-length dip closes the window", async () => {
  const { chunker, events } = makeChunker();

  // ~3.1s of speech (past the 2.5s soft-cut age), then a 10-frame (~0.32s)
  // dip — shorter than the normal 21-frame timeout, but enough now.
  const speech = Array.from({ length: 96 }, speechFrame);
  const dip = Array.from({ length: 10 }, silentFrame);
  await push(chunker, [...speech, ...dip]);

  const ends = events.filter((e) => e.type === "end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].meta.forced, false);
});

test("before softCutAfterS, a breath-length dip does NOT close the window", async () => {
  const { chunker, events } = makeChunker();

  // ~1s of speech, a ~0.32s dip, then more speech: one unbroken window.
  const speech = Array.from({ length: 31 }, speechFrame);
  const dip = Array.from({ length: 10 }, silentFrame);
  const more = Array.from({ length: 20 }, speechFrame);
  await push(chunker, [...speech, ...dip, ...more]);

  assert.equal(events.filter((e) => e.type === "end").length, 0);
  assert.equal(events.filter((e) => e.type === "start").length, 1);
});

test("with VAD, loud BGM below the speech threshold never opens a window", async () => {
  // The BGM-proofing this design exists for: frames loud enough to pass any
  // RMS gate, but Silero says "not speech" — nothing may be sent.
  const stubVad = { probability: async () => 0.1, reset() {} };
  const { chunker, events } = makeChunker(stubVad);

  await push(chunker, Array.from({ length: 100 }, speechFrame));
  assert.equal(events.length, 0);
});

test("with VAD, speech-probability frames open and close a window", async () => {
  const stubVad = { probability: async () => 0.9, reset() {} };
  const { chunker, events } = makeChunker(stubVad);

  const speech = Array.from({ length: 60 }, speechFrame);
  const silence = Array.from({ length: 25 }, silentFrame); // rms pre-gate → not speech
  await push(chunker, [...speech, ...silence]);

  assert.equal(events.filter((e) => e.type === "start").length, 1);
  assert.equal(events.filter((e) => e.type === "end").length, 1);
});

test("loud frames halve the VAD threshold (shrieks count as speech)", async () => {
  // prob 0.15 is below vadThreshold 0.25 but above the loud-frame 0.125.
  const stubVad = { probability: async () => 0.15, reset() {} };
  const { chunker, events } = makeChunker(stubVad);

  const loud = Array.from({ length: 60 }, loudFrame);
  const silence = Array.from({ length: 25 }, silentFrame);
  await push(chunker, [...loud, ...silence]);

  assert.equal(events.filter((e) => e.type === "start").length, 1);
  assert.equal(events.filter((e) => e.type === "end").length, 1);
});
