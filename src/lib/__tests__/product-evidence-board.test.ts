import { describe, expect, it } from "vitest";
import {
  buildProductEvidenceBoardFilter,
  prepareProductEvidencePanels,
  productEvidenceViewFor,
} from "@/lib/product-evidence-board";

describe("product evidence board", () => {
  it("classifies and orders explicitly labelled product views for the storyboard", () => {
    const panels = prepareProductEvidencePanels([
      { inputPath: "D:\\tmp\\coat-back.png", title: "商品背面图" },
      { inputPath: "D:\\tmp\\coat-side.png", description: "商品侧面结构图" },
      { inputPath: "D:\\tmp\\coat-front.png", title: "商品正面图" },
    ]);

    expect(panels.map((panel) => panel.view)).toEqual(["front", "back", "side"]);
    expect(panels.map((panel) => panel.label)).toEqual(["正面 / FRONT", "背面 / BACK", "侧面 / SIDE"]);
  });

  it("does not invent a front or back label when the supplied labels conflict or are absent", () => {
    expect(productEvidenceViewFor({ inputPath: "D:\\tmp\\product.png", title: "商品正面和背面拼图" })).toBe("unconfirmed");
    expect(productEvidenceViewFor({ inputPath: "D:\\tmp\\product.png", title: "商品结构图" })).toBe("unconfirmed");
    expect(prepareProductEvidencePanels([
      { inputPath: "D:\\tmp\\product.png", title: "商品结构图" },
      { inputPath: "D:\\tmp\\back.png", title: "商品背面图" },
    ])[1].label).toBe("视角待确认 / VIEW UNCONFIRMED");
  });

  it("burns the ordered view headers into a dedicated title strip for every panel", () => {
    const panels = prepareProductEvidencePanels([
      { inputPath: "D:\\tmp\\front.png", title: "商品正面图" },
      { inputPath: "D:\\tmp\\back.png", title: "商品背面图" },
    ]);
    const filter = buildProductEvidenceBoardFilter(panels, "C:\\Windows\\Fonts\\msyh.ttc");

    expect(filter).toContain("drawbox=x=0:y=0:w=720:h=104:color=0x111827:t=fill");
    expect(filter).toContain("text='01 正面 / FRONT'");
    expect(filter).toContain("text='02 背面 / BACK'");
    expect(filter).toContain("fontfile='C\\:/Windows/Fonts/msyh.ttc'");
    expect(filter).not.toMatch(/,\[p\d+\]/);
    expect(filter).toContain("[p0];[1:v]");
  });
});
