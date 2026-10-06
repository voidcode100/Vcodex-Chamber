# 多平台构建与 GitHub Actions

## 产物及平台

版本沿用 SemVer，所有产物位于 `artifacts/v<版本>/`：

- `Vcodex-Chamber-<版本>-win32-x64.vsix`
- `Vcodex-Chamber-<版本>-win32-arm64.vsix`
- `Vcodex-Chamber-<版本>-linux-x64.vsix`
- `Vcodex-Chamber-<版本>-linux-arm64.vsix`
- `Vcodex-Audio-ARM-<版本>-linux-arm64.vsix`（独立麦克风适配插件）
- `Vcodex-Chamber-WindowsSender-<版本>-win-x64.zip`
- `SHA256SUMS.txt`
- `codex-runtime.json`（本次解析的上游版本、Release 和四种官方包哈希）

每个 Vcodex-Chamber VSIX 只包含目标平台的 Codex 完整资源目录；保留官方命令运行器、沙箱、rg、Code Mode host、voice 资源及许可证。Linux 主程序和 Code Mode host 使用上游官方静态 musl ELF；本项目不生成 deb、rpm 或其他发行版安装包。VS Code 自身及特定资源（如音频库、沙箱）的系统要求仍适用；启动握手验证不代表所有硬件/沙箱功能已实测。

ARM 是 ARM64/AArch64，当前官方包没有 ARMv7。构建会检查每个 VSIX 内 Codex ELF/PE 的架构、哈希和启动握手；不会把发行版容器兼容性检查作为发布条件。

VSIX 安装到本地或 Remote SSH 的对应扩展宿主，架构以实际运行扩展的机器为准。WindowsSender 仅 Windows x64，和 VS Code 客户端的平台可以不同。x64 等受支持本地主机使用官方 Codex Audio；Linux ARM64 本地主机另安装 Vcodex Audio ARM。客户端不再内置录音器。

## 本地构建

使用 Node.js 24 和 Bun 1.3.14；下载需要 curl。无需预装 Codex：

```sh
bun install --frozen-lockfile
bun run type-check
bun run test:packaging
node scripts/build-vsix.mjs --target all
node scripts/build-vsix.mjs --target linux-arm64
```

默认 `bun run vscode:package` 使用当前宿主目标；无论只构建 VSIX 还是全套发布，都自动查询 `openai/codex` 的 GitHub 最新稳定 Release，拒绝 draft、prerelease；从 npm 查询该确切版本的四种平台包。任一平台尚未发布、版本不符或缺少 SHA-512 时明确失败，不悄悄降级。GitHub API 受限时可提供当前进程的 `GH_TOKEN` 或 `GITHUB_TOKEN`；Actions 自动使用内置 token。令牌不进入清单、VSIX 或日志。

`--target` 支持四种目标、逗号分隔及 `all`。可以跨架构打包，但执行握手需目标原生宿主。`--skip-build` 仅用于刚刚完成共享 extension/Webview 构建后复用 dist；源码改动后需要完整构建。默认解析清单保存到 `artifacts/build/codex-runtime.json`，分发目录也附带该清单。

```sh
node scripts/build-vsix.mjs --target linux-x64 --codex-version 0.160.1
node scripts/resolve-codex-runtime.mjs --version latest
node scripts/build-vsix.mjs --target all --runtime-manifest artifacts/build/codex-runtime.json
node scripts/build-vsix.mjs --target all --runtime-manifest artifacts/build/codex-runtime.json --offline
node scripts/build-vsix.mjs --target linux-x64 --codex-version pinned --offline
```

`--codex-version` 接受 `latest`（默认）、稳定版本号、`pinned`。`--runtime-manifest` 与显式版本号互斥，也可用环境变量 `VCODEX_CODEX_RUNTIME_MANIFEST` 共享同一份清单。`--offline` 必须配合包含 Audio 记录的显式清单或 `pinned`，只接受已存在且 SHA 匹配的缓存；不能离线声称查询到了最新版本。`pinned` 使用源码中的已验证清单，作为用户主动选择的回退入口。

Codex Audio 同样默认从官方 Marketplace 查询最新稳定版；`--audio-version` 可选择 `latest`、确切版本或 `pinned`。构建下载原始 VSIX 到忽略的 `artifacts/codex-audio/<版本>/universal.vsix`，核验 Marketplace SHA-256、发布者、UI 宿主及五个麦克风命令。仅将来源清单 `codex-audio.json` 纳入本项目 VSIX，不嵌入、修改或重新分发 Audio；非 Linux ARM64 包的 `extensionPack` 让 VS Code 从 Marketplace 安装并更新官方扩展；Linux ARM64 包关联独立的 `fedaykindev.vcodex-audio-arm`。适配插件目前通过 Release VSIX 分发，未发布 Marketplace 时必须手动安装对应 VSIX。离线构建复用快照中的 Audio 版本和已校验缓存。

本轮审计的 Audio `26.930.61225` 要求 VS Code `^1.96.2`，提供 Windows x64/ARM64、Linux x64 和 macOS 原生录音器，未提供 Linux ARM64 录音器。本机 Linux ARM64 改用独立的 Vcodex Audio ARM 插件，仍优先探测官方 Audio，便于未来上游补齐支持。远程工作区使用兼容本地 UI 宿主的官方 Audio；ARM 适配不会录制 SSH/容器服务器的麦克风。

### Linux ARM64 录音程序

官方 Codex Audio 完整扩展源码目前未在公开 `openai/codex` 仓库中找到，但其录音依赖 [PvRecorder](https://github.com/Picovoice/pvrecorder/tree/main/project) 公开 C 源码、采用 Apache 2.0。本项目从固定 commit 编译该依赖和一个独立的 stdin/stdout 桥，不修改或重发官方 Audio VSIX，也不依赖树莓派专用预编译包。`scripts/arm-audio-sources.json` 固定 PvRecorder、miniaudio commit 及每个文件的 SHA-256；构建先核验源码，打包再核验 ELF ARM64 架构、helper 源码、文件哈希、许可证和执行位。

在 Linux ARM64 安装 C 编译器和 Node/Bun 后：

```sh
node scripts/build-arm-audio-vsix.mjs
node scripts/build-vsix.mjs --target linux-arm64
```

Actions 的 ARM runner 构建两个独立产物：Vcodex-Chamber 客户端及 Vcodex Audio ARM。录音源码和适配宿主位于 `packages/codex-audio-arm/`；原生录音器只出现在 Audio ARM VSIX 的 `native/linux-arm64/`，客户端包校验会拒绝任何内置麦克风。它动态使用系统 PulseAudio/PipeWire 或 ALSA，不需要 npm 原生模块或 Electron ABI 重编译；需要可访问的桌面音频服务、输入设备和 glibc（托管构建使用 Ubuntu 24.04）。不承诺 musl/Alpine 桌面录音支持。

Windows 跨平台打包独立 Audio ARM VSIX 时，可在 ARM Linux 上执行同一构建脚本，将其 `artifacts/arm-audio/linux-arm64/` 放到本机相同位置；或设置 `ARM_AUDIO_CC` 为 Linux ARM64 交叉编译器。缓存缺失、helper 源码变化、哈希或架构不符会明确失败，不会发布一个没有录音程序的 Audio ARM VSIX。`--offline` 只接受已校验缓存；单独的 `build-arm-audio.mjs --offline` 可用已校验源码重新编译。

默认排除名称包含 monitor 的回环源并选择麦克风；指定输入设备时在 VS Code 用户设置填写 `vcodexAudio.inputDevice`（兼容旧 `captureCodex.voice.inputDevice`），名称来自 `native/linux-arm64/recorder --list-devices`。不要将系统扬声器监听当作麦克风。PCM16 单声道采样率从录音程序读取，音频仅在内存中交给现有听写/转写流程。适配插件是 UI 宿主扩展，使用独立 `_vcodex.audio.*` 命令，不覆盖官方 `_codex.microphone.*`；不包含登录、转写网络请求或模型。

只构建客户端 VSIX 不再要求本地 C 编译器或 Audio ARM 原生缓存。全套发布仍需要单独构建 Audio ARM。验证脚本包含录音子进程、命令路由、失败后再次长按和并发停止回归。

下载缓存位于 `artifacts/codex/<Codex版本>/downloads/`，临时解压位于同版本目标目录，暂存 runtime 位于 `packages/vscode/bin/<platform-arch>/`。多个暂存目录不会混入同一个 VSIX。打包前检查归档路径、符号链接、架构；打包后检查 VSIX TargetPlatform、所有运行资源 SHA-256、许可证和执行位，并比对当前 dist。标准 VSCE prepublish 只接受本项目脚本准备的目标包，避免裸 `vsce package` 生成混合平台包。

代理示例（只影响当前进程环境）：

```powershell
$env:CODEX_DOWNLOAD_PROXY='http://127.0.0.1:7890'
node scripts/build-vsix.mjs --target all
```

WindowsSender 使用 Windows SDK、.NET 9 SDK、Windows App SDK；测试宿主需要 .NET 8 runtime。依赖通过 NuGet 恢复，可自行设置 `NUGET_PACKAGES`。只在 Windows 运行：

```powershell
powershell -NoProfile -File scripts/build-windowssender.ps1
bun run release # 全套类型/集成/浏览器检查及全部产物
```

`build-windowssender.ps1` 清理经过路径检查的发布目录后执行 self-contained publish，生成包含全部 WinUI/.NET 文件的 ZIP。不要单独移动 EXE。`node scripts/package-release.mjs --collect-only --runtime-manifest artifacts/build/codex-runtime.json` 汇总并验证四个客户端 VSIX、独立 Audio ARM VSIX、WindowsSender ZIP 和版本清单，生成总校验和，不包含旧通用 VSIX。WindowsSender 独立构建不查询 Codex Release。

## 验证运行包

```sh
node scripts/verify-vsix.mjs --file artifacts/v1.0.0/Vcodex-Chamber-1.0.0-linux-x64.vsix --target linux-x64 --extract-runtime artifacts/test/codex-runtime --runtime-manifest artifacts/v1.0.0/codex-runtime.json
node scripts/verify-codex-runtime.mjs --directory artifacts/test/codex-runtime --target linux-x64 --runtime-manifest artifacts/v1.0.0/codex-runtime.json
```

验证器检查 `--version` 和真实 JSONL app-server `initialize` / `initialized` 握手，无需账号，不发送模型请求。原生检查使用临时 CODEX_HOME；发行版容器检查不属于本项目发布流程。Windows 上可加 `--wsl Ubuntu-24.04` 或 `--wsl Arch-Linux` 执行 Linux x64 检查。

## 云端流程

工作流：`.github/workflows/build.yml`。

- 版本标签推送或手动 `workflow_dispatch`：检查版本、类型、打包安全/解析器、接收端/转写及浏览器回归。普通 main 推送和 PR 不会自动消耗构建额度。
- 版本任务解析一次最新稳定 Codex 和 Codex Audio，上传 `codex-runtime-manifest` artifact；所有打包及汇总任务通过环境变量复用它，过程中不会各自查询一个可能不同的 latest。缓存 key 包含实际版本和官方包哈希。
- 原生矩阵：`windows-2022`（x64）、`windows-11-arm`（ARM64）、`ubuntu-24.04`（x64）、`ubuntu-24.04-arm`（ARM64）。四个平台可以并行；每个平台内部串行执行“构建 VSIX → 类型/打包检查 → 解压包内 Codex 并执行握手 → 上传”。Windows/Linux x64 在上传前追加接收端、转写和浏览器回归，直接复用刚构建的 Webview；ARM64 也执行类型、打包和原生握手检查。
- Linux 只构建和验证上游官方 x64/ARM64 Codex 运行包，不构建发行版安装包，也不执行 Debian/Fedora/Arch 容器矩阵。
- WindowsSender：单独 Windows x64 runner，与 VSIX 并行；先构建 WinUI/.NET 自包含 ZIP，再运行集成检查，成功后上传。删除独立的前置 checks job，汇总和发布仍必须等待所有平台检查成功。
- 全部通过后汇总为 `Vcodex-Chamber-<版本>` Actions artifact，包含四个 VSIX、WindowsSender ZIP、总 SHA256SUMS、Codex 版本清单；中间 artifact 保留 14 天，汇总 artifact 和清单保留 30 天。
- 手动 Run workflow：全部构建和检查成功后，自动创建并公开 **预发布 Release**，使用 `v<源码版本>-build.<run_id>.<run_attempt>` 标签并指向本次构建的精确 commit。每次运行/重试都有独立标签，保留已发布的 v1.0.0；勾选 `draft` 可改为草稿。VSIX 和 WindowsSender 的内置版本仍是源码版本。
- `v<版本>` 标签推送：标签、根包、扩展和 sender 版本必须一致；全部通过后自动创建并公开正式 Release。所有 Release 自动上传四个 VSIX、WindowsSender ZIP、SHA256SUMS 和 Codex/Audio 清单，无需手动上传文件。
- 发布脚本先核验七个文件和总校验和；已有 Release 不覆盖、不删除、不替换资产，创建冲突明确失败。相同 ref 的运行排队，不中断正在上传的 Release。发布是最后一个 job，任何构建/检查/汇总失败都不会进入发布。

工作流使用只读默认权限，只有最后的 Release 任务授予 `contents: write`；依赖锁定 Bun/Node 主版本及 bun.lock，缓存只保存官方平台归档和 Audio 原始 VSIX，每次使用仍重新核验 SHA-512/SHA-256。项目不需要额外 GitHub secrets，上游查询和 Release 使用当前任务 GitHub token。ARM 原生托管 runner 的可用性和配额取决于 GitHub 仓库/账号；当前公开仓库使用标准 runner 标签。

## 上游跟随与回退

默认构建会跟随上游最新稳定 Release，不必为每个补丁修改源码。为复现旧构建使用已发布的 `codex-runtime.json`；手动 `--codex-version <版本>` 则校验该稳定 GitHub tag 及 npm 包。源码中的 pinned 清单仅是主动回退入口，如需更新它，依据已通过矩阵的清单更新版本、URL、triple 和官方 `dist.integrity`。

上游若改变目录、协议或系统依赖，结构及握手检查将停止发布，需要检查许可证/资源并适配；不会跳过失败来假装兼容。不要仅替换主 EXE 或从本机 PATH 猜版本。如果协议生成类型需要同步，依据同一版本的官方 schema 更新并另行验证。

官方来源：[Codex 最新稳定 Release](https://github.com/openai/codex/releases/latest)、[Codex CLI](https://developers.openai.com/codex/cli)、[GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
