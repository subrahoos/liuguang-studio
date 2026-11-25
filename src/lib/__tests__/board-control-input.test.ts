import { describe, expect, it } from "vitest";
import { boardControlInputHealth } from "@/lib/board-control-input";
import type { BoardWorkflowNode } from "@/lib/board-workflows";

function node(id: string, kind: BoardWorkflowNode["kind"], role: string, assetRole = ""): BoardWorkflowNode {
  return {
    id,
    kind,
    title: id,
    createdAt: "2026-07-25T00:00:00.000Z",
    x: 0,
    y: 0,
    meta: role ? { controlRole: role } : assetRole ? { assetRole } : undefined,
  };
}

describe("board control input health", () => {
  it("requires exactly one source video for manual frame selection", () => {
    const control = node("select", "control", "select_frame");
    expect(boardControlInputHealth(control, []).missing).toEqual(["参考视频 1 份"]);
    expect(boardControlInputHealth(control, [node("a", "source_video", ""), node("b", "source_video", "")]).invalid)
      .toEqual(["参考视频只能保留 1 份"]);
  });

  it("accepts one storyboard, an optional action supplement, and an optional transcript for analysis", () => {
    const control = node("analyze", "control", "gpt_analyze");
    const storyboard = {
      ...node("storyboard", "storyboard", ""),
      meta: { evidenceSetId: "evidence-current" },
    };
    const actionSupplement = {
      ...node("action-evidence", "keyframe", ""),
      meta: { assetRole: "action_supplement_storyboard_collection", evidenceSetId: "evidence-current" },
    };
    const health = boardControlInputHealth(control, [
      storyboard,
      actionSupplement,
      {
        ...node("transcript", "analysis", "", "voiceover_transcript"),
        meta: { assetRole: "voiceover_transcript", evidenceSetId: "evidence-current" },
      },
    ]);
    expect(health.missing).toEqual([]);
    expect(health.invalid).toEqual([]);
    expect(health.readyText).toContain("3 项");
  });

  it("requires a Chinese transcript when the source video has audio", () => {
    const control = node("analyze", "control", "gpt_analyze");
    const storyboard = {
      ...node("storyboard", "storyboard", ""),
      meta: { evidenceSetId: "evidence-current" },
    };
    const actionSupplement = {
      ...node("action-evidence", "keyframe", ""),
      meta: { assetRole: "action_supplement_storyboard_collection", evidenceSetId: "evidence-current" },
    };

    const missingTranscript = boardControlInputHealth(control, [storyboard, actionSupplement], undefined, true);
    expect(missingTranscript.missing).toHaveLength(1);
    expect(missingTranscript.readyText).not.toContain("已就绪");

    const ready = boardControlInputHealth(control, [storyboard, actionSupplement, node("transcript", "analysis", "", "voiceover_transcript")], undefined, true);
    expect(ready.missing).toEqual([]);
    expect(ready.notices?.[0]).toContain("含音频");
  });

  it("allows storyboard-only analysis when no action supplement is manually connected", () => {
    const control = node("analyze", "control", "gpt_analyze");
    const health = boardControlInputHealth(control, [
      { ...node("storyboard", "storyboard", ""), meta: { evidenceSetId: "evidence-current" } },
    ], undefined, false);

    expect(health.missing).toEqual([]);
  });

  it("states that a transcript is not needed when the source video has no audio", () => {
    const control = node("analyze", "control", "gpt_analyze");
    const health = boardControlInputHealth(control, [
      { ...node("storyboard", "storyboard", ""), meta: { evidenceSetId: "evidence-current" } },
      { ...node("action-evidence", "keyframe", ""), meta: { assetRole: "action_supplement_storyboard_collection", evidenceSetId: "evidence-current" } },
    ], undefined, false);

    expect(health.missing).toEqual([]);
    expect(health.notices?.[0]).toContain("无需");
  });

  it("rejects a transcript from an older evidence extraction", () => {
    const control = node("analyze", "control", "gpt_analyze");
    const storyboard = {
      ...node("storyboard", "storyboard", ""),
      meta: { evidenceSetId: "evidence-new" },
    };
    const transcript = {
      ...node("transcript", "analysis", "", "voiceover_transcript"),
      meta: { assetRole: "voiceover_transcript", evidenceSetId: "evidence-old" },
    };

    expect(boardControlInputHealth(control, [storyboard, transcript], undefined, true).invalid)
      .toContain("中文口播转写不是当前故事板同一批证据，请从最新完整音频重新转写");
  });

  it("rejects duplicate director reports", () => {
    const control = node("director", "control", "gpt_director");
    const inputs = [
      node("report-a", "analysis", "", "reference_method_analysis"),
      node("report-b", "analysis", "", "reference_method_analysis"),
    ];
    expect(boardControlInputHealth(control, inputs).invalid).toEqual(["拆解报告只能保留 1 份"]);
  });

  it("reads the Chinese transcript through the report instead of a direct director connection", () => {
    const control = node("director", "control", "gpt_director");
    const inputs = [
      node("report", "analysis", "", "reference_method_analysis"),
      node("transcript", "analysis", "", "voiceover_transcript"),
    ];
    expect(boardControlInputHealth(control, inputs).invalid)
      .toContain("中文口播转写已封装进拆解报告，无需再连接到完整导演稿");
  });

  it("requires exactly one composited or repaired visual base for video generation", () => {
    const control = node("video", "control", "video_generate");
    const inputs = [
      node("director", "prompt", "", "video_director_prompt"),
      { ...node("base", "image_asset", "", "composite_image"), filePath: "D:\\tmp\\base.png" },
    ];
    expect(boardControlInputHealth(control, inputs).missing).toEqual([]);
    expect(boardControlInputHealth(control, inputs).invalid).toEqual([]);
  });

  it("keeps Lingganya's scene repair plate separate from the current-shot composite", () => {
    const control = node("video", "control", "video_generate");
    const image = (id: string, assetRole: string, meta: Record<string, unknown> = {}) => ({
      ...node(id, "image_asset", "", assetRole),
      filePath: `D:\\tmp\\${id}.png`,
      meta: { assetRole, ...meta },
    });
    const health = boardControlInputHealth(control, [
      node("director", "prompt", "", "video_director_prompt"),
      image("composite", "composite_image"),
      image("product", "product_image"),
      image("face", "face_front"),
      image("model", "outfit_front"),
      image("scene-repair", "clean_scene"),
    ], "sd-2.0");
    expect(health.missing).toEqual([]);
    expect(health.invalid).toEqual([]);
  });

  it("allows task-level candidate alternatives while requiring every five-image role", () => {
    const control = node("video", "control", "video_generate");
    const image = (id: string, assetRole: string) => ({
      ...node(id, "image_asset", "", assetRole),
      filePath: `D:\\tmp\\${id}.png`,
      meta: { assetRole },
    });
    const health = boardControlInputHealth(control, [
      node("director", "prompt", "", "video_director_prompt"),
      image("composite-task-1", "composite_image"),
      image("composite-task-2", "repaired_image"),
      image("product", "product_evidence_board"),
      image("face", "face_front"),
      image("model", "outfit_front"),
      image("scene-task-1", "clean_scene"),
      image("scene-task-2", "clean_scene"),
    ], "grok-imagine-video");
    expect(health.missing).toEqual([]);
    expect(health.invalid).toEqual([]);
  });

  it("reports direct replacement selections as not ready until all five responsibilities are selected", () => {
    const control = node("video", "control", "video_generate");
    const directChannel = {
      id: "rim-sd-multimedia",
      model: "video-ds-2.0",
      durationOptions: [15],
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 4,
      maxReferenceVideos: 3,
      maxReferenceAudios: 1,
    };
    const asset = (id: string, kind: BoardWorkflowNode["kind"], assetRole: string) => ({
      ...node(id, kind, "", assetRole),
      filePath: `D:\\tmp\\${id}.${kind === "source_video" ? "mp4" : "png"}`,
      meta: { assetRole },
    });
    const references = [
      asset("reference", "source_video", "reference_video"),
      asset("product", "image_asset", "product_image"),
      asset("face", "image_asset", "identity_image"),
      asset("model", "image_asset", "outfit_front"),
      asset("scene", "image_asset", "clean_scene"),
    ];

    const noSelection = boardControlInputHealth(control, [], directChannel);
    expect(noSelection.readyText).toBe("输入尚未就绪");
    expect(noSelection.missing).toEqual([
      "参考视频 1 个",
      "商品图 1 个",
      "人脸图 1 个",
      "人物图 1 个",
      "场景图 1 个",
    ]);

    const onlyVideoSelected = boardControlInputHealth({
      ...control,
      meta: { ...control.meta, directVideoReplacementReferenceIds: ["reference"] },
    }, references, directChannel);
    expect(onlyVideoSelected.readyText).toBe("输入尚未就绪");
    expect(onlyVideoSelected.missing).toEqual(["商品图 1 个", "人脸图 1 个", "人物图 1 个", "场景图 1 个"]);

    const ready = boardControlInputHealth(control, references, directChannel);
    expect(ready.missing).toEqual([]);
    expect(ready.invalid).toEqual([]);
    expect(ready.readyText).toBe("输入已就绪");
  });

  it("allows the two-channel optional-scene contract to run from the reference background", () => {
    const control = node("video-optional-scene", "control", "video_generate");
    const optionalChannel = {
      id: "lgy-sd-multimedia",
      model: "sd-2.0-T",
      durationOptions: [15],
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 4,
      maxReferenceVideos: 1,
      directVideoReplacementSceneOptional: true,
    };
    const asset = (id: string, kind: BoardWorkflowNode["kind"], assetRole: string) => ({
      ...node(id, kind, "", assetRole),
      filePath: `D:\\tmp\\${id}.${kind === "source_video" ? "mp4" : "png"}`,
      meta: { assetRole },
    });
    const references = [
      asset("reference", "source_video", "reference_video"),
      asset("product", "image_asset", "product_evidence_board"),
      asset("face", "image_asset", "identity_image"),
      asset("model", "image_asset", "outfit_front"),
    ];
    const health = boardControlInputHealth(control, references, optionalChannel);
    expect(health.missing).toEqual([]);
    expect(health.invalid).toEqual([]);
    expect(health.readyText).toBe("输入已就绪");
  });

  it("does not locally require a product board or full-body image for a saved product-front contract", () => {
    const control = node("video-product-front", "control", "video_generate");
    const productFrontChannel = {
      id: "lgy-product-front",
      baseUrl: "https://www.lingganyaapi.com/v1",
      model: "sd-2.0-vip",
      durationOptions: [15],
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 4,
      maxReferenceVideos: 1,
      directVideoReplacementSceneOptional: true,
      directVideoReplacementReferenceContract: "product_front_face" as const,
    };
    const asset = (id: string, kind: BoardWorkflowNode["kind"], assetRole: string) => ({
      ...node(id, kind, "", assetRole),
      filePath: `D:\\tmp\\${id}.${kind === "source_video" ? "mp4" : "png"}`,
      meta: { assetRole },
    });
    const health = boardControlInputHealth(control, [
      asset("reference", "source_video", "reference_video"),
      asset("product-front", "image_asset", "product_image"),
      asset("face", "image_asset", "identity_image"),
    ], productFrontChannel);
    expect(health.missing).toEqual([]);
    expect(health.invalid).toEqual([]);
    expect(health.readyText).toBe("输入已就绪");

    const faceOptionalHealth = boardControlInputHealth(control, [
      asset("reference", "source_video", "reference_video"),
      asset("product-front", "image_asset", "product_image"),
    ], {
      ...productFrontChannel,
      directVideoReplacementFaceOptional: true,
    });
    expect(faceOptionalHealth.missing).toEqual([]);
    expect(faceOptionalHealth.invalid).toEqual([]);
    expect(faceOptionalHealth.readyText).toBe("输入已就绪");
  });
});
