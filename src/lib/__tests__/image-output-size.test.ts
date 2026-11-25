import { describe, expect, it } from "vitest";
import { aspectRatioFromDimensions, imageDimensionsForPreset } from "@/lib/image-output-size";

describe("image output sizes", () => {
  it("keeps a 3:4 portrait at the requested 4K dimensions instead of falling back to 9:16", () => {
    expect(imageDimensionsForPreset("3:4", "4k")).toEqual({ width: 2160, height: 2880 });
    expect(aspectRatioFromDimensions(2160, 2880)).toBe("3:4");
  });

  it("keeps existing 9:16 output dimensions unchanged", () => {
    expect(imageDimensionsForPreset("9:16", "4k")).toEqual({ width: 2160, height: 3840 });
    expect(aspectRatioFromDimensions(2160, 3840)).toBe("9:16");
  });
});
