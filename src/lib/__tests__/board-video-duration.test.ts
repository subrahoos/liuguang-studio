import { describe, expect, it } from "vitest";
import {
  formatBoardVideoDurationOptions,
  getBoardVideoProfile,
  normalizeBoardVideoMaxReferenceAudios,
  parseBoardVideoDurationOptions,
} from "@/lib/board-video-protocol";
import {
  referenceEvidenceDurationForAnalysis,
  referenceTargetDurationSeconds,
} from "@/lib/board-video-duration";

describe("board video duration planning", () => {
  it("accepts ranges and discrete duration options, then chooses the maximum option", () => {
    expect(parseBoardVideoDurationOptions("4-6, 10 12")).toEqual([4, 5, 6, 10, 12]);
    expect(formatBoardVideoDurationOptions([4, 5, 6, 10])).toBe("4,5,6,10");
    const profile = getBoardVideoProfile({ id: "rjm", model: "grok-imagine-video-1.5", durationOptions: [6, 10] });
    expect(profile?.generationSeconds).toBe(10);
    expect(profile?.durationOptions).toEqual([6, 10]);
    expect(profile?.maxReferenceImages).toBe(1);
  });

  it("keeps the channel-declared reference-image ceiling separate from the workflow package", () => {
    const profile = getBoardVideoProfile({
      id: "lingganya",
      model: "sd-2.0",
      durationOptions: [4, 15],
      maxReferenceImages: 9,
    });
    expect(profile?.maxReferenceImages).toBe(9);
    expect(profile?.referenceImageCount).toBe(5);
  });

  it("recognizes the live LGY sd-2.0-T identifier and only enables direct replacement for its own declared contract", () => {
    const directLgy = getBoardVideoProfile({
      id: "lgy-sd-multimedia",
      model: "sd-2.0-T",
      durationOptions: [15],
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 4,
      maxReferenceVideos: 1,
      maxReferenceAudios: 1,
      directVideoReplacementSceneOptional: true,
    });
    const imageOnlyLgy = getBoardVideoProfile({
      id: "lgy-image-only",
      model: "sd-2.0-T",
      durationOptions: [15],
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 4,
      maxReferenceVideos: 0,
      maxReferenceAudios: 1,
    });

    expect(directLgy).toMatchObject({
      protocol: "lingganya",
      resolution: "1080p",
      directVideoReplacement: true,
      directVideoReplacementSceneOptional: true,
      maxReferenceImages: 4,
      maxReferenceVideos: 1,
      maxReferenceAudios: 1,
    });
    expect(imageOnlyLgy?.directVideoReplacement).toBe(false);
    expect(directLgy?.capabilitySignature).not.toBe(imageOnlyLgy?.capabilitySignature);
    expect(normalizeBoardVideoMaxReferenceAudios(3)).toBe(3);
  });

  it("keeps an English product-front direct contract isolated for the rjm video-ds channel", () => {
    const profile = getBoardVideoProfile({
      id: "rjm-video-ds-product-front",
      baseUrl: "https://video.rjm.us.ci/v1",
      model: "video-ds-2.0",
      durationOptions: [15],
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 4,
      maxReferenceVideos: 3,
      maxReferenceAudios: 1,
      directVideoReplacementPromptLanguage: "en",
      directVideoReplacementSceneOptional: true,
      directVideoReplacementReferenceContract: "product_front_face",
    });

    expect(profile).toMatchObject({
      protocol: "rjmus_multimedia",
      directVideoReplacement: true,
      directVideoReplacementPromptLanguage: "en",
      directVideoReplacementSceneOptional: true,
      directVideoReplacementReferenceContract: "product_front_face",
    });
    expect(profile?.capabilitySignature).toContain("product-front-face-en-v1");
  });

  it("assigns the hard face-reference prompt revision only to the exact MKOSOR channel contract", () => {
    const profile = getBoardVideoProfile({
      id: "mkosor-sora",
      baseUrl: "https://api.mikoto.vip/v1",
      model: "sora-v3-pro",
      videoProtocol: "mikoto_sora",
      durationOptions: [10],
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 4,
      maxReferenceVideos: 1,
      maxReferenceAudios: 1,
      directVideoReplacementPromptLanguage: "en",
      directVideoReplacementSceneOptional: true,
      directVideoReplacementReferenceContract: "product_front_face",
    });

    expect(profile?.protocol).toBe("mikoto_sora");
    expect(profile?.capabilitySignature).toContain("product-front-face-en-mikoto-face-hard-lock-v1");
  });

  it("uses a saved Lingganya channel's exact model name instead of a model-name allowlist", () => {
    const profile = getBoardVideoProfile({
      id: "lgy-sd-vip",
      baseUrl: "https://www.lingganyaapi.com/v1",
      model: "sd-2.0-vip",
      durationOptions: [15],
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 4,
      maxReferenceVideos: 1,
      maxReferenceAudios: 1,
    });

    expect(profile).toMatchObject({
      model: "sd-2.0-vip",
      protocol: "lingganya",
      durationOptions: [15],
      generationSeconds: 15,
      resolution: "720p",
      resolutionOptions: ["720p", "1080p"],
      directVideoReplacement: true,
      directVideoReplacementPromptLanguage: "en",
      maxReferenceImages: 4,
      maxReferenceVideos: 1,
      maxReferenceAudios: 1,
    });
    expect(profile?.capabilitySignature).toContain("sd-2.0-vip");
    expect(profile?.capabilitySignature).toContain("explicit-media-binding-v2-no-generate-audio");
    const chinesePromptChannel = getBoardVideoProfile({
      id: "lgy-sd-vip",
      baseUrl: "https://www.lingganyaapi.com/v1",
      model: "sd-2.0-vip",
      durationOptions: [15],
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 4,
      maxReferenceVideos: 1,
      maxReferenceAudios: 1,
      directVideoReplacementPromptLanguage: "zh-CN",
    });
    expect(chinesePromptChannel?.directVideoReplacementPromptLanguage).toBe("zh-CN");
    expect(chinesePromptChannel?.capabilitySignature).not.toBe(profile?.capabilitySignature);
    const productFrontChannel = getBoardVideoProfile({
      id: "lgy-sd-vip-product-front",
      baseUrl: "https://www.lingganyaapi.com/v1",
      model: "sd-2.0-vip",
      durationOptions: [15],
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 4,
      maxReferenceVideos: 1,
      directVideoReplacementSceneOptional: true,
      directVideoReplacementFaceOptional: true,
      directVideoReplacementPromptLanguage: "zh-CN",
      directVideoReplacementReferenceContract: "product_front_face",
    });
    expect(productFrontChannel?.directVideoReplacementReferenceContract).toBe("product_front_face");
    expect(productFrontChannel?.directVideoReplacementFaceOptional).toBe(true);
    expect(productFrontChannel?.capabilitySignature).toContain("platform-overlay-v1");
    expect(productFrontChannel?.capabilitySignature).toContain("reference-video-face-v1");
    expect(productFrontChannel?.capabilitySignature).not.toBe(profile?.capabilitySignature);
    const v2Channel = getBoardVideoProfile({
      id: "lgy-sd-vip-v2",
      baseUrl: "https://www.lingganyaapi.com/v1",
      model: "sd-2.0-vip",
      durationOptions: [15],
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 4,
      maxReferenceVideos: 1,
      maxReferenceAudios: 1,
      directVideoReplacementPromptLanguage: "zh-CN",
      directVideoReplacementSceneOptional: true,
      directVideoReplacementFaceOptional: true,
      directVideoReplacementReferenceContract: "product_front_face",
      directVideoReplacementPromptVersion: "v2",
    });
    expect(v2Channel?.directVideoReplacementPromptVersion).toBe("v2");
    expect(v2Channel?.capabilitySignature).toContain(":v2:");
    expect(v2Channel?.capabilitySignature).not.toBe(productFrontChannel?.capabilitySignature);
    const selected1080p = getBoardVideoProfile({
      id: "lgy-sd-vip",
      baseUrl: "https://www.lingganyaapi.com/v1",
      model: "sd-2.0-vip",
      resolution: "1080p",
      durationOptions: [15],
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 4,
      maxReferenceVideos: 1,
      maxReferenceAudios: 1,
    });
    expect(selected1080p?.resolution).toBe("1080p");
    expect(selected1080p?.capabilitySignature).not.toBe(profile?.capabilitySignature);
  });

  it("declares the official sd-2.0-g edit capabilities on the saved channel", () => {
    const profile = getBoardVideoProfile({
      id: "lgy-sd2.0-g",
      baseUrl: "https://www.lingganyaapi.com/v1",
      model: "sd-2.0-g",
      durationOptions: Array.from({ length: 12 }, (_, index) => index + 4),
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 9,
      maxReferenceVideos: 3,
      maxReferenceAudios: 3,
      directVideoReplacementPromptLanguage: "zh-CN",
      directVideoReplacementSceneOptional: true,
      directVideoReplacementFaceOptional: true,
      directVideoReplacementReferenceContract: "product_front_face",
      directVideoReplacementPromptVersion: "v2",
    });

    expect(profile).toMatchObject({
      model: "sd-2.0-g",
      protocol: "lingganya",
      durationOptions: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      generationSeconds: 15,
      resolution: "720p",
      maxReferenceImages: 9,
      maxReferenceVideos: 3,
      maxReferenceAudios: 3,
      directVideoReplacement: true,
      directVideoReplacementPromptLanguage: "zh-CN",
      directVideoReplacementSceneOptional: true,
      directVideoReplacementFaceOptional: true,
      directVideoReplacementReferenceContract: "product_front_face",
      directVideoReplacementPromptVersion: "v2",
    });
    expect(profile?.capabilitySignature).toContain("sd20g-edit-v1-top-level-media-duration-ratio");
  });

  it("declares the official fixed-720p sd-2.0-mini capabilities", () => {
    const profile = getBoardVideoProfile({
      id: "lgy-sd2.0-mini",
      baseUrl: "https://www.lingganyaapi.com/v1",
      model: "sd-2.0-mini",
      durationOptions: Array.from({ length: 11 }, (_, index) => index + 5),
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 6,
      maxReferenceVideos: 3,
      maxReferenceAudios: 3,
      directVideoReplacementPromptLanguage: "zh-CN",
      directVideoReplacementSceneOptional: true,
      directVideoReplacementFaceOptional: true,
      directVideoReplacementReferenceContract: "product_front_face",
      directVideoReplacementPromptVersion: "v1",
    });

    expect(profile).toMatchObject({
      model: "sd-2.0-mini",
      protocol: "lingganya",
      durationOptions: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      resolutionOptions: ["720p"],
      resolution: "720p",
      maxReferenceImages: 6,
      maxReferenceVideos: 3,
      maxReferenceAudios: 3,
      directVideoReplacement: true,
      directVideoReplacementReferenceContract: "product_front_face",
      directVideoReplacementPromptVersion: "v1",
    });
    expect(profile?.capabilitySignature).toContain("sd20mini-unified-v1-seconds-size-extra-media");
  });

  it("keeps media-reference capabilities isolated per channel, even for the same model", () => {
    const standardChannel = getBoardVideoProfile({
      id: "rjm-standard",
      model: "video-ds-2.0",
      durationOptions: [15],
      maxReferenceImages: 4,
      maxReferenceVideos: 3,
      maxReferenceAudios: 1,
    });
    const imageOnlyChannel = getBoardVideoProfile({
      id: "rjm-image-only",
      model: "video-ds-2.0",
      durationOptions: [15],
      maxReferenceImages: 1,
      maxReferenceVideos: 0,
      maxReferenceAudios: 0,
    });

    expect(standardChannel).toMatchObject({
      maxReferenceImages: 4,
      maxReferenceVideos: 3,
      maxReferenceAudios: 1,
    });
    expect(imageOnlyChannel).toMatchObject({
      maxReferenceImages: 1,
      maxReferenceVideos: 0,
      maxReferenceAudios: 0,
    });
    expect(standardChannel?.capabilitySignature).not.toBe(imageOnlyChannel?.capabilitySignature);
  });

  it("activates rjm multimedia only for the channel that declares its endpoint contract", () => {
    const legacy = getBoardVideoProfile({
      id: "legacy-video-ds",
      model: "video-ds-2.0",
      durationOptions: [15],
      submitPath: "/videos/generations",
      statusPath: "/videos/tasks/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 1,
      maxReferenceVideos: 0,
      maxReferenceAudios: 0,
    });
    const multimedia = getBoardVideoProfile({
      id: "rim-sd-multimedia",
      model: "video-ds-2.0",
      durationOptions: [15],
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 4,
      maxReferenceVideos: 3,
      maxReferenceAudios: 1,
    });

    expect(legacy?.protocol).toBe("jimeng");
    expect(multimedia).toMatchObject({
      protocol: "rjmus_multimedia",
      referenceField: "images",
      directVideoReplacement: true,
      maxReferenceImages: 4,
      maxReferenceVideos: 3,
      maxReferenceAudios: 1,
    });
    expect(legacy?.capabilitySignature).not.toBe(multimedia?.capabilitySignature);
  });

  it("does not enable direct replacement when a multimedia channel lacks either required medium", () => {
    const noVideo = getBoardVideoProfile({
      id: "media-images-only",
      model: "video-ds-2.0",
      durationOptions: [15],
      submitPath: "/videos",
      statusPath: "/videos/{id}",
      contentPath: "/videos/{id}/content",
      maxReferenceImages: 4,
      maxReferenceVideos: 0,
      maxReferenceAudios: 1,
    });
    expect(noVideo?.protocol).toBe("rjmus_multimedia");
    expect(noVideo?.directVideoReplacement).toBe(false);
  });

  it("recognizes the current rjm Grok multi-reference model", () => {
    const profile = getBoardVideoProfile({
      id: "rjm-grok",
      model: "grok-imagine-video",
      durationOptions: [10],
      maxReferenceImages: 7,
    });
    expect(profile).toMatchObject({
      referenceField: "image_urls",
      referenceImageCount: 5,
      maxReferenceImages: 7,
      generationSeconds: 10,
    });
  });

  it("does not silently use a default when a known channel explicitly clears its durations", () => {
    expect(getBoardVideoProfile({ id: "rjm", model: "grok-imagine-video-1.5", durationOptions: [] })).toBeNull();
  });

  it("uses the analysis-linked storyboard evidence duration and rounds it upward", () => {
    const storyboard = {
      id: "storyboard-1",
      kind: "storyboard" as const,
      title: "故事板",
      createdAt: "2026-01-01T00:00:00.000Z",
      x: 0,
      y: 0,
      meta: { evidenceDurationSeconds: 21.3 },
    };
    const analysis = {
      id: "analysis-1",
      kind: "analysis" as const,
      title: "拆解",
      createdAt: "2026-01-01T00:00:00.000Z",
      x: 0,
      y: 0,
      meta: { storyboardNodeId: storyboard.id },
    };
    expect(referenceEvidenceDurationForAnalysis([storyboard, analysis], analysis)).toBe(21.3);
    expect(referenceTargetDurationSeconds(21.3)).toBe(22);
  });
});
