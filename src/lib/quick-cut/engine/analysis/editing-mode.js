const MODES = new Set([
  "auto",
  "presenter",
  "voice-over",
  "product-footage",
]);

function detectEditingMode(source, override = "auto") {
  if (!MODES.has(override)) throw new Error("剪辑模式无效");
  if (override !== "auto") return override;
  const duration = Math.max(0.001, Number(source?.duration) || 0);
  const speechRatio = (Number(source?.speechDuration) || 0) / duration;
  const presenterDuration = (source?.shots || [])
    .filter((shot) => shot.faceState === "locked-presenter")
    .reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
  if (speechRatio >= 0.35 && presenterDuration / duration >= 0.08) {
    return "presenter";
  }
  if (speechRatio >= 0.35) return "voice-over";
  return "product-footage";
}

module.exports = { MODES, detectEditingMode };
