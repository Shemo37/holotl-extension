// Subtitle overlay, injected on demand by background.js via
// chrome.scripting (overlay.css is inserted first). Plain script — runs in
// the page's isolated world, guarded against double injection.

(() => {
  if (window.__holotlLiveOverlay) return;
  window.__holotlLiveOverlay = true;

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

  // Keep in sync with DEFAULT_APPEARANCE in config.js (this plain script
  // can't import the module).
  const APPEARANCE_DEFAULTS = {
    fontSizePx: 24,
    jpColor: "#ffffff",
    enColor: "#d3e6ff",
    outlineWidthPx: 2,
    outlineColor: "#000000",
    bgOpacity: 82,
  };

  function outlineShadow(width, color) {
    if (!width) return "0 1px 3px rgba(0, 0, 0, 0.8)";
    const shadows = [];
    for (let dx = -width; dx <= width; dx++) {
      for (let dy = -width; dy <= width; dy++) {
        if (dx || dy) shadows.push(`${dx}px ${dy}px 0 ${color}`);
      }
    }
    return shadows.join(",");
  }

  function applyAppearance(a) {
    const ap = { ...APPEARANCE_DEFAULTS, ...(a || {}) };
    jpEl.style.fontSize = `${ap.fontSizePx}px`;
    enEl.style.fontSize = `${Math.round(ap.fontSizePx * 0.8)}px`;
    jpEl.style.color = ap.jpColor;
    enEl.style.color = ap.enColor;
    const shadow = outlineShadow(ap.outlineWidthPx, ap.outlineColor);
    jpEl.style.textShadow = shadow;
    enEl.style.textShadow = shadow;
    box.style.background = `rgba(10, 10, 14, ${ap.bgOpacity / 100})`;
  }

  chrome.storage.local.get("appearance").then(({ appearance }) => {
    applyAppearance(appearance);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.appearance) {
      applyAppearance(changes.appearance.newValue);
    }
  });

  // No auto-clear: the last subtitle stays on screen until the next one
  // replaces it. A minimum display time keeps rapid bursts of short
  // utterances from flickering by — a new subtitle arriving early waits
  // out the hold (newest wins if several queue up).
  const MIN_DISPLAY_MS = 1500;
  let shownAt = 0;
  let pendingSub = null;
  let pendingTimer = null;

  function renderSubtitles(jp, en) {
    jpEl.textContent = jp || "";
    enEl.textContent = en || "";
    msgEl.textContent = "";
    shownAt = Date.now();
  }

  function showSubtitles(jp, en) {
    const heldFor = Date.now() - shownAt;
    const somethingShown = jpEl.textContent || enEl.textContent;
    if (!somethingShown || heldFor >= MIN_DISPLAY_MS) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
      pendingSub = null;
      renderSubtitles(jp, en);
      return;
    }
    pendingSub = { jp, en };
    if (!pendingTimer) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (pendingSub) {
          renderSubtitles(pendingSub.jp, pendingSub.en);
          pendingSub = null;
        }
      }, MIN_DISPLAY_MS - heldFor);
    }
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
    // Anchor by the box CENTER, not the left edge: content width changes
    // then expand symmetrically instead of pushing the box left/right.
    box.style.left = `${x + box.offsetWidth / 2}px`;
    box.style.top = `${y}px`;
    box.style.bottom = "auto";
    box.style.transform = "translateX(-50%)";
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
