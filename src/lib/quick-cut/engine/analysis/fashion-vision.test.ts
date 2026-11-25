import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runFashionVisionAnalysis } = require("./fashion-vision") as typeof import("./fashion-vision");

const folders: string[] = [];
type FashionVisionInput = Parameters<typeof runFashionVisionAnalysis>[0];
type FashionVisionRunner = NonNullable<FashionVisionInput["runner"]>;
type RunnerOptions = { onStdout?: (chunk: string) => void };

async function runtimeFolder() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "luma-fashion-vision-"));
  folders.push(folder);
  const pythonPath = path.join(folder, "python.exe");
  const scriptPath = path.join(folder, "fashion_vision_analyzer.py");
  const modelRoot = path.join(folder, "models");
  await mkdir(modelRoot, { recursive: true });
  await Promise.all([
    writeFile(pythonPath, "placeholder"),
    writeFile(scriptPath, "placeholder"),
    writeFile(path.join(modelRoot, "READY.json"), "{}", { encoding: "utf8" }),
  ]);
  return { folder, pythonPath, scriptPath, modelRoot };
}

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("fashion vision execution evidence", () => {
  it("records FashionCLIP and MMPose execution evidence and merges pose metrics into shots", async () => {
    const runtime = await runtimeFolder();
    const events: string[] = [];
    const runner = (async (_command: unknown, args: unknown, options?: RunnerOptions) => {
      const commandArgs = args as string[];
      options?.onStdout?.('LUMA_FASHION_MODEL:{"device":"cpu","fashionclip":{"loaded":true,"rolePromptCount":7},"mmpose":{"loaded":true}}\n');
      options?.onStdout?.("LUMA_FASHION_PROGRESS:1:1\n");
      const outputPath = commandArgs[commandArgs.indexOf("--output") + 1];
      await writeFile(outputPath, JSON.stringify({
        modelUsage: {
          device: "cpu",
          fashionclip: { loaded: true, rolePromptCount: 7 },
          mmpose: { loaded: true, poseCandidateCount: 1, fullBodyCount: 1, motionCandidateCount: 1 },
          roleCounts: { "movement-drape": 1 },
        },
        annotations: [{
          shotId: "shot-001", usable: true, fashionRole: "movement-drape", fashionScore: 0.63,
          roleScores: { "movement-drape": 0.52 }, roleAdjustedScores: { "movement-drape": 0.63 },
          poseEvidenceUsed: true, pose: { available: true, completeness: 0.82, motionMagnitude: 0.14 },
          labels: ["movement-drape"], safeStart: 0.12, safeDuration: 3,
        }],
      }), "utf8");
      return { stdout: "", stderr: "" };
    }) as unknown as FashionVisionRunner;
    const result = await runFashionVisionAnalysis({
      sources: [{
        id: "source-001",
        path: "source.mp4",
        shots: [{ id: "shot-001", start: 0, duration: 3.2 }],
      }],
      ...runtime,
      workFolder: runtime.folder,
      signal: undefined,
      onProgress: (event: { message?: string }) => {
        events.push(String(event.message || ""));
      },
      runner,
    });

    expect(result.available).toBe(true);
    expect(result.warning).toBeNull();
    expect(result.modelUsage).toMatchObject({
      device: "cpu",
      fashionclip: { loaded: true, rolePromptCount: 7 },
      mmpose: { loaded: true, poseCandidateCount: 1 },
      roleCounts: { "movement-drape": 1 },
    });
    expect(result.sources[0].shots[0]).toMatchObject({
      fashionRole: "movement-drape",
      fashionPoseEvidenceUsed: true,
      fashionPose: { completeness: 0.82, motionMagnitude: 0.14 },
    });
    expect(events).toContain("女装视觉模型已加载：FashionCLIP + MMPose（cpu）");
    expect(events.some((message) => message.includes("MMPose 已参与 1 个镜头"))).toBe(true);
  });

  it("does not claim full visual-model coverage when MMPose is unavailable", async () => {
    const runtime = await runtimeFolder();
    const runner = (async (_command: unknown, args: unknown) => {
      const commandArgs = args as string[];
      const outputPath = commandArgs[commandArgs.indexOf("--output") + 1];
      await writeFile(outputPath, JSON.stringify({
        modelUsage: { device: "cpu", fashionclip: { loaded: true }, mmpose: { loaded: false }, roleCounts: {} },
        annotations: [],
      }), "utf8");
      return { stdout: "", stderr: "" };
    }) as unknown as FashionVisionRunner;
    const result = await runFashionVisionAnalysis({
      sources: [{ id: "source-001", path: "source.mp4", shots: [{ id: "shot-001", start: 0, duration: 3.2 }] }],
      ...runtime,
      workFolder: runtime.folder,
      signal: undefined,
      runner,
    });

    expect(result.available).toBe(false);
    expect(result.warning).toContain("MMPose 未成功加载");
  });

  it("accepts RTMPose execution without claiming that MMPose ran", async () => {
    const runtime = await runtimeFolder();
    const runner = (async (_command: unknown, args: unknown) => {
      const commandArgs = args as string[];
      await writeFile(commandArgs[commandArgs.indexOf("--output") + 1], JSON.stringify({
        modelUsage: { fashionclip: { loaded: true }, mmpose: { loaded: false }, pose: { loaded: true, backend: "RTMPose-s / ONNX CPU", poseCandidateCount: 1 } },
        annotations: [{ shotId: "shot-001", usable: true, pose: { available: true } }],
      }));
      return { stdout: "", stderr: "" };
    }) as unknown as FashionVisionRunner;
    const result = await runFashionVisionAnalysis({ sources: [{ id: "source", path: "source.mp4", shots: [{ id: "shot-001", start: 0, duration: 3 }] }],
      ...runtime, workFolder: runtime.folder, signal: undefined, runner });
    expect(result.available).toBe(true);
    expect(result.modelUsage?.mmpose.loaded).toBe(false);
    expect(result.modelUsage?.pose.backend).toContain("RTMPose");
  });

  it("blocks incomplete or duplicate annotations even when model load succeeded", async () => {
    const runtime = await runtimeFolder();
    const runner = (async (_command: unknown, args: unknown) => {
      const commandArgs = args as string[];
      await writeFile(commandArgs[commandArgs.indexOf("--output") + 1], JSON.stringify({
        modelUsage: { fashionclip: { loaded: true }, pose: { loaded: true, backend: "RTMPose", poseCandidateCount: 2 } },
        annotations: [{ shotId: "a", pose: { available: true } }, { shotId: "a", pose: { available: true } }],
      }));
      return { stdout: "", stderr: "" };
    }) as unknown as FashionVisionRunner;
    const result = await runFashionVisionAnalysis({ sources: [{ id: "source", path: "source.mp4", shots: [{ id: "a", start: 0, duration: 3 }, { id: "b", start: 3, duration: 3 }] }],
      ...runtime, workFolder: runtime.folder, signal: undefined, runner });
    expect(result.available).toBe(false);
    expect(result.warning).toContain("未完成全部镜头");
  });
});
