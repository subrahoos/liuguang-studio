import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteBoardImagePendingResult,
  getBoardImagePendingResult,
  listBoardImagePendingResults,
  saveBoardImagePendingResult,
  updateBoardImagePendingResult,
} from "@/lib/board-image-results";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("board image pending result recovery", () => {
  it("preserves the upstream payload while exposing only a safe summary to the board UI", async () => {
    const localDir = await mkdtemp(join(tmpdir(), "luma-board-image-result-"));
    temporaryDirectories.push(localDir);
    const pending = await saveBoardImagePendingResult(localDir, {
      workflowId: "workflow-1",
      ownerId: "user-1",
      executorNodeId: "image-node-1",
      role: "outfit_front",
      title: "全身穿搭正面白底图",
      description: "单张画板图片资产。",
      promptEnglish: "Create one full body outfit image.",
      referenceNodeIds: ["product-1", "face-1"],
      provider: "openai-seedance",
      model: "gpt-image-2",
      taskId: "task-1",
      transport: "b64_json",
      payload: "data:image/png;base64,AAAA",
      requestedWidth: 2160,
      requestedHeight: 3840,
      x: 420,
      y: 900,
      generationTiming: { upstreamProcessingMs: 1200, resultTransferMs: 3400, totalMs: 4600 },
    });

    expect((await getBoardImagePendingResult(localDir, pending.id))?.payload).toBe("data:image/png;base64,AAAA");
    const summaries = await listBoardImagePendingResults(localDir);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: pending.id, transport: "b64_json", title: "全身穿搭正面白底图" });
    expect("payload" in summaries[0]).toBe(false);

    await updateBoardImagePendingResult(localDir, pending.id, {
      filePath: join(localDir, "board-image-outfit.png"),
      fileExtension: "png",
      generationTiming: { upstreamProcessingMs: 1200, resultTransferMs: 3400, localSaveMs: 22, totalMs: 4600 },
    });
    const recovered = await getBoardImagePendingResult(localDir, pending.id);
    expect(recovered).toMatchObject({ fileExtension: "png", generationTiming: { localSaveMs: 22 } });

    await deleteBoardImagePendingResult(localDir, pending.id);
    expect(await getBoardImagePendingResult(localDir, pending.id)).toBeNull();
  });
});
