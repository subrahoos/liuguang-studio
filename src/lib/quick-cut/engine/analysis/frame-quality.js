function assertGrayFrame(pixels, purpose) {
  if (!Buffer.isBuffer(pixels) || pixels.length !== 72) {
    throw new Error(`${purpose}需要 9×8 灰度帧`);
  }
}

function differenceHash(pixels) {
  assertGrayFrame(pixels, "差异哈希");
  let bits = 0n;
  let bit = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      if (pixels[row * 9 + column] > pixels[row * 9 + column + 1]) {
        bits |= 1n << bit;
      }
      bit += 1n;
    }
  }
  return bits.toString(16).padStart(16, "0");
}

function hammingDistance(left, right) {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

function clarityScore(pixels) {
  assertGrayFrame(pixels, "清晰度");
  const differences = [];
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      differences.push(Math.abs(
        pixels[row * 9 + column]
        - pixels[row * 9 + column + 1],
      ));
    }
  }
  const mean = differences.reduce((sum, value) => sum + value, 0)
    / differences.length;
  return Number(Math.min(1, mean / 64).toFixed(3));
}

module.exports = {
  clarityScore,
  differenceHash,
  hammingDistance,
};
