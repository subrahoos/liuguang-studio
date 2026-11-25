function round(value) {
  return Number(Number(value).toFixed(3));
}

function shotRanges(sceneTimes, duration) {
  const end = Math.max(0, Number(duration) || 0);
  const boundaries = [...new Set([
    0,
    ...(sceneTimes || []).map(Number)
      .filter((value) => Number.isFinite(value) && value > 0 && value < end),
    end,
  ])].sort((left, right) => left - right);
  const shots = [];
  for (let index = 1; index < boundaries.length; index += 1) {
    const start = round(boundaries[index - 1]);
    const shotEnd = round(boundaries[index]);
    if (shotEnd <= start) continue;
    shots.push({
      start,
      end: shotEnd,
      duration: round(shotEnd - start),
    });
  }
  return shots;
}

function sampleShotTimes({ start, end }) {
  const duration = end - start;
  if (duration <= 0) return [];
  const inset = Math.min(0.05, duration / 4);
  const values = [
    start + inset,
    start + duration / 2,
    end - inset,
  ];
  if (duration > 3) {
    for (let timestamp = start + 0.5; timestamp < end; timestamp += 0.5) {
      values.push(timestamp);
    }
  }
  return [...new Set(values.map(round))].sort((left, right) => left - right);
}

function classifyFaceSamples(samples, {
  frameWidth,
  frameHeight,
}) {
  const frameArea = frameWidth * frameHeight;
  let maxScore = 0;
  let maxFaceAreaRatio = 0;
  let faceFrames = 0;
  let personFrames = 0;
  let clearFace = false;
  let clearPerson = false;
  let uncertain = false;

  for (const sample of samples) {
    if (sample.error) uncertain = true;
    if (sample.faces?.length) faceFrames += 1;
    if (sample.persons?.length) {
      personFrames += 1;
      clearPerson = true;
    }
    for (const face of sample.faces || []) {
      const score = Number(face.score) || 0;
      const areaRatio = Math.max(
        0,
        (Number(face.width) * Number(face.height)) / frameArea,
      );
      maxScore = Math.max(maxScore, score);
      maxFaceAreaRatio = Math.max(maxFaceAreaRatio, areaRatio);
      if (score >= 0.75 && areaRatio >= 0.0015) {
        clearFace = true;
      } else if (score >= 0.45) {
        uncertain = true;
      }
    }
  }

  let faceState = "replaceable-product";
  if (clearFace || clearPerson) {
    faceState = "locked-presenter";
  } else if (uncertain) {
    faceState = "uncertain";
  }
  return {
    faceState,
    faceConfidence: round(maxScore),
    maxFaceAreaRatio: round(maxFaceAreaRatio),
    faceFrameRatio: samples.length
      ? round(faceFrames / samples.length)
      : 0,
    personFrameRatio: samples.length
      ? personFrames / samples.length
      : 0,
  };
}

async function analyzeShotFaces({
  sourceId,
  path,
  duration,
  sceneTimes,
  ffmpegPath,
  detector,
  extractFrame,
  signal,
  onSample = () => {},
}) {
  const shots = shotRanges(sceneTimes, duration);
  const analyzed = [];
  for (let index = 0; index < shots.length; index += 1) {
    const samples = [];
    for (const timestamp of sampleShotTimes(shots[index])) {
      try {
        const frame = await extractFrame({
          ffmpegPath,
          inputPath: path,
          timestamp,
          signal,
        });
        samples.push({
          timestamp,
          faces: await detector.detect(frame),
          persons: detector.detectPersons
            ? await detector.detectPersons(frame)
            : [],
        });
      } catch (error) {
        samples.push({
          timestamp,
          error: error.message,
          faces: [],
        });
      }
      onSample({
        shotIndex: index,
        shotCount: shots.length,
        timestamp,
      });
    }
    analyzed.push({
      id: `${sourceId}-shot-${String(index + 1).padStart(3, "0")}`,
      sourceId,
      path,
      ...shots[index],
      ...classifyFaceSamples(samples, {
        frameWidth: FACE_INPUT_SIZE,
        frameHeight: FACE_INPUT_SIZE,
      }),
    });
  }
  return analyzed;
}

module.exports = {
  analyzeShotFaces,
  classifyFaceSamples,
  sampleShotTimes,
  shotRanges,
};
const { FACE_INPUT_SIZE } = require("./face-detector");
