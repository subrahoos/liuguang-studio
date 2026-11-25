import { chineseFontFile, mediaExecutable } from "@/lib/runtime-tools";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PANEL_WIDTH = 720;
const PANEL_HEIGHT = 960;
const PANEL_HEADER_HEIGHT = 104;
const PRODUCT_AREA_HEIGHT = PANEL_HEIGHT - PANEL_HEADER_HEIGHT;

export type ProductEvidenceView = "front" | "back" | "left_side" | "right_side" | "side" | "detail" | "unconfirmed";

export type ProductEvidencePanelInput = {
  inputPath: string;
  sourceNodeId?: string;
  title?: string;
  description?: string;
};

export type ProductEvidencePanel = ProductEvidencePanelInput & {
  view: ProductEvidenceView;
  label: string;
};

const VIEW_ORDER: ProductEvidenceView[] = ["front", "back", "left_side", "right_side", "side", "detail", "unconfirmed"];

const VIEW_LABEL: Record<ProductEvidenceView, string> = {
  front: "正面 / FRONT",
  back: "背面 / BACK",
  left_side: "左侧 / LEFT SIDE",
  right_side: "右侧 / RIGHT SIDE",
  side: "侧面 / SIDE",
  detail: "细节 / DETAIL",
  unconfirmed: "视角待确认 / VIEW UNCONFIRMED",
};

function ffmpegExecutable() {
  return mediaExecutable("ffmpeg");
}

function gridFor(count: number) {
  if (count === 2) return { width: 1440, height: 960, layout: "0_0|720_0" };
  if (count === 3) return { width: 1440, height: 1920, layout: "0_0|720_0|360_960" };
  return { width: 1440, height: 1920, layout: "0_0|720_0|0_960|720_960" };
}

function normalizedViewText(input: ProductEvidencePanelInput) {
  return [input.title, input.description, basename(input.inputPath)]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .replace(/[_-]+/g, " ");
}

/** Classifies only explicit, unambiguous view words supplied with the product asset. */
export function productEvidenceViewFor(input: ProductEvidencePanelInput): ProductEvidenceView {
  const text = normalizedViewText(input);
  const matched: ProductEvidenceView[] = [];
  if (/(正面|前面|前视|前視|正视|正視|正拍|\bfront(?:\s+(?:view|side))?\b|\bfrontal\b)/iu.test(text)) matched.push("front");
  if (/(背面|后面|後面|后视|後視|背视|背視|\bback(?:\s+view)?\b|\brear\b)/iu.test(text)) matched.push("back");
  if (/(左侧|左側|左面|左视|左視|左边|左邊|\bleft(?:\s+(?:side|view|profile))?\b)/iu.test(text)) matched.push("left_side");
  if (/(右侧|右側|右面|右视|右視|右边|右邊|\bright(?:\s+(?:side|view|profile))?\b)/iu.test(text)) matched.push("right_side");
  if (matched.length === 1) return matched[0];
  if (matched.length > 1) return "unconfirmed";
  if (/(侧面|側面|侧视|側視|侧拍|側拍|侧边|側邊|\bside(?:\s+(?:view|profile))?\b|\bprofile\b)/iu.test(text)) return "side";
  if (/(细节|細節|局部|特写|特寫|\bdetail\b|\bclose ?up\b)/iu.test(text)) return "detail";
  return "unconfirmed";
}

/** Creates the panel order and labels that are burned into the actual PNG. */
export function prepareProductEvidencePanels(inputs: ProductEvidencePanelInput[]): ProductEvidencePanel[] {
  const seenPaths = new Set<string>();
  return inputs
    .filter((input) => {
      const inputPath = input.inputPath.trim();
      if (!inputPath || seenPaths.has(inputPath)) return false;
      seenPaths.add(inputPath);
      return true;
    })
    .slice(0, 4)
    .map((input) => {
      const view = productEvidenceViewFor(input);
      return { ...input, view, label: VIEW_LABEL[view] };
    })
    .sort((left, right) => VIEW_ORDER.indexOf(left.view) - VIEW_ORDER.indexOf(right.view));
}

function escapeDrawtextValue(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function escapeFilterPath(value: string) {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function productEvidenceFontFile() {
  const fontFile = chineseFontFile();
  if (!fontFile) throw new Error("未找到可绘制中文视角标签的系统字体，无法生成商品多视图证据板。");
  return fontFile;
}

/** Exposed for regression tests: every panel has a real title strip in the rendered image. */
export function buildProductEvidenceBoardFilter(panels: ProductEvidencePanel[], fontFile: string) {
  const grid = gridFor(panels.length);
  const panelFilters = panels.map((panel, index) => {
    const heading = `${String(index + 1).padStart(2, "0")} ${panel.label}`;
    const filters = [
      `[${index}:v]scale=700:${PRODUCT_AREA_HEIGHT - 20}:force_original_aspect_ratio=decrease`,
      `pad=${PANEL_WIDTH}:${PRODUCT_AREA_HEIGHT}:(ow-iw)/2:(oh-ih):color=white`,
      `pad=${PANEL_WIDTH}:${PANEL_HEIGHT}:0:${PANEL_HEADER_HEIGHT}:color=white`,
      `drawbox=x=0:y=0:w=${PANEL_WIDTH}:h=${PANEL_HEADER_HEIGHT}:color=0x111827:t=fill`,
      `drawtext=fontfile='${escapeFilterPath(fontFile)}':text='${escapeDrawtextValue(heading)}':fontcolor=white:fontsize=34:x=28:y=(${PANEL_HEADER_HEIGHT}-text_h)/2`,
    ].join(",");
    return `${filters}[p${index}]`;
  });
  const stackInputs = panels.map((_, index) => `[p${index}]`).join("");
  return `${panelFilters.join(";")};${stackInputs}xstack=inputs=${panels.length}:layout=${grid.layout}:fill=white,scale=${grid.width}:${grid.height}[out]`;
}

/**
 * Makes one local product evidence sheet. It occupies one video reference slot,
 * with each product view explicitly labelled in the image for downstream models.
 */
export async function composeProductEvidenceBoard(input: {
  panels: ProductEvidencePanelInput[];
  outputPath: string;
}) {
  const panels = prepareProductEvidencePanels(input.panels);
  if (panels.length < 2) throw new Error("至少需要两张商品结构图才能生成商品多视图证据板。");
  if (panels.some((panel) => !existsSync(panel.inputPath))) {
    throw new Error("有商品结构图已不存在，无法生成多视图证据板。");
  }

  await mkdir(dirname(input.outputPath), { recursive: true });
  const filter = buildProductEvidenceBoardFilter(panels, productEvidenceFontFile());
  const args = [
    "-y",
    ...panels.flatMap((panel) => ["-i", panel.inputPath]),
    "-filter_complex", filter,
    "-map", "[out]",
    "-frames:v", "1",
    input.outputPath,
  ];
  await execFileAsync(ffmpegExecutable(), args, { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (!existsSync(input.outputPath)) throw new Error("商品多视图证据板没有生成输出文件。");
  return { outputPath: input.outputPath, panels };
}
