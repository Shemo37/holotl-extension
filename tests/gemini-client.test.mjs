// Repro + regression tests for subtitle assembly in GeminiLiveClient.
//
// Run:  node --test "tests/*.test.mjs"
//
// The client is dependency-free until connect(), so _handleMessage can be
// driven directly with simulated server frames — no WebSocket, no API key.
//
// Display contract (window display): each VAD speech window becomes exactly
// ONE subtitle pair — the window's full Japanese and full translation,
// shown together when the turn finishes (server turnComplete or
// generationComplete, or client flushTurn() when the next window opens).
// Nothing renders mid-window, and the streams never mix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiLiveClient } from "../offscreen/gemini-client.js";

function makeClient(extraOpts = {}) {
  const updates = [];
  const client = new GeminiLiveClient({
    apiKey: "test",
    model: "models/test",
    wsUrlBase: "wss://example.invalid",
    systemInstruction: "test",
    onSubtitleUpdate: (sub) => updates.push(sub),
    ...extraOpts,
  });
  return { client, updates };
}

async function feed(client, serverContent) {
  await client._handleMessage(JSON.stringify({ serverContent }));
}

test("nothing shows mid-window; the boundary shows the FULL window pair", async () => {
  const { client, updates } = makeClient();

  // Text streams in pieces — including sentence punctuation mid-window.
  // None of it may render, and none of it may be discarded.
  await feed(client, { inputTranscription: { text: "やりたかったんです" } });
  await feed(client, { outputTranscription: { text: "I wanted to do it," } });
  await feed(client, { inputTranscription: { text: "けどつって。タコは取られてた" } });
  await feed(client, { outputTranscription: { text: " but the octopus was taken" } });
  assert.equal(updates.length, 0);

  await feed(client, { turnComplete: true });
  const last = updates.at(-1);
  assert.equal(last.jp, "やりたかったんですけどつって。タコは取られてた");
  assert.equal(last.en, "I wanted to do it, but the octopus was taken");
  // The regression this guards against: translation text bleeding into jp.
  assert.doesNotMatch(last.jp, /wanted|octopus/);
});

test("generationComplete is a turn boundary too", async () => {
  const { client, updates } = makeClient();

  await feed(client, { inputTranscription: { text: "おはよう" } });
  await feed(client, { outputTranscription: { text: "Good morning" } });
  await feed(client, { generationComplete: true });

  const flushed = updates.at(-1);
  assert.equal(flushed.jp, "おはよう");
  assert.equal(flushed.en, "Good morning");

  // Next window starts clean: no cross-window accumulation or stale EN.
  await feed(client, { inputTranscription: { text: "つぎ" } });
  await feed(client, { turnComplete: true });
  const last = updates.at(-1);
  assert.equal(last.jp, "つぎ");
  assert.equal(last.en, "");
});

test("flushTurn() pairs the window client-side when the server never marks turns", async () => {
  const { client, updates } = makeClient();

  await feed(client, { inputTranscription: { text: "エアコンが壊れてて" } });
  await feed(client, { outputTranscription: { text: "the AC is broken" } });

  // Next VAD window opens → offscreen flushes the previous window.
  client.flushTurn();
  const flushed = updates.at(-1);
  assert.equal(flushed.jp, "エアコンが壊れてて");
  assert.equal(flushed.en, "the AC is broken");

  await feed(client, { inputTranscription: { text: "盆地で暑いんですよ。" } });
  client.flushTurn();
  const last = updates.at(-1);
  assert.equal(last.jp, "盆地で暑いんですよ。");
  assert.equal(last.en, "");
});

test("an empty window flushes nothing and emits nothing", async () => {
  const { client, updates } = makeClient();
  client.flushTurn();
  await feed(client, { turnComplete: true });
  assert.equal(updates.length, 0);
});

test("prefixed modelTurn text still wins over transcription events", async () => {
  const { client, updates } = makeClient();

  await feed(client, { inputTranscription: { text: "こんにちは" } });
  await feed(client, {
    modelTurn: { parts: [{ text: "JP: こんにちは、みなさん\nTH: สวัสดีทุกคน" }] },
  });

  const last = updates.at(-1);
  assert.equal(last.jp, "こんにちは、みなさん");
  assert.equal(last.en, "สวัสดีทุกคน");
});

test("an identical window repeated after a boundary re-emits", async () => {
  const { client, updates } = makeClient();

  await feed(client, { inputTranscription: { text: "かわいい！" } });
  await feed(client, { turnComplete: true });
  const countAfterFirst = updates.length;

  await feed(client, { inputTranscription: { text: "かわいい！" } });
  await feed(client, { turnComplete: true });
  assert.ok(updates.length > countAfterFirst, "repeat window was suppressed");
  assert.equal(updates.at(-1).jp, "かわいい！");
});

test("a tail-truncated line is marked with a leading ellipsis", async () => {
  const { client, updates } = makeClient();

  await feed(client, { inputTranscription: { text: "あ".repeat(150) } });
  await feed(client, { turnComplete: true });

  const last = updates.at(-1);
  assert.ok(last.jp.startsWith("…"), `no ellipsis: ${last.jp.slice(0, 5)}`);
  assert.ok(last.jp.length <= 125, `too long: ${last.jp.length}`);
});

test("both lines stay bounded independently", async () => {
  const { client, updates } = makeClient();

  for (let i = 0; i < 30; i++) {
    await feed(client, { inputTranscription: { text: "あいうえおかきくけこ" } });
    await feed(client, { outputTranscription: { text: " twelve chars" } });
  }
  await feed(client, { turnComplete: true });

  const last = updates.at(-1);
  assert.ok(last.jp.length <= 125, `jp too long: ${last.jp.length}`);
  assert.ok(last.en.length <= 125, `en too long: ${last.en.length}`);
  assert.doesNotMatch(last.jp, /twelve/);
  assert.doesNotMatch(last.en, /あいう/);
});

test("reconnect drops partial lines from a session that died mid-utterance", async () => {
  const { client, updates } = makeClient();

  // Session dies after partial frames, before any turn boundary.
  await feed(client, { inputTranscription: { text: "とちゅうで" } });
  await feed(client, { outputTranscription: { text: "midway" } });

  // connect() opens a WebSocket; stub the global so only the state reset runs.
  const RealWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    close() {}
  };
  try {
    client.connect();
  } finally {
    globalThis.WebSocket = RealWebSocket;
  }

  await feed(client, { inputTranscription: { text: "あたらしい。" } });
  await feed(client, { turnComplete: true });
  const last = updates.at(-1);
  assert.equal(last.jp, "あたらしい。");
  assert.equal(last.en, "");
});

// ---- manual activity detection / streaming sends ----

class FakeWebSocket {
  constructor() {
    this.sent = [];
    this.readyState = FakeWebSocket.OPEN;
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
}
FakeWebSocket.OPEN = 1;

function makeConnectedClient(extraOpts = {}) {
  const made = makeClient(extraOpts);
  const RealWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    made.client.connect();
  } finally {
    globalThis.WebSocket = RealWebSocket;
  }
  // WebSocket.OPEN is read off the global at send time in the client; the
  // fake's readyState of 1 matches the real constant.
  return made;
}

test("manualActivity puts realtimeInputConfig in setup and brackets a window", () => {
  const { client } = makeConnectedClient({ manualActivity: true });
  client.ws.onopen();

  const setup = client.ws.sent[0].setup;
  assert.deepEqual(setup.realtimeInputConfig, {
    automaticActivityDetection: { disabled: true },
  });

  // The streaming shape: window opens, audio streams, window closes.
  assert.equal(client.startActivity(), true);
  client.sendAudioChunk("QUFB");
  client.sendAudioChunk("QkJC");
  assert.equal(client.endActivity(), true);

  const frames = client.ws.sent.slice(1);
  assert.deepEqual(frames[0], { realtimeInput: { activityStart: {} } });
  assert.equal(frames[1].realtimeInput.mediaChunks[0].data, "QUFB");
  assert.equal(frames[2].realtimeInput.mediaChunks[0].data, "QkJC");
  assert.deepEqual(frames[3], { realtimeInput: { activityEnd: {} } });
});

test("without manualActivity, activity signals are no-ops and audio is plain", () => {
  const { client } = makeConnectedClient();
  client.ws.onopen();

  assert.equal(client.ws.sent[0].setup.realtimeInputConfig, undefined);

  assert.equal(client.startActivity(), false);
  client.sendAudioChunk("QUFB");
  assert.equal(client.endActivity(), false);

  const frames = client.ws.sent.slice(1);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].realtimeInput.mediaChunks[0].data, "QUFB");
});

test("manualActivity is dropped after two sessions die before any message", () => {
  const { client } = makeConnectedClient({ manualActivity: true });

  const RealWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    // Two dead sessions (close with no server message) → give up on the
    // setup field; the third connect must omit it.
    client.ws.onclose({ code: 1007, reason: "invalid argument" });
    client.ws.onclose({ code: 1007, reason: "invalid argument" });
    clearTimeout(client._reconnectTimer);
    client.connect();
    client.ws.onopen();
  } finally {
    globalThis.WebSocket = RealWebSocket;
  }

  assert.equal(client.manualActivity, false);
  assert.equal(client.ws.sent.at(-1).setup.realtimeInputConfig, undefined);
});
