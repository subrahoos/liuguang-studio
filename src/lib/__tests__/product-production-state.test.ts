import { describe, it, expect } from "vitest";
import { productionStatus, isDefiniteSubmissionRejection, resultEmptyMessage } from "@/lib/product-production-state";
import { parseByteRange } from "@/lib/http-byte-range";

describe("production status and submission safety", () => {
  it.each(["queued", "submitting", "running"])("preserves an active master during edits: %s", (status) => {
    expect(productionStatus({ jobs: [{ kind: "product_master", status }] })).toBe(status === "queued" ? "queued" : "running");
  });
  it("does not count a completed master as a completed video", () => {
    expect(productionStatus({ approvedProductMasterAssetId: "master", jobs: [{ kind: "product_master", status: "done" }, { kind: "video", status: "cancelled" }] })).toBe("cancelled");
  });
  it("gives unknown submission priority over partial completion", () => {
    expect(productionStatus({ jobs: [{ kind: "video", status: "done" }, { kind: "detail", status: "uncertain" }] })).toBe("uncertain");
  });
  it.each([400, 401, 403, 422, 429])("accepts only a definite HTTP rejection: %s", (statusCode) => {
    expect(isDefiniteSubmissionRejection({ statusCode })).toBe(true);
  });
  it.each([408, 409, 500, 502, 503, 504])("does not assume the upstream rejected an ambiguous response: %s", (statusCode) => {
    expect(isDefiniteSubmissionRejection({ statusCode })).toBe(false);
  });
  it("does not assume network loss or malformed success is rejection", () => {
    expect(isDefiniteSubmissionRejection(new TypeError("fetch failed"))).toBe(false);
    expect(isDefiniteSubmissionRejection({ code: "NO_TASK_ID" })).toBe(false);
  });
  it("never describes cancelled or failed jobs as queued", () => {
    expect(resultEmptyMessage([{ status: "cancelled" }], "视频")).toContain("已停止");
    expect(resultEmptyMessage([{ status: "failed" }], "视频")).toContain("失败原因");
    expect(resultEmptyMessage([{ status: "uncertain" }], "视频")).toContain("待核实");
  });
});

describe("authenticated video byte ranges", () => {
  it.each([
    ["bytes=0-9", { start: 0, end: 9 }],
    ["bytes=90-", { start: 90, end: 99 }],
    ["bytes=-20", { start: 80, end: 99 }],
    ["bytes=95-1000", { start: 95, end: 99 }],
  ])("supports %s", (value, result) => expect(parseByteRange(value as string, 100)).toEqual(result));
  it.each(["bytes=100-", "bytes=5-2", "bytes=-0", "bytes=0-2,5-9", "bytes=-", "items=0-5"])("rejects %s", (value) => expect(parseByteRange(value, 100)).toBe("invalid"));
  it("handles an absent range and empty file", () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange("bytes=0-1", 0)).toBe("invalid");
  });
});
