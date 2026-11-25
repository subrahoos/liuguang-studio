import { describe, expect, it } from "vitest";
import os from "os";
import path from "path";
import { assertExternalQuickCutOutputFolder, isPathWithin } from "@/lib/quick-cut/output-path";

describe("流光快剪输出目录边界", () => {
  const root = path.join(os.tmpdir(), "luma-quick-cut", "owner", "task");

  it("识别任务目录本身和其子目录", () => {
    expect(isPathWithin(root, root)).toBe(true);
    expect(isPathWithin(root, path.join(root, "output"))).toBe(true);
    expect(isPathWithin(root, path.join(root, "work", "delivery"))).toBe(true);
  });

  it("允许任务目录之外的正式输出位置", () => {
    expect(isPathWithin(root, path.join(os.tmpdir(), "luma-exports"))).toBe(false);
    expect(() => assertExternalQuickCutOutputFolder(root, path.join(os.tmpdir(), "luma-exports"))).not.toThrow();
  });

  it("拒绝把内部任务目录当作正式输出位置", () => {
    expect(() => assertExternalQuickCutOutputFolder(root, root)).toThrow("任务目录之外");
    expect(() => assertExternalQuickCutOutputFolder(root, path.join(root, "output"))).toThrow("任务目录之外");
  });
});
