import { chineseFontFile, mediaExecutable } from "@/lib/runtime-tools";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { mkdir, rename, unlink } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import {
  addIdentityAuxiliaryAsset,
  generatedImageDir,
  getIdentityPack,
  identityFileUrl,
  identityImageFilePath,
  nextIdentityImageFileName,
  resolveIdentityImageFile,
  type IdentityAuxiliaryAssetKind,
  type IdentityAuxiliaryAssetLayout,
  type IdentityReference,
} from "@/lib/identity-pack";

const execFileAsync = promisify(execFile);
const MAX_PANELS = 6;

const sourceKindLabels: Record<string, string> = {
  face_front: "人脸正面",
  full_body_front: "全身正面",
  full_body_left_45: "全身左45度",
  full_body_right_45: "全身右45度",
  full_body_side: "全身侧面",
  full_body_back: "全身背面",
  camera_eye_level: "平视半身",
  camera_high_angle: "轻俯视半身",
  camera_low_angle: "轻仰视全身",
  expression_neutral: "亲和开场",
  expression_smile: "热情分享",
  expression_bright_smile: "专注讲解",
  expression_turn_back: "卖点强调",
  expression_gesture: "互动疑问",
  expression_walk: "惊喜反应",
};

type ComposeInput = {
  ownerId: string;
  ownerName: string;
  packId: string;
  kind: IdentityAuxiliaryAssetKind;
  title: string;
  referenceIds: string[];
};

type SheetPlan = {
  layout: IdentityAuxiliaryAssetLayout;
  cellWidth: number;
  cellHeight: number;
  labelHeight: number;
};

function ffmpegExecutable() {
  return mediaExecutable("ffmpeg");
}

function auxiliaryAssetRole(kind: IdentityAuxiliaryAssetKind) {
  if (kind === "expression_sheet") return "表情与口型辅助参考板：只用于人物表情、眼神与口型范围，不替代人脸身份图。";
  if (kind === "base_multiview_sheet") return "白底多视角辅助参考板：只用于人物全身比例、姿态与前后左右视角。";
  if (kind === "camera_pose_sheet") return "镜头姿态辅助参考板：只用于人物与镜头的相对角度和构图关系。";
  return "自定义人物辅助参考板：只按每个编号面板的用途提供辅助参考。";
}

function validateReferenceGroups(kind: IdentityAuxiliaryAssetKind, references: IdentityReference[]) {
  if (references.some((reference) => reference.group === "source")) {
    throw new Error("辅助资产只能使用白底定型、镜头适配或表情口型中已通过验收的图片。");
  }
  const expectedGroup = kind === "expression_sheet"
    ? "expression"
    : kind === "base_multiview_sheet"
      ? "base"
      : kind === "camera_pose_sheet"
        ? "camera"
        : null;
  if (expectedGroup && references.some((reference) => reference.group !== expectedGroup)) {
    throw new Error("该辅助资产只能使用对应分组中已通过验收的图片。");
  }
}

function createPlan(kind: IdentityAuxiliaryAssetKind, references: IdentityReference[]): SheetPlan {
  if (kind === "base_multiview_sheet") {
    return { layout: "full_body", cellWidth: 720, cellHeight: 1280, labelHeight: 88 };
  }
  if (kind === "expression_sheet" || kind === "camera_pose_sheet") {
    return { layout: "portrait", cellWidth: 720, cellHeight: 960, labelHeight: 82 };
  }
  const allFullBody = references.every((reference) => reference.aspectRatio === "9:16");
  return allFullBody
    ? { layout: "full_body", cellWidth: 720, cellHeight: 1280, labelHeight: 88 }
    : { layout: "mixed", cellWidth: 720, cellHeight: 1040, labelHeight: 86 };
}

function gridCoordinates(count: number, cellWidth: number, cellHeight: number) {
  if (count === 2) return { width: cellWidth * 2, height: cellHeight, points: ["0_0", `${cellWidth}_0`] };
  if (count === 3) return { width: cellWidth * 3, height: cellHeight, points: ["0_0", `${cellWidth}_0`, `${cellWidth * 2}_0`] };
  if (count === 4) return {
    width: cellWidth * 2,
    height: cellHeight * 2,
    points: ["0_0", `${cellWidth}_0`, `0_${cellHeight}`, `${cellWidth}_${cellHeight}`],
  };
  if (count === 5) return {
    width: cellWidth * 3,
    height: cellHeight * 2,
    points: ["0_0", `${cellWidth}_0`, `${cellWidth * 2}_0`, `${Math.floor(cellWidth / 2)}_${cellHeight}`, `${Math.floor(cellWidth * 1.5)}_${cellHeight}`],
  };
  return {
    width: cellWidth * 3,
    height: cellHeight * 2,
    points: ["0_0", `${cellWidth}_0`, `${cellWidth * 2}_0`, `0_${cellHeight}`, `${cellWidth}_${cellHeight}`, `${cellWidth * 2}_${cellHeight}`],
  };
}

function drawtextEscape(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function fontFileArgument() {
  return chineseFontFile().replace(/\\/g, "/").replace(/:/g, "\\:");
}

function panelLabel(reference: IdentityReference, index: number) {
  const label = reference.group === "source"
    ? "身份来源"
    : sourceKindLabels[reference.sourceKind || ""] || reference.title;
  return `${String(index + 1).padStart(2, "0")} ${label}`.slice(0, 40);
}

async function renderSheet(inputPaths: string[], references: IdentityReference[], plan: SheetPlan, destination: string) {
  const imageHeight = plan.cellHeight - plan.labelHeight;
  const fontFile = fontFileArgument();
  const panels = inputPaths.map((_, index) => {
    const label = drawtextEscape(panelLabel(references[index], index));
    const drawText = fontFile
      ? `,drawtext=fontfile='${fontFile}':text='${label}':x=22:y=${imageHeight + Math.floor(plan.labelHeight / 2) - 16}:fontsize=28:fontcolor=white`
      : "";
    return `[${index}:v]scale=${plan.cellWidth}:${imageHeight}:force_original_aspect_ratio=decrease,pad=${plan.cellWidth}:${imageHeight}:(ow-iw)/2:(oh-ih)/2:color=white,pad=${plan.cellWidth}:${plan.cellHeight}:0:0:color=white,drawbox=x=0:y=${imageHeight}:w=${plan.cellWidth}:h=${plan.labelHeight}:color=0x10252A:t=fill${drawText}[panel${index}]`;
  });
  const grid = gridCoordinates(references.length, plan.cellWidth, plan.cellHeight);
  const inputs = references.map((_, index) => `[panel${index}]`).join("");
  const filter = `${panels.join(";")};${inputs}xstack=inputs=${references.length}:layout=${grid.points.join("|")}:fill=white,scale=${grid.width}:${grid.height}[output]`;
  const args = ["-y", ...inputPaths.flatMap((filePath) => ["-i", filePath]), "-filter_complex", filter, "-map", "[output]", "-frames:v", "1", destination];
  await execFileAsync(ffmpegExecutable(), args, { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
}

export async function composeIdentityAuxiliaryAsset(input: ComposeInput) {
  const pack = await getIdentityPack(input.ownerId, input.packId);
  if (!pack) throw new Error("人物包不存在或已归档。");
  const referenceIds = Array.from(new Set(input.referenceIds.map(String).filter(Boolean))).slice(0, MAX_PANELS);
  if (referenceIds.length < 2) throw new Error("至少选择 2 张已验收人物图后才能合成本地辅助资产。");
  if (input.referenceIds.length > MAX_PANELS) throw new Error("单张辅助资产最多只能合成 6 个面板。");

  const references = referenceIds.map((referenceId) => pack.references.find((reference) => reference.id === referenceId));
  if (references.some((reference) => !reference || reference.status !== "approved")) {
    throw new Error("辅助资产只能使用当前人物包中已通过验收的图片。");
  }
  const selectedReferences = references as IdentityReference[];
  if (new Set(selectedReferences.map((reference) => reference.sourceKind).filter(Boolean)).size !== selectedReferences.filter((reference) => Boolean(reference.sourceKind)).length) {
    throw new Error("同一种目标图只能选择一个已验收版本，请先决定使用哪一张。");
  }
  validateReferenceGroups(input.kind, selectedReferences);

  const sourceFiles = selectedReferences.map((reference) => resolveIdentityImageFile(input.ownerId, reference.url));
  if (sourceFiles.some((filePath) => !filePath)) throw new Error("有来源图片已被删除，无法合成辅助资产。");

  const plan = createPlan(input.kind, selectedReferences);
  const title = input.title.trim().slice(0, 48) || "自定义组合参考板";
  const fileName = await nextIdentityImageFileName(input.ownerId, input.ownerName, title, ".png");
  const finalPath = identityImageFilePath(input.ownerId, fileName);
  const tempPath = join(generatedImageDir(input.ownerId), `.${randomUUID()}.png`);

  await mkdir(generatedImageDir(input.ownerId), { recursive: true });
  try {
    await renderSheet(sourceFiles as string[], selectedReferences, plan, tempPath);
    await rename(tempPath, finalPath);
    const result = await addIdentityAuxiliaryAsset({
      ownerId: input.ownerId,
      packId: pack.id,
      asset: {
        title: fileName.replace(/\.[^.]+$/, ""),
        role: auxiliaryAssetRole(input.kind),
        url: identityFileUrl(fileName),
        kind: input.kind,
        layout: plan.layout,
        panels: selectedReferences.map((reference, index) => ({
          referenceId: reference.id,
          title: reference.title,
          role: reference.role,
          group: reference.group,
          sourceKind: reference.sourceKind,
          label: panelLabel(reference, index),
          order: index + 1,
        })),
      },
    });
    return { ...result, fileName };
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    await unlink(finalPath).catch(() => undefined);
    throw error;
  }
}
