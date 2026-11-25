import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, statfs as statfsNative, writeFile, copyFile as copyFileNative } from "fs/promises";
import os from "os";
import path from "path";
import { buildRenderArgs } from "@/lib/quick-cut/engine/mix/command-builder";
import { normalizeProbe, scanMediaFolder } from "@/lib/quick-cut/engine/media/scanner";
import {
  clearNvidiaProbeCache,
  commitVideoDelivery,
  ensureDiskSpace,
  ensureWritableFolder,
  probeNvidiaEncoder,
  quickCutUserError,
  stageLocalToolFiles,
  validateRenderedVideo,
} from "@/lib/quick-cut/engine/reliability";

const temporaryFolders: string[] = [];

async function temporaryFolder() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "quick-cut-test-"));
  temporaryFolders.push(folder);
  return folder;
}

afterEach(async () => {
  clearNvidiaProbeCache();
  await Promise.all(temporaryFolders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("流光快剪素材体检", () => {
  const probe = {
    streams: [
      { codec_type: "video", width: 1080, height: 1920, avg_frame_rate: "30/1" },
      { codec_type: "audio" },
    ],
    format: { duration: "15" },
  };

  it("只接受有效画面尺寸和帧率", () => {
    expect(normalizeProbe("source.mp4", probe, "source.mp4", { size: 2048 })).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect(() => normalizeProbe("source.mp4", {
      ...probe,
      streams: [{ codec_type: "video", width: 0, height: 1920, avg_frame_rate: "30/1" }],
    }, "source.mp4", { size: 2048 })).toThrow("视频画面尺寸无效");
    expect(() => normalizeProbe("source.mp4", {
      ...probe,
      streams: [{ codec_type: "video", width: 1080, height: 1920, avg_frame_rate: "0/0" }],
    }, "source.mp4", { size: 2048 })).toThrow("视频帧率无效");
  });

  it("首帧不能解码的文件进入无效素材列表", async () => {
    const folder = await temporaryFolder();
    await writeFile(path.join(folder, "broken.mp4"), Buffer.alloc(2048, 1));
    const result = await scanMediaFolder({
      folder,
      ffprobePath: "ffprobe.exe",
      ffmpegPath: "ffmpeg.exe",
      probe: async () => probe,
      decodeFrame: async () => {
        throw new Error("decode failed");
      },
    });
    expect(result.valid).toEqual([]);
    expect(result.invalid).toEqual([
      expect.objectContaining({ reason: "视频首帧无法解码，文件可能损坏" }),
    ]);
  });

  it("中文素材先复制到纯英文工具路径", async () => {
    const root = await temporaryFolder();
    const source = path.join(root, "中文素材.mp4");
    await writeFile(source, Buffer.alloc(2048, 7));
    const staged = await stageLocalToolFiles({
      files: [source],
      stagingFolder: path.join(root, "work", "media"),
      prefix: "source",
    });
    expect(path.basename(staged[0])).toBe("source-001.mp4");
    expect(await readFile(staged[0])).toEqual(Buffer.alloc(2048, 7));
  });
});

describe("流光快剪编码预检", () => {
  it("用真实试编码结果判断 NVENC，并在当前进程缓存结果", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await expect(probeNvidiaEncoder({ ffmpegPath: "D:\\ffmpeg.exe", runner })).resolves.toBe(true);
    await expect(probeNvidiaEncoder({ ffmpegPath: "D:\\ffmpeg.exe", runner })).resolves.toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][1]).toContain("h264_nvenc");
  });

  it("真实试编码失败时返回不可用", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("InitializeEncoder failed"));
    await expect(probeNvidiaEncoder({ ffmpegPath: "D:\\ffmpeg.exe", runner })).resolves.toBe(false);
  });

  it("CPU 回退使用内置的软件编码器", () => {
    const args = buildRenderArgs({
      plan: {
        id: "mix-001",
        totalDuration: 1,
        units: [{ videoPath: "source.mp4", videoStart: 0, duration: 1 }],
      },
      outputPath: "output.mp4",
      bgmPath: "",
      productImagePath: "",
      subtitlePath: "",
      settings: {
        fit: "pad",
        audioMode: "original",
        fps: 30,
        quality: "balanced",
        encoder: "cpu",
        transition: "cut",
      },
    });
    const encoderIndex = args.indexOf("-c:v");
    expect(args[encoderIndex + 1]).toBe("libopenh264");
    expect(args).toContain("-rc_mode");
    expect(args).not.toContain("h264_mf");
  });

  it("连续原声主线使用计划指定的时间段并进行响度终处理", () => {
    const args = buildRenderArgs({
      plan: {
        id: "mix-001",
        totalDuration: 30,
        narrativeSourceId: "source-001",
        narrativeAudioPath: "source-001.mp4",
        narrativeAudioStart: 4.5,
        narrativeAudioDuration: 28.5,
        units: [{ videoPath: "source.mp4", videoStart: 0, duration: 30 }],
      },
      outputPath: "output.mp4",
      bgmPath: "",
      productImagePath: "",
      subtitlePath: "",
      settings: {
        fit: "pad",
        audioMode: "original",
        fps: 30,
        quality: "balanced",
        encoder: "cpu",
        transition: "cut",
      },
    });
    const filter = String(args[args.indexOf("-filter_complex") + 1]);
    expect(filter).toContain("atrim=start=4.5:duration=28.5");
    expect(filter).toContain("apad=whole_dur=30");
    expect(filter).toContain("loudnorm=I=-14:LRA=7:TP=-1");
  });

  it("仅背景音乐模式消费未使用的原声音频输出", () => {
    const args = buildRenderArgs({
      plan: { id: "mix-bgm", totalDuration: 3, units: [{ videoPath: "source.mp4", videoStart: 0, duration: 3 }] },
      outputPath: "output.mp4", bgmPath: "music.wav", productImagePath: "", subtitlePath: "",
      settings: { fit: "pad", audioMode: "bgm", fps: 30, quality: "balanced", encoder: "cpu", transition: "cut" },
    });
    const filter = String(args[args.indexOf("-filter_complex") + 1]);
    expect(filter).toContain("[acat]anullsink");
    expect(filter).toMatch(/\[bgm\]loudnorm=.*\[aout\]/);
  });
});

describe("流光快剪成片终检", () => {
  it("验证文件、视频轨、音轨、时长并实际解码首帧", async () => {
    const folder = await temporaryFolder();
    const filePath = path.join(folder, "result.mp4");
    await writeFile(filePath, Buffer.alloc(2048, 1));
    const runner = vi.fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          streams: [
            { codec_type: "video", width: 1080, height: 1920, avg_frame_rate: "30/1" },
            { codec_type: "audio" },
          ],
          format: { duration: "15.02", size: "2048" },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(validateRenderedVideo({
      ffmpegPath: "ffmpeg.exe",
      ffprobePath: "ffprobe.exe",
      filePath,
      expectedDuration: 15,
      runner,
    })).resolves.toMatchObject({ duration: 15.02, hasAudio: true });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1][1]).toContain("-frames:v");
  });

  it("缺少音轨时不把文件标记为完成", async () => {
    const folder = await temporaryFolder();
    const filePath = path.join(folder, "result.mp4");
    await writeFile(filePath, Buffer.alloc(2048, 1));
    const runner = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        streams: [{ codec_type: "video", width: 1080, height: 1920, avg_frame_rate: "30/1" }],
        format: { duration: "15" },
      }),
      stderr: "",
    });
    await expect(validateRenderedVideo({
      ffmpegPath: "ffmpeg.exe",
      ffprobePath: "ffprobe.exe",
      filePath,
      expectedDuration: 15,
      runner,
    })).rejects.toThrow("输出文件缺少音轨");
  });
});

describe("流光快剪交付", () => {
  it("开始前验证输出位置可写且不留下探测文件", async () => {
    const folder = await temporaryFolder();
    await ensureWritableFolder({ folder });
    expect(await readdir(folder)).toEqual([]);
  });

  it("输出位置不可写时在分析前给出可操作提示", async () => {
    const folder = path.join(await temporaryFolder(), "no-write");
    await expect(ensureWritableFolder({
      folder,
      writeFile: async () => {
        throw new Error("Access is denied");
      },
    })).rejects.toThrow("输出位置没有写入权限");
  });

  it("复制失败时清理临时目录，不留下半成品最终目录", async () => {
    const root = await temporaryFolder();
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    await Promise.all([mkdir(source), mkdir(output)]);
    await Promise.all([
      writeFile(path.join(source, "001.mp4"), Buffer.alloc(2048, 1)),
      writeFile(path.join(source, "002.mp4"), Buffer.alloc(2048, 2)),
    ]);
    let copied = 0;
    const copyFile = async (from: string, to: string) => {
      copied += 1;
      if (copied === 2) throw new Error("copy failed");
      await copyFileNative(from, to);
    };

    await expect(commitVideoDelivery({
      sourceFolder: source,
      outputFolder: output,
      deliveryName: "任务",
      expectedCount: 2,
      copyFile: copyFile as typeof copyFileNative,
    })).rejects.toThrow("copy failed");
    expect(await readdir(output)).toEqual([]);
  });

  it("不覆盖同名成片目录，完整复制后再提交", async () => {
    const root = await temporaryFolder();
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    const existing = path.join(output, "任务");
    await Promise.all([mkdir(source), mkdir(existing, { recursive: true })]);
    await writeFile(path.join(existing, "old.txt"), "old", "utf8");
    await writeFile(path.join(source, "001.mp4"), Buffer.alloc(2048, 3));

    const committed = await commitVideoDelivery({
      sourceFolder: source,
      outputFolder: output,
      deliveryName: "任务",
      expectedCount: 1,
      fileNamePrefix: "中文任务",
    });
    expect(path.basename(committed)).toBe("任务 (2)");
    expect(await readFile(path.join(existing, "old.txt"), "utf8")).toBe("old");
    expect((await readdir(committed))).toEqual(["中文任务-001.mp4"]);
  });

  it("磁盘不足提示真实盘符，不写死 D 盘", async () => {
    await expect(ensureDiskSpace({
      folder: "E:\\快剪输出",
      requiredBytes: 2 * 1024 ** 3,
      statfs: (async () => ({ bavail: 1, bsize: 1024 })) as unknown as typeof statfsNative,
    })).rejects.toThrow("E: 可用空间不足");
  });

  it("把底层长错误收敛为可操作提示", () => {
    const error = Object.assign(new Error("ffmpeg failed"), {
      stderr: "Permission denied\nvery long internal output",
    });
    expect(quickCutUserError(error)).toBe("输出位置没有写入权限，请重新选择可写入的文件夹");
  });
});
