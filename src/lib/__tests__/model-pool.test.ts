import { describe, expect, it } from "vitest";
import { videoChannelConfigForSave } from "@/lib/model-pool";
import type { VideoModelChannel } from "@/lib/stores/settings-store";

const oldBrowserVideoChannel: VideoModelChannel = {
  id: "rjm-video",
  name: "rjm-video",
  enabled: true,
  apiKey: "",
  baseUrl: "https://video.rjm.us.ci/v1",
  model: "video-ds-2.0",
  taskTypes: ["shot_clip", "full_video"],
  submitPath: "/videos",
  statusPath: "/videos/{id}",
  contentPath: "/videos/{id}/content",
  durationOptions: [15],
  maxReferenceImages: 4,
  maxReferenceVideos: 3,
  maxReferenceAudios: 1,
  directVideoReplacementPromptLanguage: "en",
};

describe("video model-pool config persistence", () => {
  it("keeps a saved direct-video image contract when an old browser draft lacks those fields", () => {
    const config = videoChannelConfigForSave(oldBrowserVideoChannel, {
      directVideoReplacementPromptLanguage: "en",
      directVideoReplacementSceneOptional: true,
      directVideoReplacementFaceOptional: true,
      directVideoReplacementReferenceContract: "product_front_face",
      directVideoReplacementPromptVersion: "v2",
    });

    expect(config).toMatchObject({
      directVideoReplacementPromptLanguage: "en",
      directVideoReplacementSceneOptional: true,
      directVideoReplacementFaceOptional: true,
      directVideoReplacementReferenceContract: "product_front_face",
      directVideoReplacementPromptVersion: "v2",
    });
  });

  it("accepts an explicit saved-contract change from a current browser draft", () => {
    const config = videoChannelConfigForSave({
      ...oldBrowserVideoChannel,
      directVideoReplacementSceneOptional: false,
      directVideoReplacementFaceOptional: false,
      directVideoReplacementReferenceContract: "product_board_face_model",
      directVideoReplacementPromptVersion: "v1",
    }, {
      directVideoReplacementSceneOptional: true,
      directVideoReplacementFaceOptional: true,
      directVideoReplacementReferenceContract: "product_front_face",
    });

    expect(config).toMatchObject({
      directVideoReplacementSceneOptional: false,
      directVideoReplacementFaceOptional: false,
      directVideoReplacementReferenceContract: "product_board_face_model",
      directVideoReplacementPromptVersion: "v1",
    });
  });

  it("defaults legacy channels to V1 and preserves an explicit V2 rollback target", () => {
    expect(videoChannelConfigForSave(oldBrowserVideoChannel)).toMatchObject({
      directVideoReplacementPromptVersion: "v1",
    });
    expect(videoChannelConfigForSave({
      ...oldBrowserVideoChannel,
      directVideoReplacementPromptVersion: "v2",
    })).toMatchObject({
      directVideoReplacementPromptVersion: "v2",
    });
  });
});
