function rounded(value) {
  return Number(Number(value).toFixed(3));
}

function productSegment(start, end) {
  return {
    start: rounded(start),
    end: rounded(end),
    duration: rounded(end - start),
    hasSpeech: false,
    text: "",
  };
}

function splitProductRange(start, end, cuts, maxDuration = 5) {
  if (end - start < 0.1) return [];
  const boundaries = [
    start,
    ...cuts.filter((value) => value > start && value < end),
    end,
  ].sort((left, right) => left - right);
  const result = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const from = boundaries[index];
    const to = boundaries[index + 1];
    const length = to - from;
    const pieces = Math.max(1, Math.ceil(length / maxDuration));
    for (let piece = 0; piece < pieces; piece += 1) {
      const pieceStart = from + (length * piece) / pieces;
      const pieceEnd = from + (length * (piece + 1)) / pieces;
      if (pieceEnd - pieceStart >= 0.1) {
        result.push(productSegment(pieceStart, pieceEnd));
      }
    }
  }
  return result;
}

function normalizeTranscript(transcript, duration) {
  return (Array.isArray(transcript) ? transcript : [])
    .map((item) => ({
      start: Math.max(0, Number(item.start)),
      end: Math.min(duration, Number(item.end)),
      text: String(item.text || "").trim(),
    }))
    .filter((item) =>
      item.text
      && Number.isFinite(item.start)
      && Number.isFinite(item.end)
      && item.end > item.start)
    .sort((left, right) => left.start - right.start);
}

function segmentMedia({
  duration,
  scenes = [],
  silences = [],
  transcript = [],
}) {
  const totalDuration = Number(duration);
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw new Error("素材时长无效");
  }
  const cuts = [
    ...scenes.map(Number),
    ...silences.flatMap((range) => [Number(range.start), Number(range.end)]),
  ].filter(Number.isFinite);
  const speech = normalizeTranscript(transcript, totalDuration);
  const segments = [];
  let cursor = 0;

  for (const sentence of speech) {
    if (sentence.start > cursor) {
      segments.push(...splitProductRange(cursor, sentence.start, cuts));
    }
    const start = Math.max(cursor, sentence.start);
    if (sentence.end > start) {
      segments.push({
        start: rounded(start),
        end: rounded(sentence.end),
        duration: rounded(sentence.end - start),
        hasSpeech: true,
        text: sentence.text,
      });
      cursor = sentence.end;
    }
  }
  if (cursor < totalDuration) {
    segments.push(...splitProductRange(cursor, totalDuration, cuts));
  }

  return segments.sort((left, right) => left.start - right.start);
}

module.exports = {
  segmentMedia,
};
