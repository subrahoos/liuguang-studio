import { describe, it, expect } from "vitest";
import { buildUserPrompt } from "@/lib/script-engine/prompts";
import type { ScriptGenerationInput } from "@/lib/script-engine/prompts";
import { extractJSON, parseScriptResponse } from "@/lib/script-engine/generator";
import { buildComposeCommand, type ComposeConfig } from "@/lib/video-composer/composer";
import { OpenAISeedanceProvider } from "@/lib/providers/openai-seedance";
import { ProviderError } from "@/lib/providers/base";

// ==================== Prompt 构建测试 ====================

describe("buildUserPrompt", () => {
  const baseInput: ScriptGenerationInput = {
    productName: "氨基酸洁面乳",
    category: "beauty",
    styleType: "pain_point",
    targetDuration: 25,
  };

  it("基础参数生成正确的 prompt", () => {
    const prompt = buildUserPrompt(baseInput);
    expect(prompt).toBeTruthy();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("包含商品名称和品类", () => {
    const prompt = buildUserPrompt(baseInput);
    expect(prompt).toContain("氨基酸洁面乳");
    expect(prompt).toContain("美妆护肤");
  });

  it("包含视频模式指令", () => {
    const input: ScriptGenerationInput = {
      ...baseInput,
      videoMode: "scene_demo",
    };
    const prompt = buildUserPrompt(input);
    expect(prompt).toContain("场景演示");
  });

  it("默认使用 product_closeup 视频模式", () => {
    const prompt = buildUserPrompt(baseInput);
    expect(prompt).toContain("产品特写");
  });

  it("有人物时注入人物描述", () => {
    const input: ScriptGenerationInput = {
      ...baseInput,
      videoMode: "live_presenter",
      character: {
        id: "char-001",
        name: "小美",
        appearance: "25岁女生，长发，白皙皮肤",
        voiceStyle: "温柔女声",
      },
    };
    const prompt = buildUserPrompt(input);
    expect(prompt).toContain("小美");
    expect(prompt).toContain("25岁女生，长发，白皙皮肤");
    expect(prompt).toContain("温柔女声");
    expect(prompt).toContain("char-001");
  });

  it("无人物时不包含人物部分", () => {
    const prompt = buildUserPrompt(baseInput);
    // 不应包含专门的人物描述 section（注意：OUTPUT_FORMAT_PROMPT 模板中会出现 characterId 字段说明，这属于格式定义不是人物注入）
    expect(prompt).not.toContain("【出镜人物】");
    expect(prompt).not.toContain("人物名称");
    expect(prompt).not.toContain("外貌特征");
  });

  it("包含风格指令", () => {
    const prompt = buildUserPrompt(baseInput);
    // pain_point 风格应包含"痛点种草"
    expect(prompt).toContain("痛点种草");
  });

  it("包含自定义要求", () => {
    const input: ScriptGenerationInput = {
      ...baseInput,
      customRequirements: "请重点强调成分安全",
    };
    const prompt = buildUserPrompt(input);
    expect(prompt).toContain("请重点强调成分安全");
  });

  it("包含目标时长", () => {
    const prompt = buildUserPrompt(baseInput);
    expect(prompt).toContain("25秒");
  });
});

// ==================== FFmpeg 命令生成测试 ====================

describe("buildComposeCommand", () => {
  const baseConfig: ComposeConfig = {
    projectId: "test-project-001",
    clips: [
      { type: "image", filePath: "/data/img1.jpg", duration: 3, transition: "direct_concat", motion: "zoom_in_slow" },
      { type: "video", filePath: "/data/clip2.mp4", duration: 5, transition: "ffmpeg_fade" },
    ],
    output: {
      resolution: "1080p",
      aspectRatio: "9:16",
    },
  };

  it("基础合成命令格式正确", () => {
    const cmd = buildComposeCommand(baseConfig);
    expect(cmd).toContain("ffmpeg");
    expect(cmd).toContain("-filter_complex");
    expect(cmd).toContain("libx264");
    expect(cmd).toContain("1080");
    expect(cmd).toContain("1920");
  });

  it("包含所有输入文件", () => {
    const cmd = buildComposeCommand(baseConfig);
    expect(cmd).toContain("/data/img1.jpg");
    expect(cmd).toContain("/data/clip2.mp4");
  });

  it("图片输入使用 loop 参数", () => {
    const cmd = buildComposeCommand(baseConfig);
    expect(cmd).toContain("-loop 1 -t 3");
  });

  it("按参考镜头时长裁切上游生成视频", () => {
    const config: ComposeConfig = {
      ...baseConfig,
      clips: [
        { type: "video", filePath: "/data/model-clip.mp4", duration: 2.4, transition: "direct_concat", hasAudio: true },
      ],
    };
    const cmd = buildComposeCommand(config);
    expect(cmd).toContain("[0:0]trim=duration=2.4");
    expect(cmd).toContain("[0:1]atrim=duration=2.4");
  });

  it("有 BGM 时正确混音", () => {
    const config: ComposeConfig = {
      ...baseConfig,
      output: {
        ...baseConfig.output,
        bgmPath: "/data/bgm.mp3",
        bgmVolume: 0.5,
      },
    };
    const cmd = buildComposeCommand(config);
    expect(cmd).toContain("/data/bgm.mp3");
    expect(cmd).toContain("volume=0.5");
    expect(cmd).toContain("audio_final");
  });

  it("有音频片段时正确提取音轨", () => {
    const config: ComposeConfig = {
      ...baseConfig,
      clips: [
        { type: "video", filePath: "/data/clip1.mp4", duration: 3, transition: "direct_concat", hasAudio: true },
        { type: "video", filePath: "/data/clip2.mp4", duration: 5, transition: "direct_concat", hasAudio: false },
      ],
    };
    const cmd = buildComposeCommand(config);
    // 第一个片段有音频，应提取音轨
    expect(cmd).toContain("[0:1]atrim=duration=3,asetpts=PTS-STARTPTS[a0]");
    // 第二个片段无音频，应生成静音
    expect(cmd).toContain("anullsrc");
  });

  it("字幕渲染参数正确", () => {
    const config: ComposeConfig = {
      ...baseConfig,
      subtitle: {
        texts: [
          { text: "限时特惠", startTime: 0, endTime: 3 },
          { text: "立即购买", startTime: 3, endTime: 5 },
        ],
        fontSize: 40,
        color: "yellow",
        position: "bottom",
      },
    };
    const cmd = buildComposeCommand(config);
    expect(cmd).toContain("drawtext");
    expect(cmd).toContain("fontsize=40");
    expect(cmd).toContain("fontcolor=yellow");
    expect(cmd).toContain("h*0.85"); // bottom 位置
  });

  it("文件路径含特殊字符时正确转义", () => {
    const config: ComposeConfig = {
      ...baseConfig,
      clips: [
        { type: "video", filePath: '/data/my "video".mp4', duration: 3, transition: "direct_concat" },
        { type: "video", filePath: "/data/file$name.mp4", duration: 5, transition: "direct_concat" },
      ],
    };
    const cmd = buildComposeCommand(config);
    // 双引号和 $ 应被转义
    expect(cmd).not.toContain('my "video"');
    expect(cmd).toContain('\\"');
    expect(cmd).toContain("\\$");
  });

  it("xfade 转场正确设置 offset", () => {
    const cmd = buildComposeCommand(baseConfig);
    // ffmpeg_fade 转场应包含 xfade
    expect(cmd).toContain("xfade=transition=fade");
    expect(cmd).toContain("duration=0.5");
    // offset = 前一个片段时长 - fadeDuration = 3 - 0.5 = 2.5
    expect(cmd).toContain("offset=2.5");
  });

  it("输出文件路径正确", () => {
    const cmd = buildComposeCommand(baseConfig);
    expect(cmd).toContain("test-project-001");
    expect(cmd).toMatch(/final_\d+\.mp4/);
  });
});

describe("OpenAISeedanceProvider video payload", () => {
  class CapturingVideoProvider extends OpenAISeedanceProvider {
    capturedBody: Record<string, unknown> | undefined;

    protected override async request<T = unknown>(
      _path: string,
      options: { body?: unknown } = {},
    ): Promise<T> {
      if (options.body && typeof options.body === "object") {
        this.capturedBody = options.body as Record<string, unknown>;
      }
      return {
        id: "video-task-001",
        status: "completed",
        data: { video_url: "https://example.com/video.mp4" },
      } as T;
    }
  }

  class SubmitRetryProvider extends OpenAISeedanceProvider {
    requestAttempts = 0;

    constructor(private readonly failureMessage: string) {
      super({
        name: "openai-seedance",
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
      });
    }

    protected override async request<T = unknown>(): Promise<T> {
      this.requestAttempts += 1;
      if (this.requestAttempts === 1) {
        throw new ProviderError(this.failureMessage, "NETWORK_ERROR", this.name);
      }
      return {
        id: "video-task-retry-001",
        status: "completed",
        data: { video_url: "https://example.com/video.mp4" },
      } as T;
    }

    protected override sleep(): Promise<void> {
      return Promise.resolve();
    }
  }

  it("sends seconds as a string and does not let extra override core video fields", async () => {
    const provider = new CapturingVideoProvider({
      name: "openai-seedance",
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
    });

    await provider.generateVideo({
      modelId: "seedance-v2-720p-video",
      mode: "text-to-video",
      prompt: "test video prompt",
      duration: 3,
      width: 720,
      height: 1280,
      extra: {
        seconds: 3,
        model: "wrong-extra-model",
        size: "1x1",
      },
    });

    expect(provider.capturedBody?.seconds).toBe("3");
    expect(typeof provider.capturedBody?.seconds).toBe("string");
    expect(provider.capturedBody?.model).toBe("seedance-v2-720p-video");
    expect(provider.capturedBody?.size).toBe("720x1280");
    expect(provider.capturedBody?.aspect_ratio).toBe("9:16");
    expect(provider.capturedBody?.resolution).toBe("720p");
  });

  it("does not leak Lingganya-only media fields into a generic Seedance request", async () => {
    const provider = new CapturingVideoProvider({
      name: "openai-seedance",
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
    });

    await provider.generateVideo({
      modelId: "seedance2.0",
      mode: "image-to-video",
      prompt: "test video prompt",
      duration: 15,
      width: 720,
      height: 1280,
      referenceImageUrls: ["https://example.com/reference.jpg"],
      extra: {
        reference_mode: "media",
        reference_videos: ["https://example.com/reference.mp4"],
        reference_audios: ["https://example.com/reference.mp3"],
        generate_audio: false,
      },
    });

    expect(provider.capturedBody?.model).toBe("seedance2.0");
    expect(provider.capturedBody).not.toHaveProperty("reference_mode");
    expect(provider.capturedBody).not.toHaveProperty("reference_videos");
    expect(provider.capturedBody).not.toHaveProperty("reference_audios");
    expect(provider.capturedBody).not.toHaveProperty("generate_audio");
  });

  it("uses only the documented Lingganya sd-2.0-vip fields with temporary file ids", async () => {
    const provider = new CapturingVideoProvider({
      name: "openai-seedance",
      apiKey: "test-key",
      baseUrl: "https://www.lingganyaapi.com/v1",
      extra: { lingganyaSd20Vip: true },
    });

    await provider.generateVideo({
      modelId: "sd-2.0-vip",
      mode: "image-to-video",
      prompt: "保持商品和人物一致",
      duration: 10,
      width: 720,
      height: 1280,
      firstFrameUrl: "file_product",
      referenceImageUrls: ["file_product", "file_face"],
      extra: {
        duration: 15,
        ratio: "1:1",
        reference_mode: "media",
      },
    });

    expect(provider.capturedBody).toEqual({
      model: "sd-2.0-vip",
      prompt: "保持商品和人物一致",
      seconds: 10,
      resolution: "720p",
      size: "9:16",
      images: ["file_product", "file_face"],
    });
    expect(provider.capturedBody).not.toHaveProperty("generate_audio");
  });

  it("rejects sd-2.0-vip references that bypass Lingganya temporary-file upload", async () => {
    const provider = new CapturingVideoProvider({
      name: "openai-seedance",
      apiKey: "test-key",
      baseUrl: "https://www.lingganyaapi.com/v1",
      extra: { lingganyaSd20Vip: true },
    });

    await expect(provider.generateVideo({
      modelId: "sd-2.0-vip",
      mode: "image-to-video",
      prompt: "test",
      duration: 10,
      width: 720,
      height: 1280,
      referenceImageUrls: ["https://cdn.example.com/reference.jpg"],
    })).rejects.toMatchObject({ code: "INVALID_LINGGANYA_REFERENCE" });
    expect(provider.capturedBody).toBeUndefined();
  });

  it("uses the documented sd-2.0-g edit fields in the generic video provider", async () => {
    const provider = new CapturingVideoProvider({
      name: "openai-seedance",
      apiKey: "test-key",
      baseUrl: "https://www.lingganyaapi.com/v1",
      extra: { lingganyaSd20G: true },
    });

    await provider.generateVideo({
      modelId: "sd-2.0-g",
      mode: "image-to-video",
      prompt: "编辑参考视频：只替换模特上衣",
      duration: 12,
      width: 720,
      height: 1280,
      referenceImageUrls: ["file_product", "file_face"],
      extra: {
        videos: ["file_video"],
        audios: ["file_audio"],
        seconds: 15,
        size: "1:1",
        generate_audio: true,
      },
    });

    expect(provider.capturedBody).toEqual({
      model: "sd-2.0-g",
      prompt: "编辑参考视频：只替换模特上衣",
      duration: 12,
      resolution: "720p",
      ratio: "9:16",
      images: ["file_product", "file_face"],
      videos: ["file_video"],
      audios: ["file_audio"],
    });
    expect(provider.capturedBody).not.toHaveProperty("seconds");
    expect(provider.capturedBody).not.toHaveProperty("size");
    expect(provider.capturedBody).not.toHaveProperty("generate_audio");
  });

  it("uses the official sd-2.0-mini unified video fields", async () => {
    const provider = new CapturingVideoProvider({
      name: "openai-seedance",
      apiKey: "test-key",
      baseUrl: "https://www.lingganyaapi.com/v1",
      extra: { lingganyaSd20Mini: true },
    });

    await provider.generateVideo({
      modelId: "sd-2.0-mini",
      mode: "image-to-video",
      prompt: "参考人物和动作，生成自然节奏的竖屏短片",
      duration: 6,
      width: 720,
      height: 1280,
      referenceImageUrls: ["file_person"],
      extra: {
        reference_videos: ["file_motion"],
        reference_audios: ["file_audio"],
        duration: 15,
        ratio: "16:9",
      },
    });

    expect(provider.capturedBody).toEqual({
      model: "sd-2.0-mini",
      prompt: "参考人物和动作，生成自然节奏的竖屏短片",
      seconds: 6,
      resolution: "720p",
      size: "9:16",
      images: ["file_person"],
      extra: {
        reference_videos: ["file_motion"],
        reference_audios: ["file_audio"],
      },
    });
    expect(provider.capturedBody).not.toHaveProperty("duration");
    expect(provider.capturedBody).not.toHaveProperty("ratio");
  });

  it("sends current Grok references as JSON image_urls", async () => {
    const provider = new CapturingVideoProvider({
      name: "openai-seedance",
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
    });
    const references = [
      "https://example.com/composite.png",
      "https://example.com/product.png",
      "https://example.com/face.png",
      "https://example.com/model.png",
      "https://example.com/scene.png",
    ];

    await provider.generateVideo({
      modelId: "grok-imagine-video-1.5",
      mode: "image-to-video",
      prompt: "director prompt",
      duration: 6,
      width: 720,
      height: 1280,
      referenceImageUrls: references,
      extra: {
        seconds: 15,
        duration: 15,
      },
    });

    expect(provider.capturedBody?.seconds).toBe("10");
    expect(typeof provider.capturedBody?.seconds).toBe("string");
    expect(provider.capturedBody).not.toHaveProperty("duration");
    expect(provider.capturedBody?.model).toBe("grok-imagine-video-1.5");
    expect(provider.capturedBody?.aspect_ratio).toBe("9:16");
    expect(provider.capturedBody?.resolution).toBe("720p");
    expect(provider.capturedBody).toEqual({
      model: "grok-imagine-video-1.5",
      prompt: "director prompt",
      seconds: "10",
      aspect_ratio: "9:16",
      resolution: "720p",
      image_urls: references,
    });
  });

  it("limits current Grok image_urls to seven", async () => {
    const provider = new CapturingVideoProvider({
      name: "openai-seedance",
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
    });
    const references = Array.from({ length: 8 }, (_, index) => `https://example.com/ref-${index + 1}.png`);

    await provider.generateVideo({
      modelId: "grok-imagine-video-1.5",
      mode: "image-to-video",
      prompt: "director prompt",
      duration: 10,
      width: 720,
      height: 1280,
      referenceImageUrls: references,
    });

    expect(provider.capturedBody?.image_urls).toEqual(references.slice(0, 7));
  });

  it("omits image_urls for current Grok text-to-video provider calls", async () => {
    const provider = new CapturingVideoProvider({
      name: "openai-seedance",
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
    });

    await provider.generateVideo({
      modelId: "grok-imagine-video-1.5",
      mode: "text-to-video",
      prompt: "director prompt",
      duration: 10,
      width: 720,
      height: 1280,
    });

    expect(provider.capturedBody).not.toHaveProperty("image_urls");
  });

  it("sends only documented omni-flash fields and limits references to seven", async () => {
    const provider = new CapturingVideoProvider({
      name: "openai-seedance",
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
    });
    const references = Array.from(
      { length: 8 },
      (_, index) => `data:image/jpeg;base64,reference-${index + 1}`,
    );

    await provider.generateVideo({
      modelId: "omni-flash",
      mode: "image-to-video",
      prompt: "director prompt",
      duration: 7,
      width: 720,
      height: 1280,
      referenceImageUrls: references,
      extra: {
        segmentIndex: 2,
        sourceTimeRange: "00:06-00:12",
      },
    });

    expect(provider.capturedBody).toEqual({
      model: "omni-flash",
      prompt: "director prompt",
      duration: 6,
      aspect_ratio: "portrait",
      resolution: "720p",
      images: references.slice(0, 7),
    });
  });

  it("sends omni-flash-vref with a fixed ten-second duration and at most five images", async () => {
    const provider = new CapturingVideoProvider({
      name: "openai-seedance",
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
    });
    const references = Array.from(
      { length: 7 },
      (_, index) => `https://example.com/reference-${index + 1}.jpg`,
    );

    await provider.generateVideo({
      modelId: "omni-flash-vref",
      mode: "image-to-video",
      prompt: "restyle the reference video",
      duration: 6,
      width: 1280,
      height: 720,
      referenceImageUrls: references,
      extra: {
        video: "https://example.com/reference.mp4",
        segmentIndex: 3,
      },
    });

    expect(provider.capturedBody).toEqual({
      model: "omni-flash-vref",
      prompt: "restyle the reference video",
      duration: 10,
      aspect_ratio: "landscape",
      resolution: "720p",
      images: references.slice(0, 5),
      video: "https://example.com/reference.mp4",
    });
  });

  it("retries a video submit only when TLS failed before the request was sent", async () => {
    const provider = new SubmitRetryProvider(
      "Network request failed: POST https://example.com/v1/videos - Client network socket disconnected before secure TLS connection was established",
    );

    const result = await provider.generateVideo({
      modelId: "grok-imagine-video-1.5",
      mode: "image-to-video",
      prompt: "director prompt",
      duration: 6,
      width: 720,
      height: 1280,
      referenceImageUrls: ["https://example.com/base.png"],
    });

    expect(provider.requestAttempts).toBe(2);
    expect(result.taskId).toBe("video-task-retry-001");
  });

  it("does not retry a video submit when the remote side may already have received it", async () => {
    const provider = new SubmitRetryProvider(
      "Network request failed: POST https://example.com/v1/videos - other side closed",
    );

    await expect(provider.generateVideo({
      modelId: "grok-imagine-video-1.5",
      mode: "image-to-video",
      prompt: "director prompt",
      duration: 6,
      width: 720,
      height: 1280,
      referenceImageUrls: ["https://example.com/base.png"],
    })).rejects.toThrow("other side closed");

    expect(provider.requestAttempts).toBe(1);
  });
});

// ==================== 脚本生成器 JSON 解析测试 ====================

describe("extractJSON", () => {
  it("正常 JSON 可以解析", () => {
    const input = '{"title":"测试脚本","shots":[]}';
    const result = extractJSON(input);
    expect(result).toBe('{"title":"测试脚本","shots":[]}');
    // 确认可以被 JSON.parse 正确解析
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("markdown 代码块包裹的 JSON 可以解析", () => {
    const input = '```json\n{"title":"测试脚本","shots":[]}\n```';
    const result = extractJSON(input);
    expect(result).toBe('{"title":"测试脚本","shots":[]}');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("无语言标记的 markdown 代码块也可以解析", () => {
    const input = '```\n{"title":"测试脚本","shots":[]}\n```';
    const result = extractJSON(input);
    expect(result).toBe('{"title":"测试脚本","shots":[]}');
  });

  it("带前缀文字的 JSON 可以提取", () => {
    const input = '好的，以下是生成的脚本：\n{"title":"测试脚本","shots":[]}';
    const result = extractJSON(input);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.title).toBe("测试脚本");
  });

  it("数组格式的 JSON 可以提取", () => {
    const input = '[{"title":"脚本1"},{"title":"脚本2"}]';
    const result = extractJSON(input);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });
});

describe("parseScriptResponse", () => {
  it("解析单个脚本对象", () => {
    const content = JSON.stringify({
      title: "测试脚本",
      totalDuration: 20,
      shots: [
        { shotId: 1, type: "hook", duration: 3, description: "开场", camera: "特写", visualSource: "ai_generate", transition: "direct_concat", voiceover: "大家好" },
        { shotId: 2, type: "cta", duration: 3, description: "结尾", camera: "中景", visualSource: "product_image", transition: "direct_concat", voiceover: "快来买" },
      ],
    });
    const scripts = parseScriptResponse(content, "pain_point");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].title).toBe("测试脚本");
    expect(scripts[0].shots).toHaveLength(2);
  });

  it("解析 scripts 数组包裹格式", () => {
    const content = JSON.stringify({
      scripts: [
        { title: "脚本1", totalDuration: 20, shots: [{ shotId: 1, type: "hook", duration: 3, description: "a", camera: "b", visualSource: "ai_generate", transition: "direct_concat", voiceover: "c" }] },
        { title: "脚本2", totalDuration: 25, shots: [{ shotId: 1, type: "hook", duration: 3, description: "d", camera: "e", visualSource: "ai_generate", transition: "direct_concat", voiceover: "f" }] },
      ],
    });
    const scripts = parseScriptResponse(content, "scene");
    expect(scripts).toHaveLength(2);
    expect(scripts[0].title).toBe("脚本1");
    expect(scripts[1].title).toBe("脚本2");
  });

  it("无效 JSON 抛出合适的错误", () => {
    expect(() => parseScriptResponse("这不是JSON", "pain_point")).toThrow("合法 JSON");
  });

  it("无法识别的 JSON 结构抛出错误", () => {
    const content = JSON.stringify({ foo: "bar" });
    expect(() => parseScriptResponse(content, "pain_point")).toThrow("无法解析");
  });

  it("Shot 字段缺失时自动填充默认值", () => {
    const content = JSON.stringify({
      title: "测试",
      shots: [
        { shotId: 1, type: "invalid_type", duration: -1, description: "", camera: "", visualSource: "unknown", transition: "unknown", voiceover: "" },
      ],
    });
    const scripts = parseScriptResponse(content, "pain_point");
    const shot = scripts[0].shots[0];
    // 无效的 type 应该回退到 "demo"
    expect(shot.type).toBe("demo");
    // 无效的 duration 应该回退到 3
    expect(shot.duration).toBe(3);
    // 无效的 visualSource 应该回退到 "ai_generate"
    expect(shot.visualSource).toBe("ai_generate");
    // 无效的 transition 应该回退到 "direct_concat"
    expect(shot.transition).toBe("direct_concat");
  });

  it("totalDuration 缺失时自动从 shots 累加计算", () => {
    const content = JSON.stringify({
      title: "测试",
      shots: [
        { shotId: 1, type: "hook", duration: 3, description: "a", camera: "b", visualSource: "ai_generate", transition: "direct_concat", voiceover: "c" },
        { shotId: 2, type: "cta", duration: 5, description: "d", camera: "e", visualSource: "product_image", transition: "direct_concat", voiceover: "f" },
      ],
    });
    const scripts = parseScriptResponse(content, "pain_point");
    expect(scripts[0].totalDuration).toBe(8);
  });
});
