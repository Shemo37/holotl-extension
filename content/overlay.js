// HoloTL subtitle overlay — injected on demand into the captured tab.
// Self-contained (no shared files): closed shadow DOM so page CSS can't touch
// it, draggable, JP+EN two-line support, auto-hide after idle, and it follows
// the fullscreen element so subtitles stay visible over fullscreen video.

(() => {
  if (window.__holotlOverlay) return;
  window.__holotlOverlay = true;

  const DEFAULTS = { fontSizePx: 24, autoHideS: 6 };
  let settings = { ...DEFAULTS };
  let overlayPos = null; // {xPct, yPct}
  let hideTimer = null;
  let dead = false; // once torn down, this instance must never render again

  const host = document.createElement("div");
  host.id = "holotl-root";
  host.style.cssText =
    "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .box {
      position: fixed;
      left: 50%;
      bottom: 8%;
      transform: translateX(-50%);
      max-width: 80vw;
      padding: 10px 18px;
      border-radius: 10px;
      background: rgba(20, 20, 20, 0.68);
      pointer-events: auto;
      cursor: grab;
      user-select: none;
      opacity: 0;
      transition: opacity 0.35s ease;
      font-family: "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
      text-align: center;
      box-sizing: border-box;
    }
    .box.visible { opacity: 1; }
    .box.dragging { cursor: grabbing; transition: none; }
    .line {
      color: #ffffff;
      font-weight: 700;
      line-height: 1.35;
      text-shadow: 0 0 4px rgba(0,0,0,0.9), 0 2px 3px rgba(0,0,0,0.8);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .line.ja {
      opacity: 0.85;
      font-weight: 500;
    }
    .box.partial .line.ja {
      opacity: 0.6;
      font-style: italic;
    }
    .line.error {
      color: #ff8a80;
      font-weight: 600;
    }
    .line:empty { display: none; }
    .prev {
      color: #ffffff;
      opacity: 0.5;
      font-weight: 500;
      line-height: 1.3;
      text-shadow: 0 0 4px rgba(0,0,0,0.9);
      white-space: pre-wrap;
      word-break: break-word;
      margin-bottom: 4px;
    }
    .prev:empty { display: none; }
  `;
  shadow.appendChild(style);

  const box = document.createElement("div");
  box.className = "box";
  const prevLine = document.createElement("div");
  prevLine.className = "prev";
  const jaLine = document.createElement("div");
  jaLine.className = "line ja";
  const enLine = document.createElement("div");
  enLine.className = "line";
  box.appendChild(prevLine);
  box.appendChild(jaLine);
  box.appendChild(enLine);
  shadow.appendChild(box);
  let currentIsFinal = false; // partials must never be promoted to history

  function applySettings() {
    const size = settings.fontSizePx || DEFAULTS.fontSizePx;
    enLine.style.fontSize = size + "px";
    jaLine.style.fontSize = Math.round(size * 0.8) + "px";
    prevLine.style.fontSize = Math.round(size * 0.7) + "px";
    if (overlayPos) {
      box.style.left = overlayPos.xPct + "%";
      box.style.top = overlayPos.yPct + "%";
      box.style.bottom = "auto";
      box.style.transform = "translateX(-50%)";
    }
  }

  function mount() {
    if (dead) return; // a removed instance must not resurrect its box
    const parent = document.fullscreenElement || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      box.classList.remove("visible");
      // Stale text must not resurface as "previous" after a quiet gap.
      prevLine.textContent = "";
      currentIsFinal = false;
    }, (settings.autoHideS || 6) * 1000);
  }

  function showSubtitle({ ja, en, partial }) {
    if (partial) {
      // Live word-by-word updates touch only the JP line — the last finished
      // translation stays readable on the EN line until the next one lands.
      jaLine.textContent = ja || "";
      currentIsFinal = false;
    } else {
      // When results arrive in a burst (an in-order delivery unblocking
      // several at once), each line would instantly bury the last — keep the
      // previous finished line visible, dimmed, above the current one.
      if (currentIsFinal && (jaLine.textContent || enLine.textContent)) {
        prevLine.textContent = [jaLine.textContent, enLine.textContent]
          .filter(Boolean)
          .join("\n");
      }
      jaLine.textContent = ja || "";
      enLine.textContent = en || "";
      currentIsFinal = true;
    }
    enLine.classList.remove("error");
    box.classList.toggle("partial", !!partial);
    box.classList.add("visible");
    mount();
    scheduleHide();
  }

  function showError(message) {
    prevLine.textContent = "";
    jaLine.textContent = "";
    enLine.textContent = "⚠ HoloTL: " + (message || "Engine stopped.");
    enLine.classList.add("error");
    box.classList.add("visible");
    mount();
    if (hideTimer) clearTimeout(hideTimer); // errors stay until dismissed
  }

  function removeOverlay() {
    // Full teardown: without unhooking the listeners, a stopped instance
    // keeps receiving subtitles and re-appends its box next to the fresh
    // one injected by the following session (stacked ghost overlays).
    dead = true;
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    document.removeEventListener("fullscreenchange", mount);
    box.classList.remove("visible");
    setTimeout(() => {
      host.remove();
      window.__holotlOverlay = false;
    }, 400);
  }

  // --- dragging ---------------------------------------------------------
  let drag = null;
  box.addEventListener("pointerdown", (e) => {
    drag = { startX: e.clientX, startY: e.clientY, rect: box.getBoundingClientRect(), moved: false };
    box.setPointerCapture(e.pointerId);
    box.classList.add("dragging");
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    const cx = drag.rect.left + drag.rect.width / 2 + dx;
    const cy = drag.rect.top + dy;
    box.style.left = (cx / window.innerWidth) * 100 + "%";
    box.style.top = (cy / window.innerHeight) * 100 + "%";
    box.style.bottom = "auto";
    box.style.transform = "translateX(-50%)";
  });
  box.addEventListener("pointerup", (e) => {
    if (!drag) return;
    box.classList.remove("dragging");
    if (drag.moved) {
      const rect = box.getBoundingClientRect();
      overlayPos = {
        xPct: ((rect.left + rect.width / 2) / window.innerWidth) * 100,
        yPct: (rect.top / window.innerHeight) * 100,
      };
      chrome.storage.local.set({ overlayPos }).catch?.(() => {});
    }
    drag = null;
  });

  document.addEventListener("fullscreenchange", mount);

  // --- wiring -----------------------------------------------------------
  function onRuntimeMessage(msg) {
    if (dead || msg?.target !== "content") return;
    switch (msg.type) {
      case "subtitle":
        showSubtitle(msg.payload || {});
        break;
      case "engine-dead":
        showError(msg.payload?.message);
        break;
      case "session-ended":
        removeOverlay();
        break;
    }
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.fontSizePx) settings.fontSizePx = changes.fontSizePx.newValue;
    if (changes.autoHideS) settings.autoHideS = changes.autoHideS.newValue;
    if (changes.overlayPos) {
      overlayPos = changes.overlayPos.newValue;
      if (!overlayPos) {
        // position reset from the popup
        box.style.left = "50%";
        box.style.top = "auto";
        box.style.bottom = "8%";
        box.style.transform = "translateX(-50%)";
      }
    }
    applySettings();
  });

  chrome.storage.local
    .get(["fontSizePx", "autoHideS", "overlayPos"])
    .then((stored) => {
      settings = { ...DEFAULTS, ...stored };
      overlayPos = stored.overlayPos || null;
      applySettings();
      mount();
    });
})();
