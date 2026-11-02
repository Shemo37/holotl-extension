// Subtitle overlay, injected on demand by background.js via
// chrome.scripting (overlay.css is inserted first). Plain script — runs in
// the page's isolated world. Every injection (each Start) replaces the
// previous copy: a live one in this world is torn down through
// window.__holotlLiveOverlayTeardown, and a box orphaned in an older world
// (the extension was reloaded) is removed from the shared DOM. So there is
// only ever one box, and each session starts with it empty.

(() => {
  window.__holotlLiveOverlayTeardown?.();
  document.getElementById("holotl-overlay-box")?.remove();

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

  // Keep in sync with config.js (this plain script can't import the
  // module): DEFAULT_APPEARANCE, DEFAULT_SHOW_JP, and the default position,
  // which matches overlay.css (centred, 10% above the bottom).
  const APPEARANCE_DEFAULTS = {
    fontSizePx: 24,
    jpColor: "#ffffff",
    enColor: "#d3e6ff",
    outlineWidthPx: 2,
    outlineColor: "#000000",
    bgOpacity: 82,
  };
  const DEFAULT_SHOW_JP = true;
  const DEFAULT_POSITION = { cx: 0.5, bottom: 0.1 };

  // The box keeps room for this many lines per language at the set font
  // size; longer text shrinks (down to MIN_FONT_RATIO of it) instead of
  // resizing or moving the box.
  const LINES_PER_LANGUAGE = 2;
  const LINE_HEIGHT = 1.45; // overlay.css line-height
  const MIN_FONT_RATIO = 0.55;

  let appearance = { ...APPEARANCE_DEFAULTS };
  let showJp = DEFAULT_SHOW_JP;
  // Box centre-x and bottom gap as fractions of the viewport, so the spot
  // survives window resizes and moves between screens.
  let position = { ...DEFAULT_POSITION };

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

  function basePx(el) {
    return el === jpEl
      ? appearance.fontSizePx
      : Math.round(appearance.fontSizePx * 0.8);
  }

  function applyAppearance(a) {
    appearance = { ...APPEARANCE_DEFAULTS, ...(a || {}) };
    jpEl.style.color = appearance.jpColor;
    enEl.style.color = appearance.enColor;
    const shadow = outlineShadow(appearance.outlineWidthPx, appearance.outlineColor);
    jpEl.style.textShadow = shadow;
    enEl.style.textShadow = shadow;
    box.style.background = `rgba(10, 10, 14, ${appearance.bgOpacity / 100})`;
    layout();
  }

  // Reserve a fixed height per line (from the set font size, not the
  // fitted one), refit the text, keep the box on screen.
  function layout() {
    jpEl.style.display = showJp ? "" : "none";
    for (const el of [jpEl, enEl]) {
      el.style.height = `${LINES_PER_LANGUAGE * LINE_HEIGHT * basePx(el)}px`;
      fitText(el);
    }
    applyPosition();
  }

  // Largest font size (≤ the set one) at which the text fits its reserved
  // lines.
  function fitText(el) {
    const floor = Math.ceil(basePx(el) * MIN_FONT_RATIO);
    let size = basePx(el);
    el.style.fontSize = `${size}px`;
    while (size > floor && el.scrollHeight > el.clientHeight) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }
  }

  function clampPosition(p) {
    const half = Math.min(0.5, box.offsetWidth / 2 / window.innerWidth);
    const maxBottom = Math.max(0, 1 - box.offsetHeight / window.innerHeight);
    return {
      cx: Math.min(Math.max(p.cx, half), 1 - half),
      bottom: Math.min(Math.max(p.bottom, 0), maxBottom),
    };
  }

  // Always anchored by its bottom edge: the box never jumps when its
  // content changes, and the whole box stays inside the current window.
  function applyPosition() {
    const p = clampPosition(position);
    box.style.left = `${p.cx * 100}%`;
    box.style.bottom = `${p.bottom * 100}%`;
  }

  chrome.storage.local
    .get(["appearance", "showJp", "overlayPosition"])
    .then(({ appearance: a, showJp: s, overlayPosition: p }) => {
      showJp = s ?? DEFAULT_SHOW_JP;
      position = p || { ...DEFAULT_POSITION };
      applyAppearance(a);
    })
    .catch(() => applyAppearance(null));

  function onStorage(changes, area) {
    if (area !== "local") return;
    if (changes.showJp) showJp = changes.showJp.newValue ?? DEFAULT_SHOW_JP;
    if (changes.overlayPosition) {
      position = changes.overlayPosition.newValue || { ...DEFAULT_POSITION };
    }
    if (changes.appearance) {
      applyAppearance(changes.appearance.newValue);
    } else if (changes.showJp || changes.overlayPosition) {
      layout();
    }
  }
  chrome.storage.onChanged.addListener(onStorage);

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
    fitText(jpEl);
    fitText(enEl);
    shownAt = Date.now();
  }

  function showSubtitles(jp, en) {
    // Translation only: a line without a translation has nothing to show.
    if (!showJp && !en) return;
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

  function clearSubtitles() {
    clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingSub = null;
    jpEl.textContent = "";
    enEl.textContent = "";
    shownAt = 0;
  }

  function showStatus(status, message) {
    statusDot.dataset.status = status;
    statusDot.title = `HoloLiveTL: ${status}`;
    msgEl.textContent = status === "error" ? message || "error" : "";
    // Stopped: nothing left on screen to be mistaken for the next session.
    if (status === "stopped") clearSubtitles();
    applyPosition(); // an error line makes the box taller
  }

  // The subtitle file is timed against this page's video: the playing one,
  // else the largest.
  function mainVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (!v.paused && area > 0) return v;
      if (area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  function onMessage(msg, _sender, sendResponse) {
    if (msg?.action === "UPDATE_SUBTITLES") {
      showSubtitles(msg.payload?.jp, msg.payload?.en);
    } else if (msg?.action === "STATUS_UPDATE") {
      showStatus(msg.payload?.status, msg.payload?.message);
    } else if (msg?.action === "GET_VIDEO_TIME") {
      const v = mainVideo();
      sendResponse(
        v ? { time: v.currentTime, paused: v.paused, rate: v.playbackRate } : null
      );
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);

  // Draggable: pointer-drag anywhere on the box repositions it; the spot
  // is saved (as fractions of the window) for every tab and session.
  let drag = null;
  box.addEventListener("pointerdown", (e) => {
    const rect = box.getBoundingClientRect();
    drag = {
      dx: e.clientX - (rect.left + rect.width / 2),
      dy: rect.bottom - e.clientY,
    };
    box.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag) return;
    position = clampPosition({
      cx: (e.clientX - drag.dx) / window.innerWidth,
      bottom: (window.innerHeight - (e.clientY + drag.dy)) / window.innerHeight,
    });
    applyPosition();
  });
  box.addEventListener("pointerup", (e) => {
    if (!drag) return;
    drag = null;
    box.releasePointerCapture(e.pointerId);
    chrome.storage.local.set({ overlayPosition: position }).catch(() => {});
  });

  // Follow fullscreen video so subtitles stay visible in theater mode.
  function onFullscreen() {
    (document.fullscreenElement || document.body).appendChild(box);
    layout();
  }
  document.addEventListener("fullscreenchange", onFullscreen);
  // Window resized or moved to another screen: refit, pull back on screen.
  window.addEventListener("resize", layout);

  window.__holotlLiveOverlayTeardown = () => {
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorage);
    } catch {
      /* extension context already gone */
    }
    document.removeEventListener("fullscreenchange", onFullscreen);
    window.removeEventListener("resize", layout);
    clearTimeout(pendingTimer);
    box.remove();
  };
})();
