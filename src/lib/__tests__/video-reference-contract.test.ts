import { describe, expect, it } from "vitest";
import {
  bindDirectVideoReplacementMediaAliases,
  buildDirectVideoReplacementPrompt,
  directVideoReplacementPackageFromNodes,
  directVideoReplacementReferenceRole,
  resolveDirectVideoReplacementReferenceIds,
  isDirectVideoReplacementAudioReference,
  buildVideoPromptWithReferenceResponsibilities,
  grokReferencePackageFromNodes,
  usesVideoReferenceRolePackage,
} from "@/lib/video-reference-contract";
import type { BoardWorkflowNode } from "@/lib/board-workflows";

function node(id: string, assetRole: string, meta: Record<string, unknown> = {}): BoardWorkflowNode {
  return {
    id,
    kind: "image_asset",
    title: id,
    x: 0,
    y: 0,
    createdAt: new Date().toISOString(),
    filePath: `D:\\tmp\\${id}.png`,
    meta: { assetRole, ...meta },
  };
}

describe("video reference contract", () => {
  it("adds explicit Seedance media aliases without changing the generated contract", () => {
    const chinese = bindDirectVideoReplacementMediaAliases("原提示词", "zh-CN");
    expect(chinese).toContain("@video1 是唯一参考视频和严格锁定的视频模板");
    expect(chinese).toContain("@image1 只负责替换模特当前穿着的整件上衣");
    expect(chinese).toContain("原提示词");
    expect(bindDirectVideoReplacementMediaAliases(chinese, "zh-CN")).toBe(chinese);

    const english = bindDirectVideoReplacementMediaAliases("Original prompt", "en");
    expect(english).toContain("@video1 is the sole reference video");
    expect(english).toContain("@image1 supplies only the replacement product");
  });

  it("accepts exactly one direct reference video plus the four replacement roles", () => {
    const video: BoardWorkflowNode = {
      id: "reference-video",
      kind: "source_video",
      title: "reference-video",
      x: 0,
      y: 0,
      createdAt: new Date().toISOString(),
      filePath: "D:\\tmp\\reference.mp4",
      meta: { assetRole: "reference_video" },
    };
    const result = directVideoReplacementPackageFromNodes([
      node("scene", "clean_scene"),
      node("person", "outfit_front"),
      node("face", "identity_image"),
      node("product", "product_image"),
      video,
    ]);
    expect(result.error).toBeUndefined();
    expect(result.package?.ordered.map((item) => item.id)).toEqual([
      "reference-video", "product", "face", "person", "scene",
    ]);
    expect(directVideoReplacementReferenceRole(video)).toBe("reference_video");
    expect(directVideoReplacementReferenceRole(node("full-body", "identity_image", {
      identityReferenceSourceKind: "full_body_front",
    }))).toBe("model");
    const prompt = buildDirectVideoReplacementPrompt(false, "zh-CN");
    expect(prompt).toContain("【总原则】本任务是基于参考视频重新生成");
    expect(prompt).toContain("参考视频绝不提供人物身份、商品、穿搭或背景的视觉事实");
    expect(prompt).toContain("【图 2：脸部】图 2 是人物身份唯一且不可覆盖的来源");
    expect(prompt).toContain("【图 1：商品多视图故事板】图 1 始终是当前商品可见事实的唯一来源");
    expect(prompt).toContain("必须将参考视频原人物的脸完整替换为图 2 中的人物");
    expect(prompt).toContain("最终成片中不得出现参考视频原人物的人脸");
    expect(prompt).toContain("首尾状态保留的是动作、姿态、构图和空间关系");
    expect(prompt).toContain("不得新增镜头、切点、人物、商品、背景设计、动作轮次或未出现的互动");
    expect(prompt).toContain("【音频】未接入参考音频");
    expect(prompt).toContain("【参考视频结束后的片尾延展】本次成片总时长为 15 秒");
    expect(prompt).toContain("第 9 秒至第 15 秒必须从第 9 秒最后一个真实画面状态自然向后衍生");
    expect(prompt).toContain("不得重复播放前 9 秒，不得回到起始状态");
    expect(prompt.endsWith("不得重复播放前 9 秒，不得回到起始状态，不得新增镜头、切点、景别变化、人物、商品、道具、场景、动作轮次、重新接触、松手后再次接触、文字、字幕、对白、口型、音乐或音效。")).toBe(true);
    expect(prompt).not.toContain("REFERENCE VIDEO");
    const englishPrompt = buildDirectVideoReplacementPrompt();
    expect(englishPrompt).toContain("REFERENCE VIDEO is the sole authority");
    expect(englishPrompt).toContain("Image 2 FACE: face identity, hair, skin tone, and age.");
    expect(englishPrompt).toContain("Image 1 PRODUCT MULTI-VIEW EVIDENCE BOARD");
    expect(englishPrompt).toContain("No new text, subtitles");
    const audio: BoardWorkflowNode = {
      id: "reference-audio",
      kind: "audio",
      title: "reference-audio",
      x: 0,
      y: 0,
      createdAt: new Date().toISOString(),
      filePath: "D:\\tmp\\reference.mp3",
      meta: { assetRole: "audio_evidence" },
    };
    expect(isDirectVideoReplacementAudioReference(audio)).toBe(true);
    expect(buildDirectVideoReplacementPrompt(true, "zh-CN")).toContain("【音频】参考音频是对白、声线、音乐、音效和时间点的唯一来源");
    expect(buildDirectVideoReplacementPrompt(true)).toContain("REFERENCE AUDIO is the sole authority");
  });

  it("defaults direct replacement to the newest product storyboard when one is available", () => {
    const ids = resolveDirectVideoReplacementReferenceIds([
      node("product-raw", "product_image"),
      node("product-board-old", "product_evidence_board"),
      node("product-board-new", "product_evidence_board"),
    ]);
    expect(ids).toEqual(["product-board-new"]);
  });

  it("uses only a raw front product image and face for the saved product-front contract", () => {
    const video: BoardWorkflowNode = {
      id: "reference-video",
      kind: "source_video",
      title: "reference-video",
      x: 0,
      y: 0,
      createdAt: new Date().toISOString(),
      filePath: "D:\\tmp\\reference.mp4",
      meta: { assetRole: "reference_video" },
    };
    const product = node("product-front", "product_image");
    const face = node("face", "identity_image");
    const ids = resolveDirectVideoReplacementReferenceIds([
      video,
      node("product-board", "product_evidence_board"),
      product,
      face,
      node("person", "outfit_front"),
      node("scene", "clean_scene"),
    ], undefined, { referenceContract: "product_front_face" });
    expect(ids).toEqual(["reference-video", "product-front", "face", "scene"]);

    const result = directVideoReplacementPackageFromNodes([video, product, face], {
      sceneOptional: true,
      referenceContract: "product_front_face",
    });
    expect(result.error).toBeUndefined();
    expect(result.package?.ordered.map((item) => item.id)).toEqual(["reference-video", "product-front", "face"]);
    expect(result.package?.model).toBeUndefined();

    const prompt = buildDirectVideoReplacementPrompt(false, "zh-CN", false, "product_front_face");
    expect(prompt).toContain("【图 1：商品正面原图】");
    expect(prompt).toContain("【图 2：脸部】");
    expect(prompt).toContain("图 1 未展示的背面、侧面、内部或隐藏结构");
    expect(prompt).toContain("【参考视频平台叠加层清除】");
    expect(prompt).toContain("抖音 Logo、抖音号或账号文字，以及搜索框内的文字或图标");
    expect(prompt).toContain("【场景图未连接】本次没有提供场景图");
    expect(prompt).not.toContain("商品多视图故事板");
    expect(prompt).not.toContain("【图 3：人物与非商品穿搭】");

    const v1 = buildDirectVideoReplacementPrompt(false, "zh-CN", false, "product_front_face", true, true, 10, 9, false, "v1");
    const v2 = buildDirectVideoReplacementPrompt(false, "zh-CN", false, "product_front_face", true, true, 10, 9, false, "v2");
    expect(v1).not.toContain("【直接替换上衣】");
    expect(v2).toContain("【直接替换上衣】");
    expect(v2).toContain("【核心任务与允许改动】编辑参考视频：以参考视频作为严格锁定的视频模板");
    expect(v2).toContain("只把模特当前穿着的整件上衣替换成图 1 商品图中的上衣");
    expect(v2).toContain("图 1 只负责整件上衣，图 2 只负责人物脸部、头部与身份");
    expect(v2).toContain("除这些指定叠加层、原上衣内容及已授权替换领域外，不得擅自删除");
    expect(v2).not.toContain("基于参考视频重新生成");
    expect(v2).not.toContain("商品优先于脸部");
    expect(v2).not.toContain("그대로");
    expect(buildDirectVideoReplacementPrompt(false, "en", false, "product_front_face", true, false, 10, 9, false, "v2"))
      .not.toContain("【直接替换上衣】");

    const englishPrompt = buildDirectVideoReplacementPrompt(false, "en", false, "product_front_face");
    expect(englishPrompt).toContain("【IMAGE 1: PRODUCT FRONT ORIGINAL】");
    expect(englishPrompt).toContain("【IMAGE 2: FACE】");
    expect(englishPrompt).toContain("【REFERENCE-VIDEO PLATFORM OVERLAY REMOVAL】");
    expect(englishPrompt).toContain("Douyin logo at the top left");
    expect(englishPrompt).toContain("NO SCENE REFERENCE IMAGE IS SUPPLIED");
    expect(englishPrompt).toContain("【TAIL EXTENSION AFTER THE REFERENCE VIDEO】");
    expect(englishPrompt).toContain("From second 9 through second 15");
    expect(englishPrompt).not.toContain("PRODUCT MULTI-VIEW EVIDENCE BOARD");
    expect(englishPrompt).not.toContain("MODEL/OUTFIT");

    const mkosorPrompt = buildDirectVideoReplacementPrompt(
      false,
      "en",
      false,
      "product_front_face",
      true,
      false,
      10,
      9,
      true,
    );
    expect(mkosorPrompt).toContain("【IMAGE 2: FACE — HARD IDENTITY CONDITION】");
    expect(mkosorPrompt).toContain("The reference video is motion-only");
    expect(mkosorPrompt).toContain("non-product clothing");
    expect(mkosorPrompt).toContain("Occlusion locks geometry only");
    expect(mkosorPrompt).not.toContain("non-product styling");
    expect(mkosorPrompt).toContain("source hair identity");

    const tenSecondPrompt = buildDirectVideoReplacementPrompt(false, "zh-CN", false, "product_front_face", false, true, 10, 9);
    expect(tenSecondPrompt).toContain("本次成片总时长为 10 秒");
    expect(tenSecondPrompt).toContain("第 9 秒至第 10 秒必须从第 9 秒最后一个真实画面状态自然向后衍生");
    expect(tenSecondPrompt).not.toContain("第 9 秒至第 15 秒");
    const tenSecondEnglishPrompt = buildDirectVideoReplacementPrompt(false, "en", false, "product_front_face", true, false, 10, 9);
    expect(tenSecondEnglishPrompt).toContain("The finished video is 10 seconds long");
    expect(tenSecondEnglishPrompt).toContain("From second 9 through second 10");
    const noExtensionPrompt = buildDirectVideoReplacementPrompt(false, "zh-CN", false, "product_front_face", true, false, 10, 10);
    expect(noExtensionPrompt).not.toContain("参考视频结束后的片尾延展");
  });

  it("allows a saved product-front channel to retain the reference-video identity when no face image is selected", () => {
    const video: BoardWorkflowNode = {
      id: "reference-video",
      kind: "source_video",
      title: "reference-video",
      x: 0,
      y: 0,
      createdAt: new Date().toISOString(),
      filePath: "D:\\tmp\\reference.mp4",
      meta: { assetRole: "reference_video" },
    };
    const product = node("product-front", "product_image");
    const scene = node("scene", "clean_scene");
    const withoutFace = directVideoReplacementPackageFromNodes([video, product], {
      sceneOptional: true,
      faceOptional: true,
      referenceContract: "product_front_face",
    });
    expect(withoutFace.error).toBeUndefined();
    expect(withoutFace.missing).toEqual([]);
    expect(withoutFace.package?.face).toBeUndefined();
    expect(withoutFace.package?.ordered.map((item) => item.id)).toEqual(["reference-video", "product-front"]);

    const withScene = directVideoReplacementPackageFromNodes([video, product, scene], {
      sceneOptional: true,
      faceOptional: true,
      referenceContract: "product_front_face",
    });
    expect(withScene.error).toBeUndefined();
    expect(withScene.package?.ordered.map((item) => item.id)).toEqual(["reference-video", "product-front", "scene"]);

    const prompt = buildDirectVideoReplacementPrompt(false, "zh-CN", false, "product_front_face", false, true, 15, 9, false, "v2");
    expect(prompt).toContain("【素材绑定】编辑 @video1：只将模特当前穿着的整件上衣替换为 @image1 中的商品");
    expect(prompt).toContain("【参考视频锁定】@video1 是唯一的视频模板");
    expect(prompt).toContain("【商品替换】替换后的上衣必须准确还原 @image1 中可见的款式");
    expect(prompt).toContain("【清理与禁止项】清除参考视频左上角的抖音 Logo");
    expect(prompt).not.toContain("基于参考视频重新生成");
    expect(prompt).not.toContain("商品优先于参考视频人物");
    expect(prompt).not.toContain("【图 2：脸部】");
    expect(prompt).not.toContain("【场景图未连接】");
    expect(bindDirectVideoReplacementMediaAliases(prompt, "zh-CN")).toBe(prompt);

    const scenePrompt = buildDirectVideoReplacementPrompt(false, "zh-CN", true, "product_front_face", false, true);
    expect(scenePrompt).toContain("【图 2：场景】");

    const v2WithFaceAndScene = buildDirectVideoReplacementPrompt(
      false, "zh-CN", true, "product_front_face", true, true, 15, 9, false, "v2",
    );
    expect(v2WithFaceAndScene).toContain("【图 2：人物身份】");
    expect(v2WithFaceAndScene).toContain("【图 3：场景】");
    expect(v2WithFaceAndScene).not.toContain("【场景图未连接】");
    expect(v2WithFaceAndScene).not.toContain("基于参考视频重新生成");

    const v2WithoutFaceAndWithScene = buildDirectVideoReplacementPrompt(
      false, "zh-CN", true, "product_front_face", false, true, 15, 9, false, "v2",
    );
    expect(v2WithoutFaceAndWithScene).toContain("【图 2：场景】");
    expect(v2WithoutFaceAndWithScene).toContain("【参考视频锁定】@video1 是唯一的视频模板");
    expect(v2WithoutFaceAndWithScene).not.toContain("【图 2：人物身份】");
    expect(v2WithoutFaceAndWithScene).not.toContain("基于参考视频重新生成");
  });

  it("allows an optional scene reference and tells the prompt to preserve the video background", () => {
    const video: BoardWorkflowNode = {
      id: "reference-video",
      kind: "source_video",
      title: "reference-video",
      x: 0,
      y: 0,
      createdAt: new Date().toISOString(),
      filePath: "D:\\tmp\\reference.mp4",
      meta: { assetRole: "reference_video" },
    };
    const result = directVideoReplacementPackageFromNodes([
      video,
      node("product", "product_evidence_board"),
      node("face", "identity_image"),
      node("person", "outfit_front"),
    ], { sceneOptional: true });
    expect(result.error).toBeUndefined();
    expect(result.package?.scene).toBeUndefined();
    expect(result.package?.ordered.map((item) => item.id)).toEqual([
      "reference-video", "product", "face", "person",
    ]);
    const prompt = buildDirectVideoReplacementPrompt(false, "zh-CN", false);
    expect(prompt).toContain("【场景图未连接】本次没有提供场景图");
    expect(prompt).toContain("必须完整延续参考视频背景");
    expect(prompt).toContain("背景空间、背景物体、背景材质、纵深、环境尺度");
  });

  it("rejects a direct replacement selection that omits the reference video", () => {
    const result = directVideoReplacementPackageFromNodes([
      node("product", "product_image"),
      node("face", "identity_image"),
      node("person", "outfit_front"),
      node("scene", "clean_scene"),
    ]);
    expect(result.error).toContain("缺少 参考视频 1 个");
  });

  it("uses the five-role package for Grok multi-reference and Lingganya, not single-image Grok", () => {
    expect(usesVideoReferenceRolePackage("grok-imagine-video")).toBe(true);
    expect(usesVideoReferenceRolePackage("sd-2.0")).toBe(true);
    expect(usesVideoReferenceRolePackage("grok-imagine-video-1.5")).toBe(false);
  });

  it("requires and orders the fixed five Grok workflow references", () => {
    const result = grokReferencePackageFromNodes([
      node("scene", "clean_scene"),
      node("model", "outfit_front"),
      node("face", "face_front"),
      node("product", "product_image"),
      node("base", "composite_image"),
    ]);

    expect(result.error).toBeUndefined();
    expect(result.package?.ordered.map((item) => item.id)).toEqual([
      "base", "product", "face", "model", "scene",
    ]);
  });

  it("accepts one local product evidence board as the product responsibility", () => {
    const result = grokReferencePackageFromNodes([
      node("base", "composite_image"),
      node("product-views", "product_evidence_board", { productEvidenceViews: [{ index: 1, view: "front" }] }),
      node("face", "face_front"),
      node("model", "outfit_front"),
      node("scene", "clean_scene"),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.package?.product.id).toBe("product-views");
    const prompt = buildVideoPromptWithReferenceResponsibilities("IMPORTANT:\nTest.", result.package!.ordered);
    expect(prompt).toContain("Reference Image 2: PRODUCT MULTI-VIEW (read in-image view headers; no flip/mirror/inference).");
  });

  it("keeps an older evidence board without in-image labels on the ordinary product contract", () => {
    const references = grokReferencePackageFromNodes([
      node("base", "composite_image"),
      node("old-product-views", "product_evidence_board"),
      node("face", "face_front"),
      node("model", "outfit_front"),
      node("scene", "clean_scene"),
    ]).package!.ordered;
    const prompt = buildVideoPromptWithReferenceResponsibilities("IMPORTANT:\nTest.", references);

    expect(prompt).toContain("Reference Image 2: PRODUCT FACTS (construction/material/color/brand).");
    expect(prompt).not.toContain("PRODUCT MULTI-VIEW");
  });

  it("rejects missing or duplicate Grok workflow reference roles", () => {
    const missingResult = grokReferencePackageFromNodes([
      node("base", "composite_image"),
    ]);
    expect(missingResult.missing).toEqual([
      "商品图 1 张",
      "人脸正面定型图 1 张",
      "当前镜头模特图 1 张",
      "场景空镜图 1 张",
    ]);
    expect(grokReferencePackageFromNodes([
      node("base", "composite_image"),
      node("product-a", "product_image"),
      node("product-b", "product_image"),
      node("face", "face_front"),
      node("model", "outfit_front"),
      node("scene", "clean_scene"),
    ]).invalid).toContain("商品图只能保留 1 张（当前 2 张）");
  });

  it("rejects multiple product images instead of retaining an old multi-product compatibility path", () => {
    const result = grokReferencePackageFromNodes([
      node("scene", "clean_scene"),
      node("product-side", "product_image"),
      node("model", "outfit_side"),
      node("face", "identity_image", { identityReferenceSourceKind: "face_front" }),
      node("base", "repaired_image"),
      node("product-front", "product_image"),
    ]);

    expect(result.invalid).toContain("商品图只能保留 1 张（当前 2 张）");
  });

  it("rejects a generic identity board instead of silently treating it as a face or model", () => {
    const result = grokReferencePackageFromNodes([
      node("base", "composite_image"),
      node("product", "product_image"),
      node("face", "face_front"),
      node("model", "outfit_front"),
      node("scene", "clean_scene"),
      node("expression", "identity_auxiliary_asset"),
    ]);

    expect(result.error).toContain("只接受");
  });

  it("requires exactly one visual base, face, model, and scene", () => {
    const result = grokReferencePackageFromNodes([
      node("base", "composite_image"),
      node("product", "product_image"),
      node("face", "face_front"),
      node("scene", "clean_scene"),
    ]);

    expect(result.error).toContain("模特图");
  });

  it("builds reference responsibilities from the exact sent node order", () => {
    const references = grokReferencePackageFromNodes([
      node("scene", "clean_scene"),
      node("model", "outfit_front"),
      node("face", "face_front"),
      node("product", "product_image"),
      node("base", "composite_image"),
    ]).package!.ordered;
    const prompt = buildVideoPromptWithReferenceResponsibilities(
      "IMPORTANT:\nFollow the evidenced shot.\n\nSHOT PURPOSE:\nShow the product.",
      references,
    );

    expect(prompt).toContain("Reference Image 1: SHOT BASE");
    expect(prompt).toContain("DIRECTOR SHOT SPECIFICATION:");
    expect(prompt).toContain("IMPORTANT:\nFollow the evidenced shot.");
    expect(prompt).toContain("Reference Image 5: SCENE");
    expect(prompt).toContain("PRODUCT ACTION: touch only evidenced product areas");
    expect(prompt).toContain("Use ordered roles; DIRECTOR controls camera/action/performance/light/timing/transition; roles exclusive.");
    expect(prompt).toContain("DIALOGUE: speak only quoted Mandarin lines.");
    expect(prompt.indexOf("EXECUTION PRIORITY:")).toBeLessThan(prompt.indexOf("DIRECTOR SHOT SPECIFICATION:"));
  });

  it("keeps the director segment budget under Grok's 4,096-character envelope", () => {
    const references = grokReferencePackageFromNodes([
      node("base", "composite_image"),
      node("product", "product_image"),
      node("face", "face_front"),
      node("model", "outfit_front"),
      node("scene", "clean_scene"),
    ]).package!.ordered;

    expect(buildVideoPromptWithReferenceResponsibilities("x".repeat(3_000), references).length).toBeLessThanOrEqual(4_096);
  });

  it("keeps multi-reference labels aligned with the ordered package", () => {
    const packageResult = grokReferencePackageFromNodes([
      node("scene", "clean_scene"),
      node("model", "outfit_front"),
      node("face", "face_front"),
      node("product", "product_image"),
      node("base", "repaired_image"),
    ]);
    const prompt = buildVideoPromptWithReferenceResponsibilities("IMPORTANT:\nTest.", packageResult.package!.ordered);

    expect(prompt).toMatch(/Reference Image 1: SHOT BASE[\s\S]*Reference Image 2: PRODUCT FACTS[\s\S]*Reference Image 3: FACE IDENTITY[\s\S]*Reference Image 4: MODEL\/OUTFIT[\s\S]*Reference Image 5: SCENE/);
  });

  it("keeps a high-density director segment under Grok's final UTF-8 byte limit", () => {
    const references = [
      node("base", "composite_image"),
      node("product", "product_image"),
      node("face", "face_front"),
      node("model", "outfit_front"),
      node("scene", "clean_scene"),
    ];
    const prompt = buildVideoPromptWithReferenceResponsibilities(
      "x".repeat(3_394),
      references,
      "EDIT TIMING LOCK: 0.000-3.000s=S1;3.000-7.000s=S2;7.000-10.000s=S3; cuts 3.000,7.000; keep framing/camera; no extra cuts/zooms/crops/switches; no early S3.",
    );
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(4_096);
  });

  it("lets the visual base own all visible facts for a true single-reference model", () => {
    const prompt = buildVideoPromptWithReferenceResponsibilities(
      "IMPORTANT:\nFollow the evidenced shot.",
      [node("base", "composite_image")],
    );
    expect(prompt).toContain("SHOT BASE: sole visual authority");
    expect(prompt).toContain("Use the one SHOT BASE for all visible facts.");
  });
});
