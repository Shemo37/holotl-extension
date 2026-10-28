// SRT building for the end-of-session subtitle file.
//
// Run:  node --test "tests/*.test.mjs"

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSrt, formatSrtTime, srtFilename } from "../srt.js";

test("timestamps use HH:MM:SS,mmm", () => {
  assert.equal(formatSrtTime(0), "00:00:00,000");
  assert.equal(formatSrtTime(3725.4567), "01:02:05,457");
  assert.equal(formatSrtTime(-2), "00:00:00,000");
});

test("cues: numbered, sorted, JP above translation, CRLF", () => {
  const srt = buildSrt([
    { seq: 2, start: 12.5, end: 15.25, jp: "ありがとう", en: "Thank you" },
    { seq: 1, start: 3.2, end: 6.0, jp: "こんにちは", en: "Hello" },
  ]);
  assert.equal(
    srt,
    "1\r\n00:00:03,200 --> 00:00:06,000\r\nこんにちは\r\nHello\r\n\r\n" +
      "2\r\n00:00:12,500 --> 00:00:15,250\r\nありがとう\r\nThank you\r\n"
  );
});

test("short cues get reading time, but never run into the next cue", () => {
  const srt = buildSrt([
    { start: 10, end: 10.2, jp: "え", en: "Eh" }, // stretched to 1 s
    { start: 20, end: 20.1, jp: "うん", en: "Yeah" }, // stretched, then...
    { start: 20.5, end: 22, jp: "そう", en: "Right" }, // ...cut here
  ]);
  assert.match(srt, /00:00:10,000 --> 00:00:11,000/);
  assert.match(srt, /00:00:20,000 --> 00:00:20,500/);
});

test("missing end, missing lines, and unusable cues", () => {
  const srt = buildSrt([
    { start: 5, end: null, jp: "", en: "EN only" },
    { start: null, end: 9, jp: "x", en: "no start" },
    { start: 7, end: 8, jp: "", en: "" },
  ]);
  assert.equal(srt, "1\r\n00:00:05,000 --> 00:00:06,000\r\nEN only\r\n");
  assert.equal(buildSrt([]), "");
});

test("filename comes from the session start time", () => {
  const name = srtFilename(new Date(2026, 9, 28, 21, 5).getTime());
  assert.equal(name, "holotl-2026-10-28-2105.srt");
});
