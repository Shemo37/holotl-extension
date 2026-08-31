// Subtitle overlay, injected on demand by background.js via
// chrome.scripting (overlay.css is inserted first). Plain script — runs in
// the page's isolated world, guarded against double injection.

(() => {
  if (window.__holotlLiveOverlay) return;
  window.__holotlLiveOverlay = true;

  const CLEAR_AFTER_MS = 4000;

  const box = document.createElement("div");
  box.id = "holotl-overlay-box";

  const statusDot = document.createElement("span");
  statusDot.id = "holotl-status-dot";
  statusDot.dataset.status = "connecting";
  statusDot.title = "HoloLiveTL: connecting";

  const jpEl = document.createElement("div");
  jpEl.id = "holotl-jp-sub";

  const enEl = document.createElement("div");
  enEl.id = "holotl-en-sub";

  const msgEl = document.createElement("div");
  msgEl.id = "holotl-status-msg";

  box.append(statusDot, jpEl, enEl, msgEl);
  (document.body || document.documentElement).appendChild(box);

  let clearTimer = null;

  function showSubtitles(jp, en) {
    jpEl.textContent = jp || "";
    enEl.textContent = en || "";
    msgEl.textContent = "";
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      jpEl.textContent = "";
      enEl.textContent = "";
    }, CLEAR_AFTER_MS);
  }

  function showStatus(status, message) {
    statusDot.dataset.status = status;
    statusDot.title = `HoloLiveTL: ${status}`;
    msgEl.textContent = status === "error" ? message || "error" : "";
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === "UPDATE_SUBTITLES") {
      showSubtitles(msg.payload?.jp, msg.payload?.en);
    } else if (msg?.action === "STATUS_UPDATE") {
      showStatus(msg.payload?.status, msg.payload?.message);
    }
  });

  // Draggable: pointer-drag anywhere on the box repositions it.
  let drag = null;
  box.addEventListener("pointerdown", (e) => {
    const rect = box.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    box.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const x = Math.min(
      Math.max(0, e.clientX - drag.dx),
      window.innerWidth - box.offsetWidth
    );
    const y = Math.min(
      Math.max(0, e.clientY - drag.dy),
      window.innerHeight - box.offsetHeight
    );
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.bottom = "auto";
    box.style.transform = "none";
  });
  box.addEventListener("pointerup", (e) => {
    drag = null;
    box.releasePointerCapture(e.pointerId);
  });

  // Follow fullscreen video so subtitles stay visible in theater mode.
  document.addEventListener("fullscreenchange", () => {
    (document.fullscreenElement || document.body).appendChild(box);
  });
})();
