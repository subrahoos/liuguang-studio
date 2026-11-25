import { describe, expect, it } from "vitest";
import {
  channelSpecificDirectorText,
  directorPromptRequiresAudio,
  REQUIRED_VIDEO_DIRECTOR_HEADINGS,
  VIDEO_DIRECTOR_SCHEMA_VERSION,
  videoDirectorHeadings,
} from "@/lib/video-director-contract";

describe("video director contract", () => {
  it("marks the server-owned editorial timing lock as the current director schema", () => {
    expect(VIDEO_DIRECTOR_SCHEMA_VERSION).toBe(20);
  });

  it("accepts the canonical model-independent heading order", () => {
    const prompt = REQUIRED_VIDEO_DIRECTOR_HEADINGS
      .map((heading) => `${heading}:\nShot-specific instruction.`)
      .join("\n\n");

    expect(videoDirectorHeadings(prompt)).toEqual([...REQUIRED_VIDEO_DIRECTOR_HEADINGS]);
    expect(channelSpecificDirectorText(prompt)).toBe("");
  });

  it.each([
    "VISUAL REFERENCE CONTRACTS: use the later package.",
    "Use one five-image package.",
    "Reference Image 1 controls the frame.",
    "Send image_urls to Grok.",
    "Use multi-reference mode.",
  ])("rejects channel-specific director text: %s", (text) => {
    expect(channelSpecificDirectorText(text)).not.toBe("");
  });

  it("does not confuse the five photographic observations with five images", () => {
    const text = "Preserve the five source-derived photographic observations: camera, viewpoint rationale, environment relationship, light motivation, and air texture.";
    expect(channelSpecificDirectorText(text)).toBe("");
  });

  it("requires audio only when AUDIO AND TEXT contains quoted dialogue", () => {
    expect(directorPromptRequiresAudio([
      "AUDIO AND TEXT:",
      "Speak “这件上衣看这里”.",
      "NEGATIVE CONSTRAINTS:",
      "Do not add dialogue.",
    ].join("\n"))).toBe(true);
    expect(directorPromptRequiresAudio([
      "AUDIO AND TEXT:",
      "No dialogue; retain natural room tone only.",
      "NEGATIVE CONSTRAINTS:",
      "Do not add dialogue.",
    ].join("\n"))).toBe(false);
  });
});
