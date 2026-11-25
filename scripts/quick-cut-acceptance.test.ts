// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectMaterialMetadata, processMaterialFiles } from "../src/lib/quick-cut/material-processor";
import { runProcess } from "../src/lib/quick-cut/engine/process/run-process";

// Explicit opt-in: these tests execute local encoders and write test copies.
describe.skipIf(!process.env.LUMA_QUICK_CUT_ACCEPTANCE_ROOT)("local quick-cut media acceptance", () => {
  it("cleans all audio-track tags, preserves silent inputs, and safely optimizes supported containers", async () => {
    // vitest.setup redirects LUMA_DATA_ROOT to an empty disposable database.
    const root = process.env.LUMA_QUICK_CUT_RUNTIME_ROOT || "D:\\3100";
    const runtimeRoot = path.join(root, "quick-cut", "runtime", "metadata-watermark");
    const ffmpegPath = path.join(runtimeRoot, "ffmpeg", "ffmpeg.exe");
    const ffprobePath = path.join(runtimeRoot, "ffmpeg", "ffprobe.exe");
    const folder = await mkdtemp(path.join(process.env.LUMA_QUICK_CUT_ACCEPTANCE_ROOT!, "media-"));
    const outputFolder = path.join(folder, "清理输出");
    await mkdir(outputFolder);
    const runtime = {
      pythonPath: path.join(runtimeRoot, "python", "Scripts", "python.exe"),
      processorPath: path.resolve("runtime-assets/metadata_watermark_processor.py"),
      qualityProfilePath: path.resolve("runtime-assets/quality_optimize_profile.py"),
      ffmpegPath, ffprobePath, keyPath: path.join(folder, "test-watermark.key"),
    };
    const run = (args: string[]) => runProcess(ffmpegPath, args);
    const source = path.join(folder, "多音轨_属性样本.mp4");
    await run(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=30:duration=1.5", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.5",
      "-map", "0:v:0", "-map", "1:a:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-metadata", "title=private-title", "-metadata", "artist=private-author", "-metadata", "device=private-device",
      "-metadata:s:a:1", "handler_name=private-editor", "-metadata:s:a:1", "language=fra", "-movflags", "use_metadata_tags", "-y", source]);
    const silent = path.join(folder, "无音轨.mp4");
    await run(["-v", "error", "-i", source, "-an", "-c:v", "copy", "-y", silent]);
    const digest = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
    const sourceHash = await digest(source);
    const events: unknown[] = [];
    const common = { ffmpegPath, ffprobePath, metadataCleanupRuntime: runtime, signal: new AbortController().signal,
      onProgress: (event: unknown) => { events.push(event); }, onRow: () => {}, onEncoderFallback: () => {} };
    const cleanup = await processMaterialFiles({ ...common, mode: "metadata-cleanup", sourceFiles: [source, silent], outputFolder });
    expect(cleanup.map((row) => row.status)).toEqual(["done", "done"]);
    expect(await digest(source)).toBe(sourceHash);
    for (const row of cleanup) {
      const result = await runProcess(ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-show_chapters", "-of", "json", row.output]);
      expect(inspectMaterialMetadata(JSON.parse(String(result.stdout))).residualFields).toEqual([]);
      // No source tags, encoder identity or embedded H.264 SEI after remuxing.
      expect((await readFile(row.output)).includes(Buffer.from("private-"))).toBe(false);
      const headers = await run(["-hide_banner", "-loglevel", "info", "-i", row.output, "-map", "0:v:0", "-c:v", "copy", "-bsf:v", "trace_headers", "-f", "null", "-"]);
      expect(String(headers.stderr)).not.toMatch(/nal_unit_type\s+\S+\s+= 6\b/);
    }
    const profiles = [];
    for (const extension of ["mp4", "mov", "mkv", "avi", "webm"]) {
      const file = path.join(folder, `优化副本.${extension}`);
      await run(["-v", "error", "-i", source, "-map", "0:v:0", "-map", "0:a:0", "-c:v", extension === "webm" ? "libvpx-vp9" : "libx264",
        ...(extension === "webm" ? ["-deadline", "realtime", "-cpu-used", "8"] : ["-preset", "ultrafast"]),
        "-c:a", extension === "webm" ? "libopus" : "aac", "-y", file]);
      const before = await digest(file);
      const rows = await processMaterialFiles({ ...common, mode: "quality-optimize", sourceFiles: [file], outputFolder: null });
      expect(rows[0].status, rows[0].error).toBe("done");
      expect(await digest(file)).not.toBe(before);
      profiles.push({ extension, status: rows[0].status });
    }
    await writeFile(path.join(folder, "acceptance.json"), JSON.stringify({ cleanup, profiles, sourceUnchanged: true, events }, null, 2));
    console.log("Media acceptance:", folder);
  }, 180_000);
});
