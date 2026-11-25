import { describe, expect, it } from "vitest";

import { isLingganyaTemporaryFileReferenceChannel } from "@/lib/video-reference-transport";

const lingganyaChannel = (model: string) => ({
  id: `lgy-${model}`,
  baseUrl: "https://www.lingganyaapi.com/v1",
  apiKey: "test-key",
  model,
  submitPath: "/videos",
  statusPath: "/videos/{id}",
  contentPath: "/videos/{id}/content",
  durationOptions: [15],
  maxReferenceImages: 9,
  maxReferenceVideos: 3,
  maxReferenceAudios: 3,
});

describe("video reference transport selection", () => {
  it("uses Lingganya temporary file ids for the exact sd-2.0-g channel", () => {
    expect(isLingganyaTemporaryFileReferenceChannel(lingganyaChannel("sd-2.0-g"))).toBe(true);
  });

  it("keeps sd-2.0-vip on its existing Lingganya temporary file transport", () => {
    expect(isLingganyaTemporaryFileReferenceChannel(lingganyaChannel("sd-2.0-vip"))).toBe(true);
  });

  it("uses Lingganya temporary file ids for the exact sd-2.0-mini channel", () => {
    expect(isLingganyaTemporaryFileReferenceChannel(lingganyaChannel("sd-2.0-mini"))).toBe(true);
  });

  it("does not opt sibling Lingganya models into temporary file transport", () => {
    expect(isLingganyaTemporaryFileReferenceChannel(lingganyaChannel("sd-2.0-T"))).toBe(false);
  });
});
