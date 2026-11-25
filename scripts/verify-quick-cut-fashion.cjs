// Offline acceptance of real model annotations -> planner -> encoder -> decode.
// Explicit paths only. Sources are read; all generated files stay under outputRoot.
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs/promises");
const path = require("node:path");
const { mergeShotAnnotations } = require("../src/lib/quick-cut/engine/analysis/fashion-vision");
const { extractGrayHashFrame } = require("../src/lib/quick-cut/engine/analysis/frame-extractor");
const { differenceHash, clarityScore } = require("../src/lib/quick-cut/engine/analysis/frame-quality");
const { planFashionShowcase } = require("../src/lib/quick-cut/engine/mix/fashion-planner");
const { buildRenderArgs } = require("../src/lib/quick-cut/engine/mix/command-builder");
const { validateRenderedVideo } = require("../src/lib/quick-cut/engine/reliability");
const { runProcess } = require("../src/lib/quick-cut/engine/process/run-process");

async function main() {
  const [inputPath, resultPath, outputRoot] = process.argv.slice(2);
  if (!inputPath || !resultPath || !outputRoot) throw new Error("Usage: node scripts/verify-quick-cut-fashion.cjs INPUT RESULT OUTPUT_ROOT");
  const dataRoot = process.env.LUMA_DATA_ROOT || "D:\\3100";
  const runtime = path.join(dataRoot, "quick-cut", "runtime");
  const ffmpeg = path.join(runtime, "ffmpeg", "ffmpeg.exe");
  const ffprobe = path.join(runtime, "ffmpeg", "ffprobe.exe");
  const input = JSON.parse((await fs.readFile(inputPath, "utf8")).replace(/^\uFEFF/, ""));
  const results = JSON.parse(await fs.readFile(resultPath, "utf8"));
  if (!results.modelUsage?.pose?.loaded || results.modelUsage.pose.poseCandidateCount !== results.annotations.length) throw new Error("Missing pose execution evidence");
  const folder = await fs.mkdtemp(path.join(outputRoot, "fashion-render-"));
  const sources = mergeShotAnnotations(input.sources, results.annotations);
  for (const [index, source] of sources.entries()) {
    const local = path.join(folder, `source-${index}.mp4`);
    await fs.copyFile(source.path, local);
    source.path = local;
    source.duration = Math.max(...source.shots.map((shot) => Number(shot.end)));
    for (const shot of source.shots) {
      const pixels = await extractGrayHashFrame({ ffmpegPath: ffmpeg, inputPath: local, timestamp: (shot.start + shot.end) / 2 });
      shot.visualHash = differenceHash(pixels);
      shot.clarityScore = clarityScore(pixels);
    }
  }
  // This acceptance isolates picture planning. Production original-audio rules
  // are covered by the existing planner tests, and no transcript is invented.
  const batch = planFashionShowcase({ sources, count: 1, countMode: "custom", durationMode: "fixed", targetDuration: 15, audioMode: "bgm", seed: 7 });
  if (!batch.plans.length) throw new Error("No valid real-shot plan: " + batch.capacityReason);
  const bgm = path.join(folder, "test-audio.wav");
  await runProcess(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=20", "-y", bgm]);
  const output = path.join(folder, "verified-mix.mp4");
  const args = buildRenderArgs({ plan: batch.plans[0], outputPath: output, bgmPath: bgm, settings: { encoder: "cpu", audioMode: "bgm", fps: 30, fit: "pad", transition: "cut", quality: "compact" } });
  await runProcess(ffmpeg, args);
  const verification = await validateRenderedVideo({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, filePath: output, expectedDuration: 15, expectAudio: true });
  await runProcess(ffmpeg, ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"]);
  const report = { modelUsage: results.modelUsage, candidateCount: results.annotations.length, usableCount: results.annotations.filter((shot) => shot.usable).length, batch, verification, output };
  await fs.writeFile(path.join(folder, "acceptance.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, output, verification }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
