import "server-only";

import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { basename, extname, join, resolve } from "path";
import { deflateSync } from "zlib";
import { storagePaths } from "@/lib/storage-root";

export const MODEL_IMAGE_TEST_PROMPT = "Replace the face in this fictional adult test portrait with a different fictional adult woman. Keep the pose and plain white background.";

// A generated, non-user portrait keeps the image-edit test independent from identity packs and project assets.
export const MODEL_IMAGE_TEST_REFERENCE = createTestPortraitDataUrl();

export type ModelImageTestArtifact = {
  fileName: string;
  mimeType: string;
  transport: "b64_json" | "url";
  createdAt: string;
};

function rootDirectory() {
  return resolve(storagePaths.diagnostics("model-tests"));
}

function createTestPortraitDataUrl() {
  const width = 512;
  const height = 512;
  const pixels = Buffer.alloc(width * height * 4, 255);
  const paint = (x: number, y: number, red: number, green: number, blue: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = 255;
  };
  const circle = (centerX: number, centerY: number, radiusX: number, radiusY: number, color: [number, number, number]) => {
    for (let y = Math.floor(centerY - radiusY); y <= Math.ceil(centerY + radiusY); y++) {
      for (let x = Math.floor(centerX - radiusX); x <= Math.ceil(centerX + radiusX); x++) {
        const normalized = ((x - centerX) ** 2) / (radiusX ** 2) + ((y - centerY) ** 2) / (radiusY ** 2);
        if (normalized <= 1) paint(x, y, ...color);
      }
    }
  };
  const rectangle = (left: number, top: number, right: number, bottom: number, color: [number, number, number]) => {
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) paint(x, y, ...color);
    }
  };

  rectangle(120, 345, 392, 511, [86, 111, 132]);
  circle(256, 225, 110, 150, [47, 49, 55]);
  circle(256, 232, 84, 113, [224, 176, 142]);
  circle(226, 220, 8, 8, [48, 53, 62]);
  circle(286, 220, 8, 8, [48, 53, 62]);
  rectangle(238, 286, 274, 290, [167, 92, 91]);

  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const targetOffset = y * (width * 4 + 1);
    scanlines[targetOffset] = 0;
    pixels.copy(scanlines, targetOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function pngChunk(type: string, data: Buffer) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function crc32(input: Buffer) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "unknown";
}

function channelDirectory(ownerId: string, channelId: string) {
  const root = rootDirectory();
  const directory = resolve(join(root, safeSegment(ownerId), safeSegment(channelId)));
  if (!directory.startsWith(root)) throw new Error("Invalid model test storage path");
  return directory;
}

function extensionFor(mimeType: string) {
  if (/image\/(?:jpeg|jpg)/i.test(mimeType)) return "jpg";
  if (/image\/webp/i.test(mimeType)) return "webp";
  if (/image\/gif/i.test(mimeType)) return "gif";
  return "png";
}

async function readGeneratedImage(imageUrl: string) {
  if (imageUrl.startsWith("data:")) {
    const match = imageUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) throw new Error("测试图返回了无法保存的 Base64 数据。");
    return {
      bytes: Buffer.from(match[2], "base64"),
      mimeType: match[1] || "image/png",
      transport: "b64_json" as const,
    };
  }

  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`测试图 URL 下载失败：${response.status}`);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type") || "image/png",
    transport: "url" as const,
  };
}

export async function saveModelImageTestArtifact(input: {
  ownerId: string;
  channelId: string;
  imageUrl: string;
}): Promise<ModelImageTestArtifact> {
  const image = await readGeneratedImage(input.imageUrl);
  const directory = channelDirectory(input.ownerId, input.channelId);
  const fileName = `latest.${extensionFor(image.mimeType)}`;
  const createdAt = new Date().toISOString();
  const artifact: ModelImageTestArtifact = {
    fileName,
    mimeType: image.mimeType,
    transport: image.transport,
    createdAt,
  };

  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), image.bytes);
  await writeFile(join(directory, "latest.json"), JSON.stringify(artifact, null, 2), "utf8");
  return artifact;
}

export async function readModelImageTestArtifact(ownerId: string, channelId: string) {
  const directory = channelDirectory(ownerId, channelId);
  const metadata = JSON.parse(await readFile(join(directory, "latest.json"), "utf8")) as ModelImageTestArtifact;
  const fileName = basename(metadata.fileName);
  if (!fileName || fileName !== metadata.fileName) throw new Error("Invalid model test artifact");
  const filePath = join(directory, fileName);
  return {
    ...metadata,
    filePath,
    mimeType: metadata.mimeType || mimeFromName(fileName),
  };
}

function mimeFromName(name: string) {
  const extension = extname(name).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/png";
}
