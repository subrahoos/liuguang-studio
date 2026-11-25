import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeStillImageMedia } from "@/lib/video-media-probe";

const tempDirs: string[] = [];
afterAll(async () => { await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("product production media inspection", () => {
  it("derives image dimensions and format from file bytes, not browser metadata", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "luma-production-image-"));
    tempDirs.push(directory);
    const filePath = path.join(directory, "misnamed.jpg");
    await writeFile(filePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=", "base64"));
    expect(await probeStillImageMedia(filePath)).toMatchObject({ ext: ".png", mimeType: "image/png", width: 1, height: 1 });
  });

  it("rejects invalid image contents", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "luma-production-invalid-"));
    tempDirs.push(directory);
    const filePath = path.join(directory, "fake.png");
    await writeFile(filePath, "not an image");
    await expect(probeStillImageMedia(filePath)).rejects.toThrow();
  });
});
