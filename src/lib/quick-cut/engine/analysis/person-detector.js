const { loadQuickCutOnnxRuntime } = require("../../onnx-runtime");

const PERSON_INPUT_SIZE = 224;

function generatePersonAnchors() {
  const anchors = [];
  for (const [gridSize, anchorsPerCell] of [
    [28, 2],
    [14, 2],
    [7, 6],
  ]) {
    for (let y = 0; y < gridSize; y += 1) {
      for (let x = 0; x < gridSize; x += 1) {
        for (let copy = 0; copy < anchorsPerCell; copy += 1) {
          anchors.push([
            (x + 0.5) / gridSize,
            (y + 0.5) / gridSize,
          ]);
        }
      }
    }
  }
  return anchors;
}

function bgrToPersonTensorData(buffer, sourceWidth, sourceHeight) {
  if (
    !Buffer.isBuffer(buffer)
    || buffer.length !== sourceWidth * sourceHeight * 3
  ) {
    throw new Error("人体检测画面数据不完整");
  }
  const plane = PERSON_INPUT_SIZE * PERSON_INPUT_SIZE;
  const data = new Float32Array(plane * 3);
  for (let y = 0; y < PERSON_INPUT_SIZE; y += 1) {
    const sourceY = Math.min(
      sourceHeight - 1,
      Math.floor((y * sourceHeight) / PERSON_INPUT_SIZE),
    );
    for (let x = 0; x < PERSON_INPUT_SIZE; x += 1) {
      const sourceX = Math.min(
        sourceWidth - 1,
        Math.floor((x * sourceWidth) / PERSON_INPUT_SIZE),
      );
      const sourceOffset = (sourceY * sourceWidth + sourceX) * 3;
      const targetOffset = y * PERSON_INPUT_SIZE + x;
      data[targetOffset] = (buffer[sourceOffset + 2] / 255 - 0.5) * 2;
      data[plane + targetOffset] = (
        buffer[sourceOffset + 1] / 255 - 0.5
      ) * 2;
      data[plane * 2 + targetOffset] = (
        buffer[sourceOffset] / 255 - 0.5
      ) * 2;
    }
  }
  return data;
}

function sigmoid(value) {
  const bounded = Math.max(-100, Math.min(100, Number(value) || 0));
  return 1 / (1 + Math.exp(-bounded));
}

function intersectionOverUnion(left, right) {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = left.width * left.height
    + right.width * right.height
    - intersection;
  return union > 0 ? intersection / union : 0;
}

function suppressOverlaps(detections, threshold) {
  const remaining = [...detections].sort((left, right) =>
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

function decodePersonDetections(outputs, {
  anchors = generatePersonAnchors(),
  scoreThreshold = 0.7,
  nmsThreshold = 0.3,
  outputSize = 640,
  topEdgeRatio = 0.03,
} = {}) {
  const scores = outputs["Identity_1:0"]?.data;
  const boxes = outputs["Identity:0"]?.data;
  if (!scores || !boxes) return [];
  const detections = [];
  const count = Math.min(anchors.length, scores.length);
  for (let index = 0; index < count; index += 1) {
    const score = sigmoid(scores[index]);
    if (score < scoreThreshold) continue;
    const offset = index * 12;
    const centerX = (
      boxes[offset] / PERSON_INPUT_SIZE + anchors[index][0]
    ) * outputSize;
    const centerY = (
      boxes[offset + 1] / PERSON_INPUT_SIZE + anchors[index][1]
    ) * outputSize;
    const width = Math.max(
      0,
      (boxes[offset + 2] / PERSON_INPUT_SIZE) * outputSize,
    );
    const height = Math.max(
      0,
      (boxes[offset + 3] / PERSON_INPUT_SIZE) * outputSize,
    );
    const y = centerY - height / 2;
    if (y > outputSize * topEdgeRatio) continue;
    detections.push({
      x: centerX - width / 2,
      y,
      width,
      height,
      score,
    });
  }
  return suppressOverlaps(detections, nmsThreshold);
}

async function createPersonDetector({
  modelPath,
  runtime,
  scoreThreshold = 0.7,
  nmsThreshold = 0.3,
} = {}) {
  const ort = runtime || loadQuickCutOnnxRuntime();
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
  });
  const anchors = generatePersonAnchors();
  return {
    async detect(buffer) {
      const tensor = new ort.Tensor(
        "float32",
        bgrToPersonTensorData(buffer, 640, 640),
        [1, 3, PERSON_INPUT_SIZE, PERSON_INPUT_SIZE],
      );
      const outputs = await session.run({ "input_1:0": tensor });
      return decodePersonDetections(outputs, {
        anchors,
        scoreThreshold,
        nmsThreshold,
      });
    },
  };
}

module.exports = {
  PERSON_INPUT_SIZE,
  bgrToPersonTensorData,
  createPersonDetector,
  decodePersonDetections,
  generatePersonAnchors,
};
