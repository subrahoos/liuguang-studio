/**
 * @typedef {{ type: string, index?: number, total?: number, planId?: string, value?: number, error?: string }} ProgressEvent
 * @typedef {{ plans: Array<any>, render: (plan: any, context: { signal?: AbortSignal, onProgress: (value: number) => void }) => Promise<any>, signal?: AbortSignal, retryFailedOnly?: boolean, onProgress?: (event: ProgressEvent) => Promise<void> | void, onRow?: (row: any, rows: Array<any>) => Promise<void> | void }} RunPlannedJobsOptions
 * @typedef {{ completed: number, failed: number, pending: number, stopped: boolean, rows: Array<any> }} RunPlannedJobsResult
 */

/**
 * @param {RunPlannedJobsOptions} options
 * @returns {Promise<RunPlannedJobsResult>}
 */
async function runPlannedJobs({
  plans,
  render,
  signal,
  retryFailedOnly = false,
  onProgress = () => {},
  onRow = async () => {},
}) {
  const eligible = retryFailedOnly
    ? plans.filter((plan) => plan.status === "failed")
    : plans.filter((plan) => plan.status !== "done");
  const rows = [];
  let completed = 0;
  let failed = 0;
  let progressQueue = Promise.resolve();
  const notifyProgress = (progressEvent) => {
    progressQueue = progressQueue.then(() => onProgress(progressEvent));
    return progressQueue;
  };

  for (let index = 0; index < eligible.length; index += 1) {
    if (signal?.aborted) break;
    const plan = eligible[index];
    await notifyProgress({
      type: "job-started",
      index,
      total: eligible.length,
      planId: plan.id,
    });

    try {
      const rendered = await render(plan, {
        signal,
          onProgress: (value) => notifyProgress({
            type: "job-progress",
          index,
          total: eligible.length,
          planId: plan.id,
          value,
        }),
      });
      await progressQueue;
      completed += 1;
      const row = {
        ...rendered,
        planId: plan.id,
        sources: plan.units?.map((unit) => unit.videoPath)
          || plan.segments?.map((segment) => segment.path)
          || [],
        diversityLevel: plan.diversityLevel || "",
        segments: plan.units || plan.segments || [],
        duration: plan.totalDuration,
        status: "done",
        error: "",
      };
      rows.push(row);
      await onRow(row, rows);
      await notifyProgress({
        type: "job-completed",
        index,
        total: eligible.length,
        planId: plan.id,
      });
    } catch (error) {
      await progressQueue.catch(() => undefined);
      if (signal?.aborted) break;
      failed += 1;
      const row = {
        planId: plan.id,
        output: "",
        sources: plan.units?.map((unit) => unit.videoPath)
          || plan.segments?.map((segment) => segment.path)
          || [],
        diversityLevel: plan.diversityLevel || "",
        segments: plan.units || plan.segments || [],
        duration: plan.totalDuration,
        status: "failed",
        error: error.message || "处理失败",
      };
      rows.push(row);
      await onRow(row, rows);
      await notifyProgress({
        type: "job-failed",
        index,
        total: eligible.length,
        planId: plan.id,
        error: row.error,
      });
    }
  }

  const processed = completed + failed;
  const pending = eligible.length - processed;
  const result = {
    completed,
    failed,
    pending,
    stopped: Boolean(signal?.aborted),
    rows,
  };
  await notifyProgress({ type: "batch-finished", ...result });
  return result;
}

module.exports = { runPlannedJobs };
