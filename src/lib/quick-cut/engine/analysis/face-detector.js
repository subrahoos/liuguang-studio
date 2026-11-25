const { loadQuickCutOnnxRuntime } = require("../../onnx-runtime");

const FACE_INPUT_SIZE = 640;

function bgrToTensorData(buffer, width, height) {
  const plane = width * height;
  if (!Buffer.isBuffer(buffer) || buffer.length !== plane * 3) {
    throw new Error(`人脸检测帧应为 ${plane * 3} 字节`);
  }
  const data = new Float32Array(plane * 3);
  for (let pixel = 0; pixel < plane; pixel += 1) {
    data[pixel] = buffer[pixel * 3];
    data[plane + pixel] = buffer[pixel * 3 + 1];
    data[plane * 2 + pixel] = buffer[pixel * 3 + 2];
  }
  return data;
}

function intersectionOverUnion(left, right) {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(
    left.x + left.width,
    right.x + right.width,
  );
  const y2 = Math.min(
    left.y + left.height,
    right.y + right.height,
  );
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = left.width * left.height
    + right.width * right.height
    - intersection;
  return union > 0 ? intersection / union : 0;
}

function nonMaximumSuppression(faces, threshold = 0.3) {
  const remaining = [...faces].sort((left, right) =>
    right.score - left.score);
  const kept = [];
  while (remaining.length) {
    const winner = remaining.shift();
    kept.push(winner);
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (intersectionOverUnion(winner, remaining[index]) > threshold) {
        remaining.splice(index, 1);
      }
    }
  }
  return kept;
}

function clampProbability(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function decodeYuNet(outputs, {
  inputWidth = FACE_INPUT_SIZE,
  inputHeight = FACE_INPUT_SIZE,
  scoreThreshold = 0.75,
  nmsThreshold = 0.3,
} = {}) {
  const faces = [];
  for (const stride of [8, 16, 32]) {
    const cls = outputs[`cls_${stride}`]?.data;
    const obj = outputs[`obj_${stride}`]?.data;
    const bbox = outputs[`bbox_${stride}`]?.data;
    if (!cls || !obj || !bbox) continue;
    const columns = Math.ceil(inputWidth / stride);
    const rows = Math.ceil(inputHeight / stride);
    const count = Math.min(cls.length, obj.length, rows * columns);
    for (let index = 0; index < count; index += 1) {
      const score = Math.sqrt(
        clampProbability(cls[index]) * clampProbability(obj[index]),
      );
      if (score < scoreThreshold) continue;
      const row = Math.floor(index / columns);
      const column = index % columns;
      const offset = index * 4;
      const centerX = (column + bbox[offset]) * stride;
      const centerY = (row + bbox[offset + 1]) * stride;
      const width = Math.exp(bbox[offset + 2]) * stride;
      const height = Math.exp(bbox[offset + 3]) * stride;
      const x = Math.max(0, centerX - width / 2);
      const y = Math.max(0, centerY - height / 2);
      const boundedWidth = Math.max(0, Math.min(width, inputWidth - x));
      const boundedHeight = Math.max(0, Math.min(height, inputHeight - y));
      faces.push({
        x: Number(x.toFixed(3)),
        y: Number(y.toFixed(3)),
        width: Number(boundedWidth.toFixed(3)),
        height: Number(boundedHeight.toFixed(3)),
        score: Number(score.toFixed(6)),
      });
    }
  }
  return nonMaximumSuppression(faces, nmsThreshold);
}

async function createFaceDetector({
  modelPath,
  runtime,
  scoreThreshold = 0.75,
  nmsThreshold = 0.3,
} = {}) {
  const ort = runtime || loadQuickCutOnnxRuntime();
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
  });
  return {
    async detect(buffer) {
      const tensor = new ort.Tensor(
        "float32",
        bgrToTensorData(buffer, FACE_INPUT_SIZE, FACE_INPUT_SIZE),
        [1, 3, FACE_INPUT_SIZE, FACE_INPUT_SIZE],
      );
      const outputs = await session.run({ input: tensor });
      return decodeYuNet(outputs, {
        inputWidth: FACE_INPUT_SIZE,
        inputHeight: FACE_INPUT_SIZE,
        scoreThreshold,
        nmsThreshold,
      });
    },
  };
}

module.exports = {
  FACE_INPUT_SIZE,
  bgrToTensorData,
  createFaceDetector,
  decodeYuNet,
  nonMaximumSuppression,
};
