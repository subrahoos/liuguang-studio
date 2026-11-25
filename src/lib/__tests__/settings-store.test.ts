import { describe, expect, it } from "vitest";
import { getReadyImageChannels, getReadyVideoChannels } from "@/lib/stores/settings-store";

const imageSetting = {
  enabled: true,
  apiKey: "",
  imageChannels: [
    {
      id: "managed-image",
      name: "服务端托管生图通道",
      enabled: true,
      apiKey: "",
      baseUrl: "https://example.test/v1",
      model: "gpt-image-2",
    },
    {
      id: "local-image",
      name: "本地 Key 生图通道",
      enabled: true,
      apiKey: "local-key",
      baseUrl: "https://example.test/v1",
      model: "gpt-image-2",
    },
    {
      id: "incomplete-image",
      name: "未完成生图通道",
      enabled: true,
      apiKey: "",
      baseUrl: "https://example.test/v1",
      model: "",
    },
  ],
};

const setting = {
  enabled: true,
  apiKey: "",
  videoChannels: [
    {
      id: "managed",
      name: "服务端托管通道",
      enabled: true,
      apiKey: "",
      baseUrl: "https://example.test/v1",
      model: "sd-2.0-vip",
      taskTypes: ["full_video" as const],
    },
    {
      id: "local",
      name: "本地 Key 通道",
      enabled: true,
      apiKey: "local-key",
      baseUrl: "https://example.test/v1",
      model: "sd-2.0-T",
      taskTypes: ["full_video" as const],
    },
    {
      id: "incomplete",
      name: "未完成通道",
      enabled: true,
      apiKey: "",
      baseUrl: "https://example.test/v1",
      model: "",
      taskTypes: ["full_video" as const],
    },
  ],
};

describe("video channel readiness", () => {
  it("keeps the default browser-key requirement", () => {
    expect(getReadyVideoChannels(setting, "full_video").map((channel) => channel.id)).toEqual(["local"]);
  });

  it("allows the board to use channels whose credential is server-managed", () => {
    expect(
      getReadyVideoChannels(setting, "full_video", { allowServerManagedCredentials: true })
        .map((channel) => channel.id),
    ).toEqual(["managed", "local"]);
  });
});

describe("image channel readiness", () => {
  it("keeps the default browser-key requirement", () => {
    expect(getReadyImageChannels(imageSetting).map((channel) => channel.id)).toEqual(["local-image"]);
  });

  it("allows feature pages to use channels whose credential is server-managed", () => {
    expect(
      getReadyImageChannels(imageSetting, { allowServerManagedCredentials: true })
        .map((channel) => channel.id),
    ).toEqual(["managed-image", "local-image"]);
  });
});
