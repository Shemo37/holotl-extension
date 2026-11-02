// CueTimer: speech windows → video-position cues for the subtitle file.
//
// Run:  node --test "tests/*.test.mjs"

import { test } from "node:test";
import assert from "node:assert/strict";
import { CueTimer } from "../offscreen/cue-timer.js";

const SR = 16000;

function makeTimer(video) {
  const cues = [];
  let noVideo = 0;
  const timer = new CueTimer({
    getVideoTime: async () => video(),
    onCue: (cue) => cues.push(cue),
    onNoVideo: () => noVideo++,
  });
  return { timer, cues, noVideo: () => noVideo };
}

const close = (actual, expected, tol = 0.02) =>
  assert.ok(Math.abs(actual - expected) < tol, `${actual} ≈ ${expected}`);

test("window start/end map to video position minus the audio-clock lag", async () => {
  let videoNow = 0;
  const { timer, cues } = makeTimer(() => ({ time: videoNow, paused: false, rate: 1 }));

  // Speech starts at audio 10.0 s; VAD notices at 10.3 s, when the video
  // is at 70.3 s (playback began 60 s into the video).
  timer.addSamples(10.3 * SR);
  videoNow = 70.3;
  const seq = timer.beginWindow(10.0 * SR);
  // Speech ends at audio 13.0 s; the window closes 0.9 s later.
  timer.addSamples(3.6 * SR);
  videoNow = 73.9;
  timer.endWindow(seq, 13.0 * SR);

  await timer.recordCue(seq, { jp: "こんにちは", en: "Hello" });
  assert.equal(cues.length, 1);
  close(cues[0].start, 70.0);
  close(cues[0].end, 73.0);
  assert.deepEqual([cues[0].seq, cues[0].jp, cues[0].en], [seq, "こんにちは", "Hello"]);
});

test("playback rate scales the lag; a paused video reads as-is", async () => {
  let reply = { time: 100, paused: false, rate: 2 };
  const { timer, cues } = makeTimer(() => reply);
  timer.addSamples(1.5 * SR);
  const seq = timer.beginWindow(1.0 * SR); // 0.5 s audio lag at 2x → 1 s video
  reply = { time: 100, paused: true, rate: 2 };
  timer.endWindow(seq, 1.5 * SR);
  await timer.recordCue(seq, { jp: "", en: "x" });
  close(cues[0].start, 99);
  assert.equal(cues[0].end, 100);
});

test("no <video>: falls back to time since Start and says so once", async () => {
  const { timer, cues, noVideo } = makeTimer(() => null);
  timer.addSamples(5 * SR);
  const a = timer.beginWindow(2 * SR);
  timer.endWindow(a, 4 * SR);
  const b = timer.beginWindow(4.5 * SR);
  timer.endWindow(b, 5 * SR);
  await timer.recordCue(a, { jp: "a", en: "A" });
  await timer.recordCue(b, { jp: "b", en: "B" });
  assert.deepEqual(cues.map((c) => [c.start, c.end]), [[2, 4], [4.5, 5]]);
  assert.equal(noVideo(), 1);
});

test("a subtitle that arrives before its window ends waits for the end", async () => {
  const { timer, cues } = makeTimer(() => ({ time: 10, paused: true, rate: 1 }));
  const seq = timer.beginWindow(0);
  const pending = timer.recordCue(seq, { jp: "早い", en: "Early" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cues.length, 0);
  timer.endWindow(seq, 0);
  await pending;
  assert.equal(cues.length, 1);
});

test("unknown windows, empty subtitles, and reset()", async () => {
  const { timer, cues } = makeTimer(() => ({ time: 1, paused: true, rate: 1 }));
  await timer.recordCue(0, { jp: "x", en: "y" }); // nothing started yet
  const seq = timer.beginWindow(0);
  timer.endWindow(seq, 0);
  await timer.recordCue(seq, { jp: "", en: "" });
  assert.equal(cues.length, 0);
  timer.reset();
  assert.equal(timer.latestSeq, 0);
  assert.equal(timer.beginWindow(0), 1);
});

test("old windows are forgotten after `history` newer ones", async () => {
  const { timer, cues } = makeTimer(() => ({ time: 1, paused: true, rate: 1 }));
  const first = timer.beginWindow(0);
  for (let i = 0; i < 50; i++) timer.beginWindow(0);
  await timer.recordCue(first, { jp: "late", en: "late" });
  assert.equal(cues.length, 0);
});
