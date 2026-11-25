# 流光商影 Liuguang Studio

本地运行的电商视频生产工作台，包含画板、商品生产线、爆款复刻、商品与人物库、方法库、经营分析、流光快剪、模型通道和账户管理。

这份仓库用于在另一台 **Windows 10/11 x64 电脑**上安装完整系统。源码保存在 Git 中，实际模型权重、Node、Python、FFmpeg 和匹配的应用依赖保存在**本仓库的 Release 附件**，安装程序会自动下载并校验。只下载源码 ZIP 还不包含这些大文件。

## 新电脑安装

1. 登录有权访问此私有仓库的 GitHub 账户，克隆仓库或下载源码 ZIP。建议放在较短的路径，例如 `D:\LiuguangStudio`，预留至少 **25 GB** 空间。
2. 双击根目录 **`安装.cmd`**。首次可能要求登录 GitHub，以下载私有 Release 的完整运行包；这是 GitHub 官方 CLI 的登录流程。之后会自动校验、解压、配置 Python、检查 SQLite 与模型、初始化空数据库并构建应用。
3. 安装时设置这台电脑自己的管理员密码，至少 12 个字符。首次账号为 **`admin`**。
4. 安装成功后双击 **`启动.cmd`**，保留服务窗口，浏览器打开 **http://127.0.0.1:3100/**。
5. 登录后在“模型与 API”配置自己的 API Key。10 个通道的名称、地址、精确模型与协议已预置；生图、LLM 和远端视频功能仍需要对应服务商的有效凭证及网络。

关闭服务窗口或按 Ctrl+C 可停止。再次运行只需双击 `启动.cmd`。数据默认保存到本项目的 `data` 文件夹；每台电脑独立，不会同步历史数据。

端口、数据目录或代理需要调整时，在项目目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Port 3200 -DataRoot E:\LiuguangData -ProxyUrl http://127.0.0.1:7890
```

服务默认只监听本机 `127.0.0.1`。本地 HTTP 使用非 Secure 会话 Cookie；如自行配置公网 HTTPS，须在本机 `.local/config.json` 开启 `secureCookies` 并自行配置访问入口。

## 手动或离线安装

在 GitHub Release 页面下载 `deployment/release.json` 所列的**所有** `*.zip.partNN` 附件到同一文件夹，然后执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -AssetsDirectory E:\LiuguangPackages
```

分卷必须全部齐全。安装程序逐卷及整包校验 SHA-256，不从第三方模型站点临时补下载。准备好源码及所有分卷后，安装与本地模型功能可以离线运行；远端 AI 功能仍需联网。

微软官方 Visual C++ x64 运行库安装器也已随源码附带，安装脚本核验哈希和微软签名，检测到缺失时安装，Windows 可能要求管理员权限。Python 环境不要手动移动：移动项目后重新运行安装程序，以更新环境配置和本机路径。

## 已包含的运行资源

| 功能 | 本地资源 |
| --- | --- |
| 快剪语音分析 | whisper.cpp、small q5_1 权重、配套 DLL |
| 画板完整音频转写 | faster-whisper、small 权重、CTranslate2、PyAV、ONNX Runtime |
| 人脸与人物检测 | YuNet、MediaPipe 人物检测 ONNX、onnxruntime-node |
| 女装视觉分析 | FashionCLIP 权重、分词器与配置，Torch CPU 环境 |
| 动作与姿态 | 默认 RTMPose-s / ONNX，rtmlib；保留 MMPose HRNet 与原版分析脚本回退 |
| 元数据清理、轻微音画优化 | 完整 Python、NumPy、当前处理脚本、专用 FFmpeg / FFprobe |
| 画板抽帧、证据板、视频合成 | 通用 FFmpeg / FFprobe |
| 应用 | Node 24.16.0、锁定的 Windows x64 依赖、SQLite 原生绑定、全部页面与 API 源码 |

CPU 可运行所有本地模型。NVIDIA 编码由真实探测决定，不可用时回退 CPU；本包不要求安装 CUDA。女装分析的优化版与稳定基线同时保留。

资源逐文件清单与哈希见 `deployment/runtime-inventory.json`；分卷及整包哈希见 `deployment/release.json`；第三方来源与许可证见 [运行资源说明](deployment/THIRD-PARTY.md)。应用依赖随包附带，首次安装不要求自行安装 Node、Python、pnpm 或编译 better-sqlite3。

## 数据与密钥

仓库与 Release **不包含**旧账户、项目、画板、素材、人物照片、生成结果、经营表、日志、数据库、API Key、Cookie、账户密码或本机加密主密钥。

保留数据库结构、程序内 Prompt、模型协议、10 个非敏感通道定义和全部实际运行资源。新安装生成自己的数据库、管理员密码哈希及加密主密钥；元数据处理水印密钥也在本机独立生成。Cloudinary 等托管服务需重新配置自己的账户和凭证。

本机文件：

- `data/`：独立业务数据及 `system/model-credential-encryption.key`。
- `.runtime/`：已安装的运行资源。
- `.local/`：安装配置、下载分卷、GitHub CLI。
- `.next/`：本机生产构建。

以上均由 `.gitignore` 排除。升级不会重置现有数据库或密码。今后自行备份业务数据库时，应同时保管该电脑的加密主密钥，否则已保存 API 凭证无法解密。

## 开发与验证

应用使用 Next.js 16.3、React 19、TypeScript、Drizzle / SQLite、Tailwind 和 Vitest。Windows 生产构建固定使用 Webpack。

安装完成后可使用随包 Node（在 PowerShell 项目目录中）：

```powershell
$node = '.\.runtime\tools\node\node.exe'
& $node node_modules\typescript\bin\tsc --noEmit
& $node node_modules\eslint\bin\eslint.js .
& $node node_modules\vitest\vitest.mjs run --maxWorkers=1
```

测试使用临时空数据库，不复制正式数据库。`scripts/quick-cut-acceptance.test.ts` 的真实媒体验收需显式设置环境变量后运行；不会默认读取个人素材。旧 `e2e/smoke.spec.ts` 是历史页面脚本，不是当前安装验收依据。

构建、模型加载、媒体处理和 HTTP 验证记录见 [交付验证](deployment/VERIFICATION.md)。付费 API 不会在安装、验证或启动时自动提交。
