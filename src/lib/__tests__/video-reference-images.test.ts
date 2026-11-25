import { afterEach, describe, expect, it } from "vitest";
import { rm } from "fs/promises";
import { saveIdentitySourceImage } from "@/lib/identity-pack";
import { readLocalApiImageAsVideoReferenceDataUrl } from "@/lib/video-reference-images";
import { storagePaths } from "@/lib/storage-root";

const ownerId = `video-reference-test-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
const otherOwnerId = `${ownerId}-other-owner`;
const ownerDir = storagePaths.identityPack(ownerId);
const otherOwnerDir = storagePaths.identityPack(otherOwnerId);

afterEach(async () => {
  await rm(ownerDir, { recursive: true, force: true });
  await rm(otherOwnerDir, { recursive: true, force: true });
});

describe("video reference images", () => {
  it("reads identity-pack files locally for the owning account", async () => {
    const jpegBytes = Buffer.from("identity-pack-video-reference");
    const source = await saveIdentitySourceImage(ownerId, "admin", "video-reference.jpg", jpegBytes);
    const expected = `data:image/jpeg;base64,${jpegBytes.toString("base64")}`;

    await expect(readLocalApiImageAsVideoReferenceDataUrl(source.url, ownerId)).resolves.toBe(expected);
    await expect(readLocalApiImageAsVideoReferenceDataUrl(`http://127.0.0.1:3100${source.url}`, ownerId)).resolves.toBe(expected);
    await expect(readLocalApiImageAsVideoReferenceDataUrl(source.url, otherOwnerId)).resolves.toBeNull();
  });
});
