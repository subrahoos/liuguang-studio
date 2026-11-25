const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");

const {
  analysisCacheKey,
  loadAnalysisCache,
  writeAnalysisCache,
} = require("../analysis/cache");
const { classifyMedia, speechCoverage } = require("../analysis/classifier");
const {
  classifyClause,
  splitTranscriptClauses,
} = require("../analysis/clause-intent");
const { detectEditingMode } = require("../analysis/editing-mode");
const { createFaceDetector } = require("../analysis/face-detector");
const { createPersonDetector } = require("../analysis/person-detector");
const {
  extractBgrFrame,
  extractGrayHashFrame,
} = require("../analysis/frame-extractor");
const {
  clarityScore,
  differenceHash,
} = require("../analysis/frame-quality");
const { detectScenes, detectSilences } = require("../analysis/scene-detector");
const {
  tagShot,
  textForRange,
} = require("../analysis/semantic-tagger");
const { segmentMedia } = require("../analysis/segmenter");
const { analyzeShotFaces } = require("../analysis/shot-face-analyzer");
const { transcribe } = require("../analysis/transcriber");
const { runFashionVisionAnalysis } = require("../analysis/fashion-vision");
const { runProcess } = require("../process/run-process");

function isNvidiaEncodingError(error) {
  const message = [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .join("\n");
  return /NVENC|CUDA|No NVENC capable devices|unsupported device|h264_nvenc/i
    .test(message);
}

function summarizeAnalysis(sources) {
  const items = Array.isArray(sources) ? sources : [];
  const shots = items.flatMap((source) => source.shots || []);
  const totalDuration = items.reduce(
    (sum, source) => sum + (Number(source.duration) || 0),
    0,
  );
  const speechDuration = items.reduce(
    (sum, source) => sum + (Number(source.speechDuration) || 0),
    0,
  );
  const counts = { product: 0, speech: 0, mixed: 0 };
  for (const source of items) {
    if (Object.hasOwn(counts, source.classification)) {
      counts[source.classification] += 1;
    }
  }
  const sorted = Object.entries(counts)
    .sort((left, right) => right[1] - left[1]);
  const detectedType = sorted.length > 1 && sorted[0][1] === sorted[1][1]
    ? "mixed"
    : sorted[0]?.[0] || "product";
  const tagCounts = {};
  for (const shot of shots) {
    for (const tag of shot.semanticTags || []) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  const lockedShots = shots.filter((shot) =>
    shot.faceState === "locked-presenter"
    || shot.faceState === "uncertain");
  const replaceableShots = shots.filter((shot) =>
    shot.faceState === "replaceable-product");
  return {
    sourceCount: items.length,
    fashionCandidateCount: shots.length,
    segmentCount: items.reduce(
      (sum, source) => sum + (source.segments?.length || 0),
      0,
    ),
    totalDuration: Number(totalDuration.toFixed(3)),
    speechCoverage: speechCoverage({ duration: totalDuration, speechDuration }),
    detectedType,
    presenterSourceCount: items.filter((source) =>
      Number(source.speechDuration) > 0
      && (source.shots || []).some((shot) =>
        shot.faceState === "locked-presenter")).length,
    lockedShotCount: lockedShots.length,
    lockedDuration: Number(lockedShots.reduce(
      (sum, shot) => sum + (Number(shot.duration) || 0),
      0,
    ).toFixed(3)),
    replaceableShotCount: replaceableShots.length,
    replaceableDuration: Number(replaceableShots.reduce(
      (sum, shot) => sum + (Number(shot.duration) || 0),
      0,
    ).toFixed(3)),
    tagCounts,
  };
}

function silenceDuration(ranges) {
  return (ranges || []).reduce(
    (sum, range) => sum + Math.max(0, Number(range.end) - Number(range.start)),
    0,
  );
}

// Shorter windows give the fashion planner enough real, non-overlapping
// timeline choices without manufacturing crop/mirror variants.
const FASHION_WINDOW_SECONDS = 3.5;

function expandFashionShots(shots, sourceId, sourcePath) {
  const expanded = [];
  for (const shot of shots || []) {
    const start = Number(shot.start);
    const end = Number(shot.end ?? start + Number(shot.duration));
    const duration = end - start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || duration <= 0) continue;
    const pieces = Math.max(1, Math.ceil(duration / FASHION_WINDOW_SECONDS));
    for (let index = 0; index < pieces; index += 1) {
      const windowStart = start + (duration * index) / pieces;
      const windowEnd = start + (duration * (index + 1)) / pieces;
      if (windowEnd - windowStart < 1.2) continue;
      expanded.push({
        ...shot,
        id: `${shot.id}-window-${String(index + 1).padStart(2, "0")}`,
        sourceId,
        path: sourcePath,
        start: Number(windowStart.toFixed(3)),
        end: Number(windowEnd.toFixed(3)),
        duration: Number((windowEnd - windowStart).toFixed(3)),
      });
    }
  }
  return expanded;
}

function enrichSourceIntents(source) {
  const transcript = source.transcript || [];
  const clauses = splitTranscriptClauses(transcript);
  const shots = (source.shots || []).map((shot) => {
    const shotStart = Number(shot.start);
    const shotEnd = Number(shot.end);
    const dominantClause = clauses
      .map((clause) => ({
        clause,
        overlap: Math.max(
          0,
          Math.min(shotEnd, Number(clause.end))
            - Math.max(shotStart, Number(clause.start)),
        ),
      }))
      .filter((item) => item.overlap > 0)
      .sort((left, right) =>
        right.overlap - left.overlap
        || Number(right.clause.confidence) - Number(left.clause.confidence)
        || Number(left.clause.start) - Number(right.clause.start))[0]?.clause;
    const transcriptText = dominantClause?.text
      ?? shot.transcriptText
      ?? textForRange(transcript, shotStart, shotEnd);
    const classified = classifyClause(transcriptText);
    const visualIntent = classified.intent === "person-expression"
      && shot.faceState === "replaceable-product"
      ? "general-product"
      : classified.intent;
    return {
      ...shot,
      transcriptText,
      visualIntent,
      intentConfidence: visualIntent === "general-product"
        && !transcriptText
        ? 0.4
        : classified.confidence,
    };
  });
  const enriched = {
    ...source,
    shots,
    clauses,
  };
  return {
    ...enriched,
    editingMode: detectEditingMode(enriched),
  };
}

async function extractSpeechWav({
  ffmpegPath,
  inputPath,
  outputPath,
  signal,
  runner = runProcess,
}) {
  await runner(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "pcm_s16le",
    outputPath,
  ], { signal });
}

async function analyzeMediaSet({
  media,
  ffmpegPath,
  whisperPath,
  whisperModelPath,
  faceModelPath,
  personModelPath,
  cachePath,
  workFolder,
  signal,
  onProgress = () => {},
  detector = { detectScenes, detectSilences },
  transcriber = transcribe,
  faceDetectorFactory = createFaceDetector,
  personDetectorFactory = createPersonDetector,
  faceAnalyzer = analyzeShotFaces,
  frameExtractor = extractBgrFrame,
  hashFrameExtractor = extractGrayHashFrame,
  runner = runProcess,
  fashionVision = null,
}) {
  const cacheIdentity = crypto.createHash("sha256").update(analysisCacheKey(media));
  if (fashionVision) {
    for (const file of [fashionVision.scriptPath, path.join(fashionVision.modelRoot, "READY.json")]) {
      cacheIdentity.update(await fs.readFile(file).catch(() => Buffer.from("missing-runtime")));
    }
  } else {
    cacheIdentity.update("no-fashion-vision");
  }
  const key = cacheIdentity.digest("hex");
  const cached = await loadAnalysisCache(cachePath, key);
  if (cached) {
    await onProgress({
      phase: "analysis",
      current: media.length,
      total: media.length,
      message: "已读取本地分析缓存",
      cached: true,
    });
    return cached;
  }

  await fs.mkdir(workFolder, { recursive: true });
  let faceDetector;
  try {
    faceDetector = await faceDetectorFactory({ modelPath: faceModelPath });
    if (personModelPath) {
      const personDetector = await personDetectorFactory({
        modelPath: personModelPath,
      });
      faceDetector.detectPersons = (frame) => personDetector.detect(frame);
    }
  } catch {
    throw new Error(
      "本地人脸分析组件缺失或损坏，请重新安装软件",
    );
  }
  const sources = [];
  for (let index = 0; index < media.length; index += 1) {
    if (signal?.aborted) throw new Error("任务已停止");
    const item = media[index];
    await onProgress({
      phase: "analysis",
      current: index,
      total: media.length,
      message: `正在分析素材 ${index + 1}/${media.length}`,
    });
    const [scenes, silences] = await Promise.all([
      detector.detectScenes({
        ffmpegPath,
        inputPath: item.path,
        duration: item.duration,
        signal,
        runner,
      }),
      item.hasAudio
        ? detector.detectSilences({
          ffmpegPath,
          inputPath: item.path,
          duration: item.duration,
          signal,
          runner,
        })
        : Promise.resolve([{ start: 0, end: item.duration }]),
    ]);
    const audibleDuration = Math.max(
      0,
      item.duration - silenceDuration(silences),
    );
    let transcript = [];
    if (item.hasAudio && audibleDuration >= 0.3) {
      const base = path.join(
        workFolder,
        `source-${String(index + 1).padStart(3, "0")}`,
      );
      const wavPath = `${base}.wav`;
      await extractSpeechWav({
        ffmpegPath,
        inputPath: item.path,
        outputPath: wavPath,
        signal,
        runner,
      });
      transcript = await transcriber({
        whisperPath,
        modelPath: whisperModelPath,
        wavPath,
        outputBase: base,
        signal,
        runner,
      });
    }
    await onProgress({
      phase: "face-analysis",
      current: index,
      total: media.length,
      message: `正在检查人物和商品镜头 ${index + 1}/${media.length}`,
    });
    const sourceId = `source-${String(index + 1).padStart(3, "0")}`;
    const faceShots = await faceAnalyzer({
      sourceId,
      path: item.path,
      duration: item.duration,
      sceneTimes: scenes,
      ffmpegPath,
      detector: faceDetector,
      extractFrame: frameExtractor,
      signal,
    });
    const fashionShots = fashionVision
      ? expandFashionShots(faceShots, sourceId, item.path)
      : faceShots;
    const shots = [];
    for (const faceShot of fashionShots) {
      let taggedShot = tagShot(faceShot, transcript);
      try {
        const pixels = await hashFrameExtractor({
          ffmpegPath,
          inputPath: item.path,
          timestamp: faceShot.start + faceShot.duration / 2,
          signal,
          runner,
        });
        taggedShot = {
          ...taggedShot,
          visualHash: differenceHash(pixels),
          clarityScore: clarityScore(pixels),
        };
      } catch {
        const fingerprint = [
          sourceId,
          faceShot.start,
          faceShot.end,
        ].join("|");
        taggedShot = {
          ...taggedShot,
          faceState: "uncertain",
          visualHash: crypto.createHash("sha256")
            .update(fingerprint)
            .digest("hex")
            .slice(0, 16),
          clarityScore: 0,
        };
      }
      shots.push(taggedShot);
    }
    const segments = segmentMedia({
      duration: item.duration,
      scenes,
      silences,
      transcript,
    }).map((segment, segmentIndex) => ({
      id: `source-${index + 1}-segment-${segmentIndex + 1}`,
      ...segment,
    }));
    const speechDuration = segments
      .filter((segment) => segment.hasSpeech)
      .reduce((sum, segment) => sum + segment.duration, 0);
    sources.push(enrichSourceIntents({
      ...item,
      id: sourceId,
      scenes,
      silences,
      transcript,
      segments,
      shots,
      speechDuration: Number(speechDuration.toFixed(3)),
      classification: classifyMedia({
        duration: item.duration,
        speechDuration,
      }),
    }));
  }
  let finalSources = sources;
  let fashionVisionStatus = {
    available: false,
    warning: "女装视觉模型未启用",
    modelUsage: null,
  };
  if (fashionVision) {
    const enhanced = await runFashionVisionAnalysis({
      sources,
      ...fashionVision,
      workFolder,
      signal,
      runner,
      onProgress,
    });
    finalSources = enhanced.sources;
    fashionVisionStatus = {
      available: enhanced.available,
      warning: enhanced.warning,
      modelUsage: enhanced.modelUsage || null,
    };
  }
  const result = {
    sources: finalSources,
    summary: {
      ...summarizeAnalysis(finalSources),
      fashionVisionAvailable: fashionVisionStatus.available,
      fashionVisionWarning: fashionVisionStatus.warning,
      fashionVisionModelUsage: fashionVisionStatus.modelUsage,
    },
  };
  await writeAnalysisCache(cachePath, key, result);
  await onProgress({
    phase: "analysis",
    current: media.length,
    total: media.length,
    message: "素材分析完成",
  });
  return result;
}

module.exports = {
  analyzeMediaSet,
  enrichSourceIntents,
  extractSpeechWav,
  isNvidiaEncodingError,
  summarizeAnalysis,
};
