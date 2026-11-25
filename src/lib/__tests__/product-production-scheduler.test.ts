import { describe, expect, it, vi } from "vitest";
import { createBoundedOwnerScheduler } from "@/lib/product-production-scheduler";

describe("product production account scheduler", () => {
  it("runs at most two jobs per account and never dispatches the same job twice", async () => {
    const queued = new Map([
      ["owner-a", ["a1", "a2", "a3"]],
      ["owner-b", ["b1", "b2", "b3"]],
    ]);
    const running = new Map<string, Set<string>>();
    const releases = new Map<string, () => void>();
    const executions: string[] = [];
    const scheduler = createBoundedOwnerScheduler(
      2,
      async (ownerId, activeJobIds) => {
        const id = queued.get(ownerId)?.find((item) => !activeJobIds.has(item));
        return id ? { id } : null;
      },
      async (ownerId, job) => {
        const ownerRunning = running.get(ownerId) || new Set<string>();
        running.set(ownerId, ownerRunning);
        ownerRunning.add(job.id);
        executions.push(job.id);
        expect(ownerRunning.size).toBeLessThanOrEqual(2);
        await new Promise<void>((resolve) => releases.set(job.id, resolve));
        ownerRunning.delete(job.id);
        queued.set(ownerId, queued.get(ownerId)!.filter((item) => item !== job.id));
      },
    );

    scheduler.wake("owner-a");
    scheduler.wake("owner-a");
    scheduler.wake("owner-b");
    await vi.waitFor(() => expect(executions).toHaveLength(4));
    expect(executions).toEqual(["a1", "b1", "a2", "b2"]);
    scheduler.wake("owner-a");
    scheduler.wake("owner-b");
    expect(executions).toHaveLength(4);

    releases.get("a1")!();
    await vi.waitFor(() => expect(executions).toContain("a3"));
    expect(executions.filter((id) => id === "a2")).toHaveLength(1);
    expect(executions).not.toContain("b3");
    releases.get("b1")!();
    await vi.waitFor(() => expect(executions).toContain("b3"));
    for (const id of ["a2", "a3", "b2", "b3"]) releases.get(id)!();
    await vi.waitFor(() => expect([...running.values()].every((jobs) => jobs.size === 0)).toBe(true));
    expect(new Set(executions).size).toBe(6);
  });
});
