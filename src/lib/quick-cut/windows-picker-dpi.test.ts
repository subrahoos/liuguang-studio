import { describe, expect, it } from "vitest";
import { windowsPickerDpiSource } from "@/lib/quick-cut/windows-picker-dpi";

describe("Windows 原生选择器 DPI 启动", () => {
  it("优先启用每显示器 V2，并保留旧系统回退", () => {
    expect(windowsPickerDpiSource).toContain("SetProcessDpiAwarenessContext");
    expect(windowsPickerDpiSource).toContain("new IntPtr(-4)");
    expect(windowsPickerDpiSource).toContain("SetProcessDpiAwareness(ProcessPerMonitorDpiAware)");
    expect(windowsPickerDpiSource).toContain("SetProcessDPIAware()");
  });
});
