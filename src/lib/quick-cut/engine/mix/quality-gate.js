const { hammingDistance } = require("../analysis/frame-quality");

function approximatelyEqual(left, right, tolerance) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

const FASHION_ROLES = new Set([
  "opening-full-body",
  "fabric-detail",
  "slimming-silhouette",
  "wearing-effect",
  "movement-drape",
  "side-back",
  "closing-pose",
]);

function validVisualHash(value) {
  return /^[0-9a-f]{16}$/i.test(String(value || ""));
}

function timelineEnd(unit) {
  return Number(unit.videoStart || 0) + Number(unit.duration || 0);
}

function intervalOverlap(left, right) {
  return Math.max(
    0,
    Math.min(timelineEnd(left), timelineEnd(right))
      - Math.max(Number(left.videoStart || 0), Number(right.videoStart || 0)),
  );
}

function similarVisual(left, right) {
  return validVisualHash(left.visualHash)
    && validVisualHash(right.visualHash)
    && hammingDistance(left.visualHash, right.visualHash) <= 4;
}

function timelineRole(unit) {
  return String(unit.timelineRole || unit.fashionRole || "");
}

function hasFullBodyEvidence(unit) {
  const pose = unit.fashionPose || unit.fashionVision?.pose || null;
  return String(unit.fashionRole || "") === "opening-full-body"
    || (String(pose?.bodyFrame || "") === "full-body" && Number(pose?.completeness || 0) >= 0.6);
}

function hasClosingEvidence(unit) {
  const pose = unit.fashionPose || unit.fashionVision?.pose || null;
  return String(unit.fashionRole || "") === "closing-pose"
    || (
      ["full-body", "three-quarter"].includes(String(pose?.bodyFrame || ""))
      && Number(pose?.completeness || 0) >= 0.6
      && Number(pose?.stability || 0) >= 0.45
    );
}

function inspectFashionPlan(plan, units, errors) {
  const totalDuration = Number(plan?.totalDuration);
  const unitDuration = units.reduce((sum, unit) => sum + (Number(unit.duration) || 0), 0);
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    errors.push("女装成片缺少有效总时长");
  } else if (!approximatelyEqual(unitDuration, totalDuration, 0.1)) {
    errors.push("女装画面时间线与计划总时长不一致");
  }
  if (
    Number.isFinite(Number(plan?.narrativeDuration))
    && !approximatelyEqual(plan.narrativeDuration, totalDuration, 0.1)
  ) {
    errors.push("女装成片时长与原声主线不一致");
  }

  const audioMode = String(plan?.audioMode || "original");
  if (audioMode !== "bgm") {
    if (!plan?.narrativeSourceId || !plan?.narrativeAudioPath) {
      errors.push("女装成片缺少连续原声主线");
    }
    if (
      Number.isFinite(Number(plan?.narrativeAudioDuration))
      && Number(plan.narrativeAudioDuration) + 0.1 < totalDuration
    ) {
      errors.push("连续原声主线不足以覆盖成片时长");
    }
  }

  if (units.length < 3) errors.push("女装成片至少需要 3 个真实镜头");
  const roles = new Set(units.map((unit) => String(unit.fashionRole || "")));
  const opening = units[0];
  const closing = units.at(-1);
  if (timelineRole(opening) !== "opening-full-body" || !hasFullBodyEvidence(opening)) {
    errors.push("女装成片缺少开场全身镜头");
  }
  if (timelineRole(closing) !== "closing-pose" || !hasClosingEvidence(closing)) {
    errors.push("女装成片缺少结尾定格镜头");
  }
  if ([...roles].some((role) => !FASHION_ROLES.has(role))) {
    errors.push("女装成片包含未完成语义识别的镜头");
  }

  const shotIds = new Set();
  for (const unit of units) {
    const shotId = String(unit.shotId || unit.segmentId || "");
    if (!shotId) errors.push("女装成片存在未标识来源的镜头");
    if (shotIds.has(shotId)) errors.push("同一女装时间窗口在一条成片中重复使用");
    shotIds.add(shotId);
  }

  for (let left = 0; left < units.length; left += 1) {
    for (let right = left + 1; right < units.length; right += 1) {
      const previous = units[left];
      const current = units[right];
      if (similarVisual(previous, current)) {
        errors.push("女装成片存在重复或近似画面");
      }
      if (previous.sourceId && previous.sourceId === current.sourceId) {
        if (intervalOverlap(previous, current) > 0.05) {
          errors.push("同一女装原素材的时间窗口发生重叠");
        }
      }
    }
  }
}

function inspectPlan(plan) {
  const units = Array.isArray(plan?.units) ? plan.units : [];
  const fashionMode = plan?.editingMode === "fashion-showcase";
  const errors = [];
  if (!units.length) errors.push("成片没有可渲染时间线");
  if (fashionMode) {
    inspectFashionPlan(plan, units, errors);
    const coveredTags = [...new Set(units.flatMap((unit) => unit.semanticTags || []))]
      .filter((tag) => tag !== "fashion-showcase")
      .sort();
    return {
      valid: errors.length === 0,
      errors: [...new Set(errors)],
      replacementRatio: 0,
      replacementCount: 0,
      externalBrollCount: 0,
      coveredTags: ["fashion-showcase", ...coveredTags],
    };
  }

  const anchorAudioPath = units[0]?.audioPath;
  if (units.length && !approximatelyEqual(units[0].audioStart, 0, 0.002)) {
    errors.push("主讲音频必须从 0 秒开始");
  }
  for (let index = 0; index < units.length; index += 1) {
    const current = units[index];
    if (current.audioPath !== anchorAudioPath) {
      errors.push("成片混入了其他素材声音");
    }
    if (index > 0) {
      const previous = units[index - 1];
      const expected = Number(previous.audioStart) + Number(previous.duration);
      if (!approximatelyEqual(current.audioStart, expected, 0.002)) {
        errors.push("主讲音频时间线不连续");
      }
    }
  }

  const final = units.at(-1);
  const finalAudioEnd = final
    ? Number(final.audioStart) + Number(final.duration)
    : 0;
  if (
    Number.isFinite(Number(plan?.narrativeDuration))
    && !approximatelyEqual(finalAudioEnd, plan.narrativeDuration, 0.1)
  ) {
    errors.push("成片时长与主讲素材不一致");
  }
  if (
    Number.isFinite(Number(plan?.narrativeDuration))
    && !approximatelyEqual(plan.totalDuration, plan.narrativeDuration, 0.1)
  ) {
    errors.push("计划总时长与主讲素材不一致");
  }

  const brollUnits = units.filter((unit) => unit.role === "broll");
  for (const unit of brollUnits) {
    if (unit.faceState !== "replaceable-product") {
      errors.push("B-roll 含有人脸或人物状态不确定");
    }
    if (unit.sourceId === plan.narrativeSourceId) {
      errors.push("B-roll 必须来自其他授权素材");
    }
  }

  for (let left = 0; left < brollUnits.length; left += 1) {
    for (let right = left + 1; right < brollUnits.length; right += 1) {
      if (brollUnits[left].shotId === brollUnits[right].shotId) continue;
      if (
        brollUnits[left].visualHash
        && brollUnits[right].visualHash
        && hammingDistance(
          brollUnits[left].visualHash,
          brollUnits[right].visualHash,
        ) <= 6
      ) {
        errors.push("同一成片使用了重复或近似商品镜头");
      }
    }
  }

  const brollDuration = brollUnits.reduce(
    (sum, unit) => sum + (Number(unit.duration) || 0),
    0,
  );
  const replacementRatio = Number(plan?.totalDuration) > 0
    ? Number((brollDuration / Number(plan.totalDuration)).toFixed(3))
    : 0;
  const replacementCount = brollUnits.length;

  if (plan?.editingMode) {
    if (replacementCount < 3) {
      errors.push("每条成片至少需要 3 个准确替换镜头");
    }
    if (new Set(brollUnits.map((unit) => unit.shotId)).size < 2) {
      errors.push("每条成片至少需要 2 个不同商品镜头");
    }
    const byShot = new Map();
    for (const unit of brollUnits) {
      const outputStart = Number(unit.outputStart ?? unit.audioStart);
      const uses = byShot.get(unit.shotId) || [];
      if (uses.length >= 2) errors.push("同一商品镜头最多使用 2 次");
      if (uses.some((start) => outputStart - start < 8)) {
        errors.push("重复商品镜头之间必须至少间隔 8 秒");
      }
      uses.push(outputStart);
      byShot.set(unit.shotId, uses);
    }
  } else if (replacementRatio < 0.15) {
    errors.push("有效替换比例低于 15%");
  }

  const coveredTags = [...new Set(brollUnits.flatMap((unit) =>
    unit.semanticTags || [])
    .filter((tag) => tag !== "generic-product"))].sort();

  return {
    valid: [...new Set(errors)].length === 0,
    errors: [...new Set(errors)],
    replacementRatio,
    replacementCount,
    externalBrollCount: replacementCount,
    coveredTags,
  };
}

module.exports = { inspectPlan };
