# 第三方运行资源

运行包用于 Windows x64 本地部署；第三方代码和模型分别遵循自己的许可证。各 Python 包的 `.dist-info`、Node 包许可证、Node 与 Python 根目录许可证保留在实际附件中。

| 资源 | 来源与许可证 |
| --- | --- |
| Node 24.16.0 | https://nodejs.org/ ，随附 LICENSE |
| CPython 3.12 | https://python.org/ ，随附 LICENSE.txt |
| Microsoft Visual C++ x64 Redistributable | https://aka.ms/vs/17/release/vc_redist.x64.exe ，微软官方签名安装器；遵循安装器内微软许可条款 |
| whisper.cpp 1.9.1 | https://github.com/ggml-org/whisper.cpp ，MIT；`whisper/release.json` 保存原始下载链接与哈希 |
| Whisper small q5_1 | https://huggingface.co/ggerganov/whisper.cpp ，模型来源 OpenAI Whisper（MIT） |
| faster-whisper small | https://huggingface.co/Systran/faster-whisper-small ，模型卡随包，来源 OpenAI Whisper |
| YuNet / MediaPipe 人物检测 | https://github.com/opencv/opencv_zoo ，对应许可证在 `deployment/licenses/` |
| FashionCLIP | https://huggingface.co/Marqo/marqo-fashionCLIP ，MIT，模型卡随包 |
| MMPose HRNet | https://github.com/open-mmlab/mmpose ，Apache-2.0；配置与权重同时保留 |
| RTMPose-s / rtmlib | https://github.com/open-mmlab/mmpose 、https://github.com/Tau-J/rtmlib ，Apache-2.0，许可证随模型保留 |
| Torch / transformers / NumPy / ONNX Runtime | 对应安装包自带版权与许可证，完整保留 |
| Noto Sans SC 中文字体 | https://github.com/google/fonts/tree/main/ofl/notosanssc ，SIL OFL 1.1；字体与 OFL.txt 位于 `runtime-assets/fonts/` |
| 通用 FFmpeg 8.1.1 | https://www.gyan.dev/ffmpeg/builds/ ，GPLv3；随附 LICENSE 和包含精确源码提交地址的 README.txt |
| 快剪及清理专用 FFmpeg | 随运行目录保留现有许可证；实际版本与编译选项可由各自 `ffmpeg.exe -version` 核对 |

本项目本地模型只读取随包权重。源码中的第三方付费 API 通道定义不代表已取得服务额度，用户自行配置对应凭证。
