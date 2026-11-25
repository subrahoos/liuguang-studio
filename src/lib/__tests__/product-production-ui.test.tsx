import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductProductionPage, UploadButton } from "@/components/product-production-page";

describe("production page interaction regression (simulated network only)", () => {
  let root: Root;
  let host: HTMLDivElement;
  let failSave: boolean;
  let offline: boolean;
  let showListTask: boolean;
  const fixture = () => ({
    id: "ui-task", revision: 0, name: "验收任务", status: "ready", updatedAt: new Date().toISOString(), outputDirectory: "unit-only-output",
    payload: { productionMode: "both", assets: [{ id: "master", kind: "product_master", name: "母版", publicUrl: "/unit-master.png", mimeType: "image/png", createdAt: new Date().toISOString() }],
      productSourceAssetIds: [], productMasterAssetId: "master", approvedProductMasterAssetId: "master", productMasterReviewStatus: "approved", videoSources: [], detailAssetIds: [], jobs: [] },
  });
  let task: ReturnType<typeof fixture>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    failSave = false; offline = false; showListTask = false; task = fixture();
    window.history.replaceState(null, "", "/workspace?module=product-production&productionTaskId=ui-task&productionView=setup&productionStep=production");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/channels")) return Response.json({ imageChannels: [], videoChannels: [] });
      if (url === "/api/product-production") return Response.json({ tasks: showListTask ? [{ id: "ui-task", name: task.name, status: task.status, updatedAt: task.updatedAt, plannedVideos: 0, detailImages: 0, completedJobs: 0, failedJobs: 0, runningJobs: 0, totalJobs: 0 }] : [] });
      if (url.endsWith("/ui-task")) {
        if (init?.method === "DELETE") return Response.json({ deletedTaskId: "ui-task" });
        if (init?.method === "PATCH") {
          if (failSave) return Response.json({ error: "模拟保存失败" }, { status: 500 });
          const patch = JSON.parse(String(init.body));
          task = { ...task, name: patch.name || task.name, revision: task.revision + 1 };
          return Response.json({ task });
        }
        if (offline) throw new TypeError("模拟断线");
        return Response.json({ task });
      }
      return Response.json({ error: "任务不存在" }, { status: 404 });
    }));
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function mount() { await act(async () => root.render(<ProductProductionPage />)); }
  async function rename(name: string) {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="任务名称"]')!;
    await act(async () => input.focus());
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.blur());
  }
  function button(label: string) { return [...host.querySelectorAll("button")].find((item) => item.textContent === label)!; }

  it("restores the task and stage from a full-page URL reload", async () => {
    await mount();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="任务名称"]')?.value).toBe("验收任务");
    expect(window.location.search).toContain("productionStep=production");
    expect(window.location.search).toContain("productionView=setup");
    expect(host.textContent).toContain("上传需要处理的原素材");
  });
  it("returns to the list for an inaccessible restored task and clears only production position", async () => {
    window.history.replaceState(null, "", "/workspace?module=product-production&productionTaskId=missing&taskId=unrelated");
    await mount();
    expect(host.querySelector('input[aria-label="任务名称"]')).toBeNull();
    expect(host.textContent).toContain("新建生产");
    expect(window.location.search).not.toContain("productionTaskId");
    expect(window.location.search).toContain("taskId=unrelated");
  });
  it("uses the shared confirmation dialog for task deletion instead of window.confirm", async () => {
    showListTask = true;
    window.history.replaceState(null, "", "/workspace?module=product-production");
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await mount();
    const deleteButton = host.querySelector<HTMLButtonElement>('button[aria-label="删除任务 验收任务"]')!;
    await act(async () => deleteButton.click());
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("删除商品生产任务");
    const deleteRequest = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deleteRequest).toHaveLength(0);
    const cancel = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "取消") as HTMLButtonElement;
    await act(async () => cancel.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
    await act(async () => deleteButton.click());
    const confirm = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "确认删除") as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });
  it("does not restore the production stage past an unapproved white-background master", async () => {
    task.payload.approvedProductMasterAssetId = "";
    task.payload.productMasterReviewStatus = "pending";
    await mount();
    expect(window.location.search).toContain("productionStep=product");
    expect(host.textContent).toContain("白底图验收区");
    expect(host.textContent).not.toContain("上传需要处理的原素材");
  });
  it("opens the white-background inspection as a contained review workspace", async () => {
    window.history.replaceState(null, "", "/workspace?module=product-production&productionTaskId=ui-task&productionView=setup&productionStep=product");
    await mount();
    const inspect = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("放大验收")) as HTMLButtonElement;
    await act(async () => inspect.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("预览比例");
    expect(dialog?.textContent).toContain("待验收白底图");
    expect(dialog?.textContent).toContain("仅查看，不会修改原图");
    const close = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "关闭") as HTMLButtonElement;
    await act(async () => close.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("warns before discarding failed settings and before unloading", async () => {
    await mount(); failSave = true; await rename("尚未保存");
    expect(host.textContent).toContain("保存失败，请重新设置");
    const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => button("全部任务").click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(host.querySelector('input[aria-label="任务名称"]')).not.toBeNull();
    confirm.mockReturnValue(true);
    await act(async () => button("全部任务").click());
    expect(host.querySelector('input[aria-label="任务名称"]')).toBeNull();
    expect(window.location.search).not.toContain("productionTaskId");
  });
  it("shows disconnection even when the last setting was saved successfully", async () => {
    let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((callback) => { poll = callback as () => void; return 1 as unknown as ReturnType<typeof window.setInterval>; });
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});
    await mount(); await rename("已保存名称");
    expect(host.textContent).toContain("已保存");
    offline = true; await act(async () => poll?.());
    expect(host.textContent).toContain("连接中断");
    expect(host.textContent).toContain("已保存");
  });
  it("uses one focusable native upload button and preserves file selection", async () => {
    const onFiles = vi.fn();
    await act(async () => root.render(<UploadButton label="上传测试图片" accept="image/*" multiple onFiles={onFiles} />));
    const trigger = button("上传测试图片");
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, "click").mockImplementation(() => {});
    trigger.focus(); expect(document.activeElement).toBe(trigger);
    trigger.click(); expect(click).toHaveBeenCalledOnce();
    expect(trigger.tabIndex).toBe(0);
    const file = new File(["unit"], "图片.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(onFiles).toHaveBeenCalledWith([file]);
    await act(async () => root.render(<UploadButton label="上传测试图片" accept="image/*" disabled onFiles={onFiles} />));
    trigger.click(); expect(click).toHaveBeenCalledOnce();
  });
});
