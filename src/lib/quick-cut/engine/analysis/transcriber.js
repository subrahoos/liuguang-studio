const fs = require("node:fs/promises");
const path = require("node:path");

const { runProcess } = require("../process/run-process");

function normalizeWhisperJson(data) {
  const segments = Array.isArray(data?.transcription)
    ? data.transcription
    : [];
  return segments.flatMap((segment) => {
    const start = Number(segment.offsets?.from) / 1000;
    const end = Number(segment.offsets?.to) / 1000;
    const text = String(segment.text || "").trim();
    if (
      !text
      || !Number.isFinite(start)
      || !Number.isFinite(end)
      || end <= start
    ) {
      return [];
    }
    return [{
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      text,
    }];
  });
}

async function transcribe({
  whisperPath,
  modelPath,
  wavPath,
  outputBase,
  signal,
  runner = runProcess,
}) {
  await fs.mkdir(path.dirname(outputBase), { recursive: true });
  const modelFolder = path.dirname(modelPath);
  await runner(whisperPath, [
    "-m",
    path.basename(modelPath),
    "-f",
    wavPath,
    "-l",
    "zh",
    "-oj",
    "-of",
    outputBase,
  ], { cwd: modelFolder, signal });
  const output = JSON.parse(await fs.readFile(`${outputBase}.json`, "utf8"));
  return normalizeWhisperJson(output);
}

module.exports = {
  normalizeWhisperJson,
  transcribe,
};
