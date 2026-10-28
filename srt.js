// Builds the end-of-session .srt from the cues background.js recorded:
// {seq, start, end, jp, en}, times in seconds of the page video's
// playback position. One cue per subtitle, Japanese line above the
// translation, like the overlay.

// Short utterances still need reading time on screen.
export const MIN_CUE_S = 1.0;

export function formatSrtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:` +
    `${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
  );
}

export function buildSrt(cues) {
  const usable = cues
    .filter((c) => Number.isFinite(c?.start) && (c.jp || c.en))
    .sort((a, b) => a.start - b.start);
  const blocks = usable.map((cue, i) => {
    let end = Number.isFinite(cue.end) ? cue.end : cue.start;
    end = Math.max(end, cue.start + MIN_CUE_S);
    // Players show overlapping cues stacked; end each one where the next
    // begins instead.
    const next = usable[i + 1];
    if (next && next.start > cue.start) end = Math.min(end, next.start);
    const text = [cue.jp, cue.en].filter(Boolean).join("\r\n");
    return `${i + 1}\r\n${formatSrtTime(cue.start)} --> ${formatSrtTime(end)}\r\n${text}`;
  });
  return blocks.length ? blocks.join("\r\n\r\n") + "\r\n" : "";
}

/** e.g. holotl-2026-10-28-2105.srt, from the session's start time. */
export function srtFilename(startedAtMs) {
  const d = new Date(startedAtMs);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `holotl-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}.srt`
  );
}
