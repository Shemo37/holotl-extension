// LocalPipelineClient against a scripted fake WebSocket: status mapping,
// readiness gating, subtitle shape, and when it stops reconnecting.
//
// Run:  node --test "tests/*.test.mjs"

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LocalPipelineClient,
  CLOSE_REPLACED,
} from "../offscreen/local-client.js";

class FakeSocket {
  static instances = [];
  constructor(url) {
    if (!/^wss?:\/\//.test(url)) throw new SyntaxError("invalid URL");
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  // test drivers
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(obj) {
    this.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) });
  }
  serverClose(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function makeClient(extra = {}) {
  FakeSocket.instances = [];
  const statuses = [];
  const subs = [];
  const client = new LocalPipelineClient({
    url: "ws://127.0.0.1:8765",
    reconnectDelayMs: 1,
    maxConsecutiveFailures: 3,
    WebSocketImpl: FakeSocket,
    onStatusChange: (status, message) => statuses.push([status, message]),
    onSubtitleUpdate: (sub) => subs.push(sub),
    ...extra,
  });
  return { client, statuses, subs, sockets: FakeSocket.instances };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("loading → ready maps to connecting → connected; audio gated on ready", () => {
  const { client, statuses, sockets } = makeClient();
  client.connect();
  const ws = sockets[0];
  ws.open();
  ws.message({ type: "status", status: "loading", message: "Loading ASR model..." });
  assert.equal(client.sendUtterance(new ArrayBuffer(4)), false);
  ws.message({ type: "status", status: "ready", message: "faster-whisper + fugumt" });
  assert.equal(client.sendUtterance(new ArrayBuffer(4)), true);
  // hello on open, then the one utterance sent after "ready"
  assert.equal(ws.sent.length, 2);
  assert.ok(ws.sent[1] instanceof ArrayBuffer);
  assert.deepEqual(statuses, [
    ["connecting", undefined],
    ["connecting", "Loading ASR model..."],
    ["connected", "faster-whisper + fugumt"],
  ]);
});

test("subtitles become {jp, en} with nulls as empty lines", () => {
  const { client, subs, sockets } = makeClient();
  client.connect();
  sockets[0].open();
  sockets[0].message({ type: "subtitle", id: 1, utterance_id: 7, jp: "みなさん", en: "Everyone", confidence: 0.9 });
  sockets[0].message({ type: "subtitle", id: 2, jp: null, en: "EN only", confidence: 0.8 });
  assert.deepEqual(subs, [
    { jp: "みなさん", en: "Everyone", utteranceId: 7 },
    { jp: "", en: "EN only", utteranceId: null }, // older server: no id
  ]);
});

test("server error is final: error status, no reconnect", async () => {
  const { client, statuses, sockets } = makeClient();
  client.connect();
  sockets[0].open();
  sockets[0].message({ type: "error", message: "Processing error: CUDA out of memory" });
  sockets[0].serverClose(1011);
  await tick();
  assert.equal(sockets.length, 1);
  assert.deepEqual(statuses.at(-1), [
    "error",
    "Local pipeline: Processing error: CUDA out of memory",
  ]);
  assert.equal(statuses.filter(([s]) => s === "stopped").length, 0);
});

test("server not running: gives up after maxConsecutiveFailures with a how-to", async () => {
  const { client, statuses, sockets } = makeClient();
  client.connect();
  for (let i = 0; i < 3; i++) {
    sockets[i].serverClose(1006);
    await tick();
  }
  assert.equal(sockets.length, 3);
  const [status, message] = statuses.at(-1);
  assert.equal(status, "error");
  assert.match(message, /not reachable at ws:\/\/127\.0\.0\.1:8765/);
  assert.match(message, /StartServer\.bat/);
});

test("a session that opened resets the failure count (server restart)", async () => {
  const { client, statuses, sockets } = makeClient();
  client.connect();
  sockets[0].serverClose(1006); // refused
  await tick();
  sockets[1].serverClose(1006); // refused
  await tick();
  sockets[2].open(); // server came up
  sockets[2].message({ type: "status", status: "ready", message: "x" });
  sockets[2].serverClose(1006); // server restarted mid-session
  await tick();
  assert.equal(sockets.length, 4);
  assert.notEqual(statuses.at(-1)[0], "error");
  assert.equal(client.sendUtterance(new ArrayBuffer(2)), false); // not ready yet
});

test("replaced by another client: error, no reconnect ping-pong", async () => {
  const { client, statuses, sockets } = makeClient();
  client.connect();
  sockets[0].open();
  sockets[0].serverClose(CLOSE_REPLACED, "replaced by a newer connection");
  await tick();
  assert.equal(sockets.length, 1);
  assert.equal(statuses.at(-1)[0], "error");
  assert.match(statuses.at(-1)[1], /Another client/);
});

test("disconnect() reports stopped and never reconnects", async () => {
  const { client, statuses, sockets } = makeClient();
  client.connect();
  sockets[0].open();
  client.disconnect();
  assert.equal(sockets[0].closed, true);
  sockets[0].serverClose(1000);
  await tick();
  assert.equal(sockets.length, 1);
  assert.deepEqual(statuses.at(-1), ["stopped", undefined]);
});

test("malformed URL fails immediately instead of retrying", () => {
  const { client, statuses, sockets } = makeClient({ url: "localhost:8765" });
  client.connect();
  assert.equal(sockets.length, 0);
  assert.equal(statuses.at(-1)[0], "error");
  assert.match(statuses.at(-1)[1], /Bad local server URL/);
});

test("hello with the target language goes out on open; setTargetLang resends it", () => {
  const { client, sockets } = makeClient({ targetLang: "th" });
  client.connect();
  const ws = sockets[0];
  client.setTargetLang("en"); // before open: nothing to send yet
  assert.equal(ws.sent.length, 0);
  ws.open();
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: "hello", target_lang: "en" });
  client.setTargetLang("th"); // live switch, same socket
  assert.deepEqual(JSON.parse(ws.sent[1]), { type: "hello", target_lang: "th" });
  assert.equal(sockets.length, 1);
});

test("a reconnect re-sends hello with the current language", async () => {
  const { client, sockets } = makeClient({ targetLang: "th" });
  client.connect();
  sockets[0].open();
  sockets[0].serverClose(1006); // server restarted
  await tick();
  sockets[1].open();
  assert.deepEqual(JSON.parse(sockets[1].sent[0]), { type: "hello", target_lang: "th" });
});

test("server refusing Thai (no Ollama engine) is a final error", async () => {
  const { client, statuses, sockets } = makeClient({ targetLang: "th" });
  client.connect();
  sockets[0].open();
  sockets[0].message({ type: "status", status: "ready", message: "faster-whisper + fugumt" });
  sockets[0].message({
    type: "error",
    message: "Thai subtitles need the Ollama translator, but this server is translating with faster-whisper + fugumt",
  });
  await tick();
  assert.equal(sockets.length, 1);
  assert.equal(statuses.at(-1)[0], "error");
  assert.match(statuses.at(-1)[1], /Thai subtitles need the Ollama translator/);
});

test("each utterance goes out as a 4-byte LE id + the PCM16 bytes", () => {
  const { client, sockets } = makeClient();
  client.connect();
  const ws = sockets[0];
  ws.open();
  ws.message({ type: "status", status: "ready", message: "x" });
  const pcm = new Int16Array([1000, -2000, 3000]);
  assert.equal(client.sendUtterance(pcm.buffer, 258), true);
  const sent = new Uint8Array(ws.sent.at(-1));
  assert.equal(new DataView(sent.buffer).getUint32(0, true), 258);
  assert.deepEqual([...new Int16Array(sent.buffer.slice(4))], [1000, -2000, 3000]);
});
