// Shared, side-effect-free state rules. Reading a legacy row must not write it.
export function productionStatus(payload: {
  jobs: Array<{ kind: string; status: string }>;
  approvedProductMasterAssetId?: string;
  productMasterAssetId?: string;
}) {
  const jobs = payload.jobs;
  if (jobs.some((job) => ["submitting", "running"].includes(job.status))) return "running";
  if (jobs.some((job) => ["waiting", "queued"].includes(job.status))) return "queued";
  if (jobs.some((job) => job.status === "uncertain")) return "uncertain";
  const content = jobs.filter((job) => job.kind !== "product_master");
  if (content.length) {
    if (content.every((job) => job.status === "done")) return "done";
    if (content.some((job) => job.status === "done")) return "partial";
    if (content.some((job) => job.status === "failed")) return "failed";
    return "cancelled";
  }
  if (payload.approvedProductMasterAssetId) return "ready";
  if (payload.productMasterAssetId) return "master_review";
  if (jobs.some((job) => job.status === "failed")) return "failed";
  return "draft";
}

export function isDefiniteSubmissionRejection(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { statusCode?: number; status?: number };
  // A timeout, 5xx, malformed success or lost response is not proof of rejection.
  return [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(Number(value.statusCode ?? value.status));
}

export function resultEmptyMessage(jobs: Array<{ status: string }>, label: string) {
  if (!jobs.length) return `本次没有${label}执行项。`;
  if (jobs.some((job) => ["waiting", "queued", "submitting", "running"].includes(job.status))) return `${label}正在排队或生成，完成后会自动显示。`;
  if (jobs.some((job) => job.status === "uncertain")) return "提交状态待核实，请先到模型平台核对结果。";
  if (jobs.some((job) => job.status === "failed")) return "暂时没有可用结果，请查看失败原因并重试对应项。";
  if (jobs.every((job) => job.status === "cancelled")) return "本批次已停止，未提交模型。可沿用白底图新建一批。";
  return "暂时没有可读取的结果，请刷新或检查结果文件。";
}
