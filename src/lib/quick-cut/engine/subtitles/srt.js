function formatSrtTime(seconds) {
  const totalMilliseconds = Math.max(0, Math.round(Number(seconds) * 1000));
  const milliseconds = totalMilliseconds % 1000;
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(secs).padStart(2, "0"),
  ].join(":") + `,${String(milliseconds).padStart(3, "0")}`;
}

function normalizeCue(cue) {
  const outputStart = Number(cue.outputStart);
  const duration = Number(cue.duration);
  const text = String(cue.text || "").trim();
  if (!Number.isFinite(outputStart) || outputStart < 0
      || !Number.isFinite(duration) || duration <= 0 || !text) {
    return null;
  }
  return { outputStart, duration, text };
}

function toSrt(cues) {
  const entries = (cues || []).map(normalizeCue).filter(Boolean);
  return entries.map((cue, index) => [
    String(index + 1),
    `${formatSrtTime(cue.outputStart)} --> ${formatSrtTime(cue.outputStart + cue.duration)}`,
    cue.text,
    "",
  ].join("\r\n")).join("\r\n") + (entries.length ? "\r\n" : "");
}

function subtitlesFromPlan(plan) {
  let outputStart = 0;
  const cues = [];
  for (const unit of plan?.units || []) {
    const duration = Number(unit.duration) || 0;
    const text = String(unit.text || "").trim();
    if (text && duration > 0) {
      cues.push({ outputStart, duration, text });
    }
    outputStart += duration;
  }
  return cues;
}

module.exports = {
  formatSrtTime,
  subtitlesFromPlan,
  toSrt,
};
