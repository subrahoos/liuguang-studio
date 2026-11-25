import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runPlannedJobs } = require("./job-runner") as typeof import("./job-runner");

describe("quick-cut job progress ordering", () => {
  it("persists render progress before completion and batch-finished events", async () => {
    const events: string[] = [];
    const result = await runPlannedJobs({
      plans: [{ id: "mix-001", totalDuration: 1, units: [] }],
      render: async (_plan: unknown, context: { onProgress: (value: number) => void }) => {
        context.onProgress(0.5);
        return { output: "result.mp4" };
      },
      onProgress: async (event: { type: string }) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        events.push(event.type);
      },
    });

    expect(result).toMatchObject({ completed: 1, failed: 0, pending: 0 });
    expect(events).toEqual(["job-started", "job-progress", "job-completed", "batch-finished"]);
  });
});
