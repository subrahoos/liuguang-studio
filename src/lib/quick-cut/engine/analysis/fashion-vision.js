const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { runProcess } = require("../process/run-process");

function hasFashionVisionRuntime({ pythonPath, scriptPath, modelRoot }) {
  return Boolean(
    pythonPath
    && scriptPath
    && modelRoot
    && fsSync.existsSync(pythonPath)
    && fsSync.existsSync(scriptPath)
    && fsSync.existsSync(path.join(modelRoot, "READY.json")),
  );
}

function mergeShotAnnotations(sources, annotations) {
  const byId = new Map(
    (annotations || [])
      .filter((item) => item && item.shotId)
      .map((item) => [String(item.shotId), item]),
  );
  return sources.map((source) => ({
    ...source,
    shots: (source.shots || []).map((shot) => {
      const extra = byId.get(String(shot.id));
      if (!extra) return shot;
      return {
        ...shot,
        fashionVision: extra,
        fashionRole: extra.fashionRole || undefined,
        fashionScore: Number(extra.fashionScore) || 0,
        fashionLabels: Array.isArray(extra.labels) ? extra.labels : [],
        fashionRoleScores: extra.roleScores && typeof extra.roleScores === "object" ? extra.roleScores : {},
        fashionAdjustedRoleScores: extra.roleAdjustedScores && typeof extra.roleAdjustedScores === "object" ? extra.roleAdjustedScores : {},
        fashionPose: extra.pose && typeof extra.pose === "object" ? extra.pose : null,
        fashionPoseEvidenceUsed: extra.poseEvidenceUsed === true,
        fashionUsable: extra.usable !== false,
        burnedTextRisk: Boolean(extra.burnedTextRisk),
        safeStart: Number.isFinite(Number(extra.safeStart))
          ? Number(extra.safeStart)
          : shot.start,
        safeDuration: Number.isFinite(Number(extra.safeDuration))
          ? Number(extra.safeDuration)
          : shot.duration,
      };
    }),
  }));
}

function normalizeModelUsage(value) {
  if (!value || typeof value !== "object") return null;
  const usage = value;
  const fashionclip = usage.fashionclip && typeof usage.fashionclip === "object" ? usage.fashionclip : {};
  const mmpose = usage.mmpose && typeof usage.mmpose === "object" ? usage.mmpose : {};
  const pose = usage.pose && typeof usage.pose === "object" ? usage.pose : mmpose;
  const roleCounts = usage.roleCounts && typeof usage.roleCounts === "object" ? usage.roleCounts : {};
  return {
    device: typeof usage.device === "string" ? usage.device : "unknown",
    fashionclip: {
      loaded: fashionclip.loaded === true,
      rolePromptCount: Number(fashionclip.rolePromptCount) || 0,
    },
    mmpose: {
      loaded: mmpose.loaded === true,
      poseCandidateCount: Number(mmpose.poseCandidateCount) || 0,
      fullBodyCount: Number(mmpose.fullBodyCount) || 0,
      motionCandidateCount: Number(mmpose.motionCandidateCount) || 0,
    },
    pose: {
      loaded: pose.loaded === true,
      backend: typeof pose.backend === "string" ? pose.backend : "MMPose",
      poseCandidateCount: Number(pose.poseCandidateCount) || 0,
      fullBodyCount: Number(pose.fullBodyCount) || 0,
      motionCandidateCount: Number(pose.motionCandidateCount) || 0,
    },
    performance: usage.performance && typeof usage.performance === "object"
      ? Object.fromEntries(Object.entries(usage.performance).filter(([, value]) => typeof value === "number" && Number.isFinite(value)))
      : {},
    roleCounts: Object.fromEntries(Object.entries(roleCounts)
      .filter(([, count]) => Number.isFinite(Number(count)))
      .map(([role, count]) => [role, Number(count)])),
  };
}

function noopProgress(progressEvent) {
  void progressEvent;
}

async function runFashionVisionAnalysis({
  sources,
  pythonPath,
  scriptPath,
  modelRoot,
  workFolder,
  signal,
  runner = runProcess,
  onProgress = noopProgress,
}) {
  if (!hasFashionVisionRuntime({ pythonPath, scriptPath, modelRoot })) {
    return {
      sources,
      available: false,
      warning: "女装视觉模型未完成本地部署，已回退基础镜头规则",
      modelUsage: null,
    };
  }

  const inputPath = path.join(workFolder, "fashion-vision-input.json");
  const outputPath = path.join(workFolder, "fashion-vision-output.json");
  await fs.writeFile(inputPath, JSON.stringify({
    sources: sources.map((source) => ({
      id: source.id,
      path: source.path,
      shots: (source.shots || []).map((shot) => ({
        id: shot.id,
        start: shot.start,
        end: shot.end,
        duration: shot.duration,
      })),
    })),
  }, null, 2), "utf8");
  const candidateCount = sources.reduce((sum, source) => sum + (source.shots || []).length, 0);
  let progressQueue = Promise.resolve();
  const reportProgress = (progressEvent) => {
    progressQueue = progressQueue.then(() => onProgress(progressEvent));
    return progressQueue;
  };
  await reportProgress({ phase: "fashion-vision", current: 0, total: candidateCount, message: "正在进行女装视觉镜头分析" });
  try {
    let stdoutBuffer = "";
    await runner(pythonPath, [
      scriptPath,
      "--input",
      inputPath,
      "--output",
      outputPath,
      "--model-root",
      modelRoot,
    ], {
      signal,
      onStdout: (chunk) => {
        stdoutBuffer += String(chunk);
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          const modelMatch = line.match(/^LUMA_FASHION_MODEL:(.+)$/);
          if (modelMatch) {
            try {
              const usage = normalizeModelUsage(JSON.parse(modelMatch[1]));
              if (usage) {
                const loaded = [
                  usage.fashionclip.loaded ? "FashionCLIP" : null,
                  usage.pose.loaded ? usage.pose.backend : null,
                ].filter(Boolean).join(" + ");
                void reportProgress({
                  phase: "fashion-vision",
                  current: 0,
                  total: candidateCount,
                  message: `女装视觉模型已加载：${loaded || "基础规则"}（${usage.device}）`,
                });
              }
            } catch {
              // A malformed informational line must not hide model progress.
            }
            continue;
          }
          const match = line.match(/LUMA_FASHION_PROGRESS:(\d+):(\d+)/);
          if (match) {
            void reportProgress({
              phase: "fashion-vision",
              current: Number(match[1]),
              total: Number(match[2]),
              message: `正在进行女装视觉镜头分析 ${match[1]}/${match[2]}`,
            });
          }
        }
      },
    });
    await progressQueue;
    const result = JSON.parse(await fs.readFile(outputPath, "utf8"));
    if (!Array.isArray(result.annotations)) {
      throw new Error("女装视觉模型返回结果无效");
    }
    const modelUsage = normalizeModelUsage(result.modelUsage) || normalizeModelUsage({
      device: typeof result.device === "string" ? result.device : "unknown",
      fashionclip: { loaded: false, rolePromptCount: 0 },
      mmpose: { loaded: false, poseCandidateCount: 0, fullBodyCount: 0, motionCandidateCount: 0 },
      roleCounts: {},
    });
    const expectedIds = new Set(sources.flatMap((source) => (source.shots || []).map((shot) => String(shot.id))));
    const coveredIds = new Set(result.annotations.filter((item) => item?.pose?.available === true).map((item) => String(item.shotId)));
    const poseComplete = modelUsage.pose.loaded && modelUsage.pose.poseCandidateCount === candidateCount
      && result.annotations.length === candidateCount && coveredIds.size === expectedIds.size
      && [...expectedIds].every((id) => coveredIds.has(id)) && candidateCount > 0;
    const warning = !modelUsage.fashionclip.loaded
      ? "FashionCLIP 未成功加载；本批未完成女装视觉模型分析"
      : poseComplete
        ? null
        : `FashionCLIP 已运行，但 ${modelUsage.pose.backend} 未成功加载或未完成全部镜头分析；本批未完成女装视觉模型分析`;
    await reportProgress({
      phase: "fashion-vision",
      current: candidateCount,
      total: candidateCount,
      message: `女装视觉结果：FashionCLIP ${modelUsage.fashionclip.loaded ? "已参与" : "未参与"}；${modelUsage.pose.backend} ${modelUsage.pose.loaded ? `已参与 ${modelUsage.pose.poseCandidateCount} 个镜头` : "未参与"}；${modelUsage.device}`,
    });
    await reportProgress({ phase: "fashion-vision", current: candidateCount, total: candidateCount, message: "女装视觉镜头分析完成" });
    return {
      sources: mergeShotAnnotations(sources, result.annotations),
      available: modelUsage.fashionclip.loaded && poseComplete,
      warning,
      modelUsage,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      sources,
      available: false,
      warning: `女装视觉模型分析失败，已回退基础镜头规则：${error.message || "未知错误"}`,
      modelUsage: null,
    };
  }
}

module.exports = {
  hasFashionVisionRuntime,
  mergeShotAnnotations,
  normalizeModelUsage,
  runFashionVisionAnalysis,
};
