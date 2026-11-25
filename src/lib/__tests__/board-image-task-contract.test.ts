import { describe, expect, it } from "vitest";
import {
  BOARD_IMAGE_TASK_CONTRACT_VERSION,
  buildCanonicalBoardImageTask,
} from "@/lib/board-image-task-contract";
import type { BoardWorkflowNode } from "@/lib/board-workflows";

function node(id: string, assetRole: string, meta: Record<string, unknown> = {}): BoardWorkflowNode {
  return {
    id,
    kind: "image_asset",
    title: id,
    x: 0,
    y: 0,
    createdAt: "2026-07-28T00:00:00.000Z",
    publicUrl: `/api/files/${id}.png`,
    meta: { assetRole, ...meta },
  };
}

describe("board image task contract", () => {
  it("builds the final prompt on the server contract and removes invented body measurements", () => {
    const result = buildCanonicalBoardImageTask({
      task: "outfit_front",
      referenceNodes: [
        node("person", "identity_image", { identityReferenceSourceKind: "full_body_front" }),
        node("product", "product_image"),
      ],
    });

    expect(result.promptMetadata).toMatchObject({
      imageTaskContractVersion: BOARD_IMAGE_TASK_CONTRACT_VERSION,
      serverOwnedPrompt: true,
    });
    expect(result.orderedNodes.map((item) => item.id)).toEqual(["product", "person"]);
    expect(result.promptEnglish).not.toMatch(/172|84\/60\/88|38 cm|closed-toe heels/i);
    expect(result.promptEnglish).toContain("Do not invent numeric measurements");
  });

  it("generates a product-only white-background image from directly selected product views", () => {
    const result = buildCanonicalBoardImageTask({
      task: "product_white_background",
      referenceNodes: [
        node("product-back", "product_image", { productGroupId: "group-1" }),
        node("product-front", "product_image", { productGroupId: "group-1" }),
      ],
    });

    expect(result.orderedNodes.map((item) => item.id)).toEqual(["product-front", "product-back"]);
    expect(result.title).toBe("商品白底图");
    expect(result.promptEnglish).toContain("PRODUCT-ONLY OUTPUT");
    expect(result.promptEnglish).toContain("WORN-GARMENT EXTRACTION");
    expect(result.promptEnglish).toContain("visible garment boundary");
    expect(result.promptEnglish).toContain("body proportions do not define the garment design");
    expect(result.promptEnglish).toContain("Remove only non-product subtitles");
    expect(result.promptEnglish).toContain("Preserve all text, labels, prints, Logos, and branding");
    expect(result.promptEnglish).not.toContain("model's body shape as garment evidence");
    expect(result.promptEnglish).not.toContain("true-white (#FFFFFF)");
    expect(result.promptEnglish).not.toContain("contact shadow");
    expect(() => buildCanonicalBoardImageTask({
      task: "product_white_background",
      referenceNodes: [node("product", "product_image"), node("person", "identity_image")],
    })).toThrow("商品白底图只接受商品图 1–3 张");
    expect(() => buildCanonicalBoardImageTask({
      task: "product_white_background",
      referenceNodes: [
        node("product-front-a", "product_image", { productGroupId: "group-a" }),
        node("product-back-b", "product_image", { productGroupId: "group-b" }),
      ],
    })).toThrow("必须来自同一个当前商品组");
  });

  it("uses non-overlapping authority domains for a composite image", () => {
    const result = buildCanonicalBoardImageTask({
      task: "composite_image",
      referenceNodes: [
        node("scene", "clean_scene"),
        node("shot", "selected_scene_frame"),
        node("outfit", "outfit_front"),
        node("face", "face_front"),
        node("product", "product_image"),
      ],
    });

    expect(result.orderedNodes.map((item) => item.id)).toEqual([
      "product", "face", "outfit", "scene", "shot",
    ]);
    expect(result.promptEnglish).toContain("A reference loses authority outside its listed domain.");
    expect(result.promptEnglish).toContain("Do not infer physical camera height");
  });

  it("requires one explicit English repair region and defect", () => {
    const target = node("base", "composite_image");
    expect(() => buildCanonicalBoardImageTask({
      task: "repaired_image",
      referenceNodes: [target],
    })).toThrow(/区域 \+ 可见缺陷 \+ 目标状态/);
    expect(() => buildCanonicalBoardImageTask({
      task: "repaired_image",
      referenceNodes: [target],
      repairInstruction: "右手修复",
    })).toThrow(/使用英文/);
    expect(buildCanonicalBoardImageTask({
      task: "repaired_image",
      referenceNodes: [target],
      repairInstruction: "Right hand near the waist: remove the duplicated fingertip and restore five natural fingers.",
    }).promptEnglish).toContain("APPROVED REPAIR TARGET");
  });

  it("keeps product and detail-image authority separate for replacement", () => {
    const result = buildCanonicalBoardImageTask({
      task: "detail_product_replacement",
      referenceNodes: [
        node("detail", "detail_reference_image"),
        node("white", "product_white_background"),
      ],
    });

    expect(result.orderedNodes.map((item) => item.id)).toEqual(["white", "detail"]);
    expect(result.promptEnglish).toContain("sole product authority");
    expect(result.promptEnglish).toContain("sole target-composition authority");
    expect(result.promptEnglish).toContain("Do not replace the model");
    expect(result.promptMetadata).toMatchObject({ batchItem: true, replacementMode: "product_only", preserveDetailTypography: false });
  });

  it("uses a frozen frontal face as the only identity authority for detail replacement", () => {
    const result = buildCanonicalBoardImageTask({
      task: "detail_product_replacement",
      referenceNodes: [
        node("detail", "detail_reference_image"),
        node("face", "identity_image", { identityReferenceSourceKind: "face_front" }),
        node("white", "product_white_background"),
      ],
    });

    expect(result.orderedNodes.map((item) => item.id)).toEqual(["white", "face", "detail"]);
    expect(result.title).toBe("详情图换装＋换脸");
    expect(result.promptMetadata).toMatchObject({ batchItem: true, replacementMode: "product_and_face" });
    expect(result.promptEnglish).toContain("sole facial-identity authority");
    expect(result.promptEnglish).toContain("Do not copy its expression");
    expect(result.promptEnglish).toContain("Preserve its hairstyle and hair silhouette");
    expect(result.promptEnglish).toContain("Adapt the supplied facial identity naturally");
  });

  it("rejects multiple faces and non-frontal identity references in detail replacement", () => {
    const base = [node("white", "product_white_background"), node("detail", "detail_reference_image")];
    expect(() => buildCanonicalBoardImageTask({
      task: "detail_product_replacement",
      referenceNodes: [...base, node("face-a", "face_front"), node("face-b", "face_front")],
    })).toThrow(/最多 1 张/);
    expect(() => buildCanonicalBoardImageTask({
      task: "detail_product_replacement",
      referenceNodes: [...base, node("body", "identity_image", { identityReferenceSourceKind: "full_body_front" })],
    })).toThrow(/只接受人脸正面图/);
  });
});
