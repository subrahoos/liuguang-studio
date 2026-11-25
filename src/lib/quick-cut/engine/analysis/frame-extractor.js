const { runProcess } = require("../process/run-process");

const FACE_INPUT_SIZE = 640;

function formatTime(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, "");
}

function bgrFrameArgs(inputPath, timestamp) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    formatTime(timestamp),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${FACE_INPUT_SIZE}:${FACE_INPUT_SIZE}:force_original_aspect_ratio=decrease,pad=${FACE_INPUT_SIZE}:${FACE_INPUT_SIZE}:(ow-iw)/2:(oh-ih)/2`,
    "-pix_fmt",
    "bgr24",
    "-f",
    "rawvideo",
    "pipe:1",
  ];
}

function grayHashFrameArgs(inputPath, timestamp) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    formatTime(timestamp),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    "scale=9:8,format=gray",
    "-pix_fmt",
    "gray",
    "-f",
    "rawvideo",
    "pipe:1",
  ];
}

async function extract({
  ffmpegPath,
  args,
  expectedBytes,
  signal,
  runner,
}) {
  const result = await runner(ffmpegPath, args, {
    signal,
    encoding: null,
  });
  if (
    !Buffer.isBuffer(result.stdout)
    || result.stdout.length !== expectedBytes
  ) {
    throw new Error(`抽帧数据不完整：需要 ${expectedBytes} 字节`);
  }
  return result.stdout;
}

function extractBgrFrame({
  ffmpegPath,
  inputPath,
  timestamp,
  signal,
  runner = runProcess,
}) {
  return extract({
    ffmpegPath,
    args: bgrFrameArgs(inputPath, timestamp),
    expectedBytes: FACE_INPUT_SIZE * FACE_INPUT_SIZE * 3,
    signal,
    runner,
  });
}

function extractGrayHashFrame({
  ffmpegPath,
  inputPath,
  timestamp,
  signal,
  runner = runProcess,
}) {
  return extract({
    ffmpegPath,
    args: grayHashFrameArgs(inputPath, timestamp),
    expectedBytes: 9 * 8,
    signal,
    runner,
  });
}

module.exports = {
  bgrFrameArgs,
  grayHashFrameArgs,
  extractBgrFrame,
  extractGrayHashFrame,
};
