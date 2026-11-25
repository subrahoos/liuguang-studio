# 3100 女装视觉分析运行资源

本目录用于构建并部署到 `D:\3100\quick-cut\runtime\fashion-vision`，与快剪现有 FFmpeg、Whisper、人脸和人物检测资源隔离。

## 组成

- `FashionCLIP`：服饰语义、镜头构图和服装相似度分析。
- `RTMPose-s / ONNX CPU`：当前姿态后端；`MMPose HRNet-W32` 保留为回退。
- `fashion_vision_analyzer.py`：本地逐镜头分析入口。
- `models/READY.json`：只有模型和权重完成本地校验后才创建，任务不会在线下载模型。

## 运行约束

- 只对“女装穿搭展示”调用。
- 姿态模型未完整参与时，女装模式阻止生成，并在运行记录中说明原因；不把“模型已加载”冒充全部镜头已分析。
- 不上传素材，不调用公网模型，不修改原始视频。
- 正式分发前需要同时保留代码、模型权重和基础模型的许可证文件。

## 安装与回退

- 首次准备 RTMPose：在项目根目录运行 `powershell -File scripts/setup-quick-cut-rtmpose.ps1 -DataRoot D:\3100`。脚本下载官方 ONNX 包并校验 SHA256，将 `rtmlib==0.0.16` 和 `onnxruntime==1.24.4` 放入独立的 `rtmpose-packages`，不升级现有 PyTorch/MMPose 环境，也不自动改变正在使用的后端。
- `models/READY.json` 的 `poseBackend: rtmpose` 启用 RTMPose；改成 `mmpose` 切回原姿态权重。RTMPose 初始化失败时尝试 HRNet，事件和摘要显示实际参与的模型名称。
- `LUMA_QUICK_CUT_VISION_PROFILE=baseline` 使用保留的 `fashion_vision_baseline.py` 恢复原版三帧/HRNet分析。切换后重启服务，缓存键包含分析脚本和 READY 内容，不复用其他模型配置的结果。
- 源码内 `runtime-assets` 是脚本的优先入口；受管运行目录保留同版本副本。权重、Python 和 ONNX 二进制仍从受管运行资源目录解析。

## 当前优化与验证

- 每个分析任务只编码一次角色文本特征；图片按最多 8 帧一批推理。每条源视频只打开一个解码器，缓存最多 16 帧；分析帧最长边限制为 960，绝不改变源视频或成片分辨率。
- 采样随镜头时长使用 3/5/7/9 帧；运动强度按采样时间间隔归一化。侧背几何证据须得到视觉分类支持才能加分，画面外的低效关键点不计入完整度。
- Python 回归：`<fashion-vision-python> runtime-assets/test_quick_cut_runtime.py`。
- 完整本地媒体验收：设置 `LUMA_QUICK_CUT_ACCEPTANCE_ROOT` 为测试输出目录，再运行 `pnpm exec vitest run scripts/quick-cut-acceptance.test.ts`；自定义受管资源根目录用 `LUMA_QUICK_CUT_RUNTIME_ROOT`。测试只创建和处理测试副本。
- `scripts/verify-quick-cut-fashion.cjs` 可将真实分析输出接入原规划器、CPU 渲染器和全片解码校验，验证新增模型的下游兼容性。该隔离验收使用测试 BGM，不编造原声转写。
- 2026-11-26 本机对同一视频 4 个 3.5 秒候选窗口的一次对照：原版约 48.4 秒，优化版 RTMPose 约 20.7 秒（包括进程启动和模型加载）；后者每镜头采样 5 帧，原版为 3 帧。这是小样本，不承诺全任务同比提速，也不代表成片审美已验收。
