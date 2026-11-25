import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { rm, writeFile } from "fs/promises";
import { promisify } from "util";
import {
  addGeneratedIdentityReference,
  deleteIdentityAuxiliaryAsset,
  createIdentityPack,
  deleteIdentityPack,
  deleteIdentityReference,
  finalizeIdentityPendingResult,
  getIdentityLibrary,
  getIdentityPendingResult,
  getIdentityPendingResults,
  identityFileUrl,
  identityImageFilePath,
  nextIdentityImageFileName,
  resetIdentityCalibrationReferences,
  saveIdentityPendingResult,
  saveIdentitySourceImage,
  setIdentityReferenceStatus,
  updateIdentityPendingResult,
} from "@/lib/identity-pack";
import { composeIdentityAuxiliaryAsset } from "@/lib/identity-auxiliary-assets";
import { storagePaths } from "@/lib/storage-root";

const ownerId = `identity-pack-test-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
const otherOwnerId = `${ownerId}-another-user`;
const ownerDir = storagePaths.identityPack(ownerId);
const otherOwnerDir = storagePaths.identityPack(otherOwnerId);
const execFileAsync = promisify(execFile);
const ffmpegPath = "D:\\Tools\\ffmpeg\\bin\\ffmpeg.exe";

async function writeFixturePng(filePath: string) {
  await execFileAsync(ffmpegPath, ["-y", "-f", "lavfi", "-i", "color=c=0xD8D0C8:s=64x96", "-frames:v", "1", filePath], { windowsHide: true });
}

afterEach(async () => {
  await rm(ownerDir, { recursive: true, force: true });
  await rm(otherOwnerDir, { recursive: true, force: true });
});

describe("identity pack library", () => {
  it("keeps packs account-isolated and requires explicit approval before use", async () => {
    const { pack } = await createIdentityPack({
      ownerId,
      packName: "Test performer",
      source: {
        title: "Original source",
        role: "Source reference",
        url: "/api/identity-pack/file/test-source.png",
      },
    });

    expect(pack.references).toHaveLength(1);
    expect(pack.identityPerformanceBaseline).toContain("real human presence appropriate to the observed current shot");
    expect(pack.references[0]).toMatchObject({ group: "source", status: "approved" });

    const generated = await addGeneratedIdentityReference({
      ownerId,
      packId: pack.id,
      reference: {
        title: "Front full body",
        role: "Calibration image",
        url: "/api/identity-pack/file/test-full-body.png",
        requiredFor: ["Manual project selection"],
        sourceKind: "full_body_front",
        group: "base",
        aspectRatio: "3:4",
      },
    });

    expect(generated.reference.status).toBe("draft");
    await setIdentityReferenceStatus({
      ownerId,
      packId: pack.id,
      referenceId: generated.reference.id,
      status: "approved",
    });

    const library = await getIdentityLibrary(ownerId);
    expect(library.packs[0].references.find((reference) => reference.id === generated.reference.id)?.status).toBe("approved");
    expect((await getIdentityLibrary(otherOwnerId)).packs).toHaveLength(0);

    const reset = await resetIdentityCalibrationReferences(ownerId, pack.id);
    expect(reset.pack.references.find((reference) => reference.id === generated.reference.id)?.status).toBe("archived");
    expect(reset.pack.references.find((reference) => reference.id === pack.sourceReferenceId)?.status).toBe("approved");
  });

  it("uses readable pack-based file names and permanently deletes only the selected pack files", async () => {
    const source = await saveIdentitySourceImage(ownerId, "admin", "source.png", Buffer.from("source"));
    expect(source.fileName).toMatch(/^admin人物脸部来源图\d{4}-\d{2}-\d{2}-\d{2}\.\d{2}\.png$/);

    const { pack } = await createIdentityPack({
      ownerId,
      packName: "新人物包",
      source: {
        title: "人物脸部来源图",
        role: "Source reference",
        url: source.url,
      },
    });

    const generatedAt = new Date("2026-07-16T04:54:00.000Z");
    const firstGeneratedName = await nextIdentityImageFileName(ownerId, "admin", "全身右侧45度图", ".png", generatedAt);
    expect(firstGeneratedName).toBe("admin全身右侧45度图2026-07-16-12.54.png");
    await writeFile(identityImageFilePath(ownerId, firstGeneratedName), Buffer.from("generated"));
    const nextGeneratedName = await nextIdentityImageFileName(ownerId, "admin", "全身右侧45度图", ".png", generatedAt);
    expect(nextGeneratedName).toBe("admin全身右侧45度图2026-07-16-12.54-02.png");

    const generated = await addGeneratedIdentityReference({
      ownerId,
      packId: pack.id,
      reference: {
        title: "全身右侧45度图",
        role: "Calibration image",
        url: identityFileUrl(firstGeneratedName),
        requiredFor: ["Manual project selection"],
        sourceKind: "full_body_right_45",
        group: "base",
        aspectRatio: "9:16",
      },
    });

    await expect(deleteIdentityReference(ownerId, pack.id, generated.reference.id, false)).rejects.toThrow("确认弹窗");
    const deletedReference = await deleteIdentityReference(ownerId, pack.id, generated.reference.id, true);
    expect(deletedReference.pack.references).toHaveLength(1);
    expect(deletedReference.deletedFileCount).toBe(1);
    expect(existsSync(identityImageFilePath(ownerId, firstGeneratedName))).toBe(false);

    await expect(deleteIdentityPack(ownerId, pack.id, false)).rejects.toThrow("确认弹窗");
    const deleted = await deleteIdentityPack(ownerId, pack.id, true);
    expect(deleted.library.packs).toHaveLength(0);
    expect(deleted.deletedFileCount).toBe(1);
    expect(existsSync(identityImageFilePath(ownerId, source.fileName))).toBe(false);
  });

  it("persists pending upstream results without exposing the image payload in summaries", async () => {
    const { pack } = await createIdentityPack({
      ownerId,
      packName: "Pending result pack",
      source: {
        title: "Original source",
        role: "Source reference",
        url: "/api/identity-pack/file/test-source.png",
      },
    });
    const pending = await saveIdentityPendingResult({
      ownerId,
      packId: pack.id,
      kind: "face_front",
      title: "人脸正面定型图",
      role: "Face calibration",
      sourceKind: "face_front",
      group: "base",
      aspectRatio: "3:4",
      requiredFor: ["Manual approval"],
      transport: "b64_json",
      payload: "data:image/png;base64,AAAA",
      generationTiming: { upstreamProcessingMs: 1200, resultTransferMs: 3400, totalMs: 4600, responseBodyBytes: 128 },
    });

    expect((await getIdentityPendingResult(ownerId, pending.id))?.payload).toBe("data:image/png;base64,AAAA");
    const summaries = await getIdentityPendingResults(ownerId, pack.id);
    expect(summaries[0]).toMatchObject({ id: pending.id, title: "人脸正面定型图", transport: "b64_json" });
    expect("payload" in summaries[0]).toBe(false);

    await updateIdentityPendingResult(ownerId, pending.id, { lastError: "temporary download error" });
    expect((await getIdentityPendingResult(ownerId, pending.id))?.lastError).toBe("temporary download error");

    const finalized = await finalizeIdentityPendingResult({
      ownerId,
      ownerName: "admin",
      pendingId: pending.id,
      image: { bytes: Buffer.from("generated-image"), ext: "png" },
    });
    expect(finalized.reference).toMatchObject({ status: "draft", aspectRatio: "3:4", generationTiming: { resultTransferMs: 3400 } });
    expect(finalized.reference.title).toMatch(/^admin人脸正面定型图\d{4}-/);
    expect(existsSync(identityImageFilePath(ownerId, finalized.fileName))).toBe(true);
    expect(await getIdentityPendingResult(ownerId, pending.id)).toBeNull();
  });

  it("locally composes approved calibration images into an independent auxiliary asset", async () => {
    const source = await saveIdentitySourceImage(ownerId, "admin", "source.png", Buffer.from("source"));
    const { pack } = await createIdentityPack({
      ownerId,
      packName: "Auxiliary asset pack",
      source: { title: "人物来源图", role: "Source reference", url: source.url },
    });
    const frontName = "admin全身正面比例图2026-07-18-10.00.png";
    const leftName = "admin全身左侧45度图2026-07-18-10.01.png";
    await writeFixturePng(identityImageFilePath(ownerId, frontName));
    await writeFixturePng(identityImageFilePath(ownerId, leftName));
    const front = await addGeneratedIdentityReference({
      ownerId,
      packId: pack.id,
      reference: {
        title: "全身正面比例图", role: "Full body front", url: identityFileUrl(frontName), requiredFor: ["Manual"], sourceKind: "full_body_front", group: "base", aspectRatio: "9:16",
      },
    });
    const left = await addGeneratedIdentityReference({
      ownerId,
      packId: pack.id,
      reference: {
        title: "全身左侧45度图", role: "Full body left", url: identityFileUrl(leftName), requiredFor: ["Manual"], sourceKind: "full_body_left_45", group: "base", aspectRatio: "9:16",
      },
    });
    await setIdentityReferenceStatus({ ownerId, packId: pack.id, referenceId: front.reference.id, status: "approved" });
    await setIdentityReferenceStatus({ ownerId, packId: pack.id, referenceId: left.reference.id, status: "approved" });

    const composed = await composeIdentityAuxiliaryAsset({
      ownerId,
      ownerName: "admin",
      packId: pack.id,
      kind: "base_multiview_sheet",
      title: "白底多视角板",
      referenceIds: [front.reference.id, left.reference.id],
    });
    expect(composed.asset).toMatchObject({ kind: "base_multiview_sheet", layout: "full_body" });
    expect(composed.asset.panels.map((panel) => panel.label)).toEqual(["01 全身正面", "02 全身左45度"]);
    expect(existsSync(identityImageFilePath(ownerId, composed.fileName))).toBe(true);

    const deleted = await deleteIdentityAuxiliaryAsset(ownerId, pack.id, composed.asset.id, true);
    expect(deleted.pack.auxiliaryAssets).toHaveLength(0);
    expect(deleted.pack.references.find((reference) => reference.id === front.reference.id)?.status).toBe("approved");
    expect(existsSync(identityImageFilePath(ownerId, composed.fileName))).toBe(false);
  });
});
