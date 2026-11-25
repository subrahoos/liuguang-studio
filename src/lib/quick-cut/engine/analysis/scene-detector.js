const { runProcess } = require("../process/run-process");

function boundedNumber(value, duration) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(Math.min(duration, Math.max(0, number)).toFixed(3));
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function parseSceneTimes(stderr, duration) {
  const times = [0, Number(duration)];
  for (const match of String(stderr).matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) {
    const value = boundedNumber(match[1], duration);
    if (value !== null) times.push(value);
  }
  return uniqueSorted(times);
}

function parseSilenceRanges(stderr, duration) {
  const ranges = [];
  let pendingStart = null;
  for (const line of String(stderr).split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*(\d+(?:\.\d+)?)/);
    if (startMatch) {
      pendingStart = boundedNumber(startMatch[1], duration);
    }
    const endMatch = line.match(/silence_end:\s*(\d+(?:\.\d+)?)/);
    if (endMatch && pendingStart !== null) {
      const end = boundedNumber(endMatch[1], duration);
      if (end !== null && end > pendingStart) {
        ranges.push({ start: pendingStart, end });
      }
      pendingStart = null;
    }
  }
  if (pendingStart !== null && pendingStart < duration) {
    ranges.push({ start: pendingStart, end: Number(duration) });
  }
  return ranges;
}

async function detectScenes({
  ffmpegPath,
  inputPath,
  duration,
  signal,
  runner = runProcess,
}) {
  try {
    const result = await runner(ffmpegPath, [
      "-hide_banner",
      "-i",
      inputPath,
      "-filter:v",
      "select=gt(scene\\,0.30),showinfo",
      "-an",
      "-f",
      "null",
      "NUL",
    ], { signal });
    return parseSceneTimes(result.stderr, duration);
  } catch (error) {
    if (!error.stderr) throw error;
    return parseSceneTimes(error.stderr, duration);
  }
}

async function detectSilences({
  ffmpegPath,
  inputPath,
  duration,
  signal,
  runner = runProcess,
}) {
  try {
    const result = await runner(ffmpegPath, [
      "-hide_banner",
      "-i",
      inputPath,
      "-af",
      "silencedetect=noise=-35dB:d=0.25",
      "-vn",
      "-f",
      "null",
      "NUL",
    ], { signal });
    return parseSilenceRanges(result.stderr, duration);
  } catch (error) {
    if (!error.stderr) throw error;
    return parseSilenceRanges(error.stderr, duration);
  }
}

module.exports = {
  detectScenes,
  detectSilences,
  parseSceneTimes,
  parseSilenceRanges,
};
