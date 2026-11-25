import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { buildDeepMetadataCleanupArgs, buildQualityOptimizeArgs, inspectMaterialMetadata, MAX_LOCAL_MATERIAL_FILES, recoverMaterialProcessingFiles, recoverMetadataCleanupFiles, validateMaterialSources, videoDecodeCheckpoints } from "@/lib/quick-cut/material-processor";

const temporaryFolders: string[] = [];


async function temporaryFolder() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "luma-material-processing-test-"));
  temporaryFolders.push(folder);
  return folder;
}

afterEach(async () => {
  await Promise.all(temporaryFolders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("流光快剪素材处理参数", () => {
  it("元数据清理沿用深度清理、水印与固定 QP 编码处理器", () => {
    const args = buildDeepMetadataCleanupArgs({
      inputPath: "source.mp4",
      outputPath: "clean.mp4",
      runtime: {
        pythonPath: "python.exe",
        processorPath: "metadata_watermark_processor.py",
        qualityProfilePath: "quality_optimize_profile.py",
        ffmpegPath: "x264-ffmpeg.exe",
        ffprobePath: "ffprobe.exe",
        keyPath: "watermark.key",
      },
    });
    expect(args).toContain("metadata_watermark_processor.py");
    expect(args).toContain("--ffmpeg");
    expect(args[args.indexOf("--ffmpeg") + 1]).toBe("x264-ffmpeg.exe");
    expect(args).toContain("--qp");
    expect(args[args.indexOf("--qp") + 1]).toBe("22");
    expect(args).toContain("--qim-step");
    expect(args[args.indexOf("--qim-step") + 1]).toBe("34");
    expect(args).toContain("--gamma-amplitude");
    expect(args[args.indexOf("--gamma-amplitude") + 1]).toBe("0.006");
    expect(args[args.indexOf("--interval-frames") + 1]).toBe("12");
    expect(args[args.indexOf("--lsb-redundancy") + 1]).toBe("5");
    expect(args[args.indexOf("--temporal-rotation-step") + 1]).toBe("7");
    expect(args).not.toContain("copy");
  });

  it("按首帧、中段和尾帧执行输出兼容性解码校验", () => {
    expect(videoDecodeCheckpoints(30)).toEqual([0, 15, 29.9]);
    expect(videoDecodeCheckpoints(0.05)).toEqual([0]);
    expect(MAX_LOCAL_MATERIAL_FILES).toBe(200);
  });

  it("在访问文件前拒绝超过单批上限的本地视频", async () => {
    const sources = Array.from({ length: MAX_LOCAL_MATERIAL_FILES + 1 }, (_, index) => `D:\\batch\\video-${index}.mp4`);
    await expect(validateMaterialSources(sources)).rejects.toThrow("单批最多选择 200 个本地视频");
  });

  it("轻微优化保留画面尺寸与时间轴，不裁切或强制竖屏", () => {
    const args = buildQualityOptimizeArgs({
      inputPath: "source.mp4",
      outputPath: "temporary.mp4",
      hasAudio: true,
      encoder: "cpu",
      profile: {
        brightness: 0,
        contrast: 1.018,
        saturation: 1.01,
        gamma: 1,
        rr: 1,
        gg: 1,
        bb: 1,
        denoise: "hqdn3d=0.65:0.45:1.2:0.9",
        sharpen: "unsharp=3:3:0.24:3:3:0",
      },
    });
    expect(args).toContain("-vf");
    expect(args.join(" ")).toContain("hqdn3d");
    expect(args.join(" ")).toContain("loudnorm");
    expect(args.join(" ")).not.toMatch(/crop=|scale=|1080x1920/);
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    expect(args).toContain("-progress");
    expect(args[args.indexOf("-f") + 1]).toBe("mp4");
  });

  it("WebM 优化输出真实 VP9/Opus 容器，避免把 MP4 内容写进 WebM 扩展名", () => {
    const args = buildQualityOptimizeArgs({ inputPath: "source.webm", outputPath: "temporary.webm", hasAudio: true, encoder: "nvidia",
      profile: { brightness: 0, contrast: 1, saturation: 1, gamma: 1, rr: 1, gg: 1, bb: 1, denoise: "hqdn3d=0.65:0.45:1.2:0.9", sharpen: "unsharp=3:3:0.24:3:3:0" } });
    expect(args[args.indexOf("-c:v") + 1]).toBe("libvpx-vp9");
    expect(args[args.indexOf("-c:a") + 1]).toBe("libopus");
    expect(args[args.indexOf("-f") + 1]).toBe("webm");
    expect(args).not.toContain("-movflags");
  });

  it("检查任意属性和所有轨道，不将正常容器规格误判为作者或软件残留", () => {
    const result = inspectMaterialMetadata({ format: { tags: { major_brand: "isom", minor_version: "512", compatible_brands: "isom", custom_device: "private-device" } },
      streams: [{ codec_type: "video", tags: { language: "und" } }, { codec_type: "audio", tags: { encoder: "private-software" } }, { codec_type: "data" }], chapters: [{}] });
    expect(result.residualFields).toEqual(["format.custom_device", "stream[1].encoder", "stream[2].extra_track", "chapters"]);
    expect(JSON.stringify(result)).not.toContain("private-");
  });
});

describe("流光快剪素材处理恢复", () => {
  it("恢复原件遇到文件占用时保留唯一备份，不继续清除", async () => {
    const folder = await temporaryFolder();
    const source = path.join(folder, "video.mp4");
    const backup = path.join(folder, "video.__luma_quality_backup-locked.mp4");
    await writeFile(backup, "only-original");
    await expect(recoverMaterialProcessingFiles([source], {
      renameFile: async () => { throw new Error("sharing violation"); },
    })).rejects.toThrow("sharing violation");
    await expect(readFile(backup, "utf8")).resolves.toBe("only-original");
  });
  it("中断覆盖时恢复原文件并清理临时文件", async () => {
    const folder = await temporaryFolder();
    const source = path.join(folder, "video.mp4");
    const backup = path.join(folder, "video.__luma_quality_backup-id.mp4");
    const temporary = path.join(folder, "video.__luma_quality_tmp-id.mp4");
    await writeFile(backup, "original");
    await writeFile(temporary, "partial");

    await recoverMaterialProcessingFiles([source]);

    await expect(readFile(source, "utf8")).resolves.toBe("original");
    await expect(readFile(temporary, "utf8")).rejects.toThrow();
  });

  it("中断深度清理时只删除本批的英文暂存副产物", async () => {
    const folder = await temporaryFolder();
    const source = path.join(folder, "video.mp4");
    const delivered = path.join(folder, "video_已清理.mp4");
    const partial = path.join(folder, "video_已清理.part.mp4");
    const encoded = path.join(folder, "video_已清理 (2).video.mp4");
    const unrelated = path.join(folder, "other.part.mp4");
    await Promise.all([
      writeFile(delivered, "finished"),
      writeFile(partial, "partial"),
      writeFile(encoded, "encoded"),
      writeFile(unrelated, "keep"),
    ]);

    await recoverMetadataCleanupFiles(folder, [source]);

    await expect(readFile(delivered, "utf8")).resolves.toBe("finished");
    await expect(readFile(unrelated, "utf8")).resolves.toBe("keep");
    await expect(readFile(partial, "utf8")).rejects.toThrow();
    await expect(readFile(encoded, "utf8")).rejects.toThrow();
  });
});
