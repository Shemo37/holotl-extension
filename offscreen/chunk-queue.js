// Bounded drop-oldest queue between the VAD and the Gemini caller — port of
// put_latest() in recorder.py. Live subtitles want the newest audio: if the
// API falls behind, blocking would make subtitles drift permanently behind
// the stream, so overload becomes dropped chunks instead.

class ChunkQueue {
  constructor(maxSize = HOLOTL.CHUNK_QUEUE_SIZE) {
    this.maxSize = maxSize;
    this.items = [];
    this.waiter = null;
    this.closed = false;
  }

  putLatest(item) {
    if (this.closed) return;
    while (this.items.length >= this.maxSize) {
      this.items.shift();
      console.warn("⚠️ Audio queue full - dropped oldest chunk to stay live");
    }
    this.items.push(item);
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve();
    }
  }

  /** Resolves with the next item, or null once the queue is closed. */
  async take() {
    while (this.items.length === 0) {
      if (this.closed) return null;
      await new Promise((resolve) => (this.waiter = resolve));
    }
    return this.items.shift();
  }

  close() {
    this.closed = true;
    this.items = [];
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve();
    }
  }
}
