# 多平台构建与 GitHub Actions

## 产物及平台

版本沿用 SemVer，所有产物位于 `artifacts/v<版本>/`：

- `Vcodex-Chamber-<版本>-win32-x64.vsix`
- `Vcodex-Chamber-<版本>-win32-arm64.vsix`
- `Vcodex-Chamber-<版本>-linux-x64.vsix`
- `Vcodex-Chamber-<版本>-linux-arm64.vsix`
- `Vcodex-Chamber-WindowsSender-<版本>-win-x64.zip`
- `SHA256SUMS.txt`
- `codex-runtime.json`（本次解析的上游版本、Release 和四种官方包哈希）

每个 VSIX 只包含目标平台的 Codex 完整资源目录；保留官方命令运行器、沙箱、rg、Code Mode host、voice 资源及许可证。Linux 主程序和 Code Mode host 使用官方静态 musl ELF，同包用于 Debian/Ubuntu、Fedora 和 Arch。无需发行版专用的 deb/rpm 包。VS Code 自身及特定资源（如音频库、沙箱）的系统要求仍适用；启动握手验证不代表所有硬件/沙箱功能已实测。

ARM 是 ARM64/AArch64，当前官方包没有 ARMv7。Arch 官方镜像仅提供 x64，ARM64 在 Ubuntu 原生 runner、Debian 和 Fedora 验证，不声称已验证 Arch Linux ARM。

VSIX 安装到本地或 Remote SSH 的对应扩展宿主，架构以实际运行扩展的机器为准。WindowsSender 仅 Windows x64，和 VS Code 客户端的平台可以不同。官方 Codex Audio 扩展可用性决定客户端麦克风采集能力，跨平台打包不会替代该扩展。

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

`--codex-version` 接受 `latest`（默认）、稳定版本号、`pinned`。`--runtime-manifest` 与显式版本号互斥，也可用环境变量 `VCODEX_CODEX_RUNTIME_MANIFEST` 共享同一份清单。`--offline` 必须配合显式清单或 `pinned`，只接受已存在且 SHA-512 匹配的缓存；不能离线声称查询到了最新版本。`pinned` 使用源码中的 `scripts/codex-runtime.json` 已验证版本，作为用户主动选择的回退入口。

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

`build-windowssender.ps1` 清理经过路径检查的发布目录后执行 self-contained publish，生成包含全部 WinUI/.NET 文件的 ZIP。不要单独移动 EXE。`node scripts/package-release.mjs --collect-only --runtime-manifest artifacts/build/codex-runtime.json` 汇总并验证四个 VSIX、WindowsSender ZIP 和版本清单，生成总校验和，不包含旧通用 VSIX。WindowsSender 独立构建不查询 Codex Release。

## 验证运行包

```sh
node scripts/verify-vsix.mjs --file artifacts/v1.0.0/Vcodex-Chamber-1.0.0-linux-x64.vsix --target linux-x64 --extract-runtime artifacts/test/codex-runtime --runtime-manifest artifacts/v1.0.0/codex-runtime.json
node scripts/verify-codex-runtime.mjs --directory artifacts/test/codex-runtime --target linux-x64 --runtime-manifest artifacts/v1.0.0/codex-runtime.json
docker pull debian:bookworm-slim
node scripts/verify-codex-runtime.mjs --directory artifacts/test/codex-runtime --target linux-x64 --docker debian:bookworm-slim --runtime-manifest artifacts/v1.0.0/codex-runtime.json
```

验证器检查 `--version` 和真实 JSONL app-server `initialize` / `initialized` 握手，无需账号，不发送模型请求。原生检查使用临时 CODEX_HOME；容器使用独立 tmpfs、禁用网络、只读挂载 runtime，并退出清理。Windows 上可加 `--wsl Ubuntu-24.04` 或 `--wsl Arch-Linux` 执行 Linux x64 检查。

## 云端流程

工作流：`.github/workflows/build.yml`。

- main 推送、main PR、手动 `workflow_dispatch`：检查版本、类型、打包安全/解析器、接收端/转写及浏览器回归。
- 版本任务解析一次最新稳定 Codex，上传 `codex-runtime-manifest` artifact；所有打包、发行版校验及汇总任务通过环境变量复用它，过程中不会各自查询一个可能不同的 latest。缓存 key 包含实际版本和各平台包元数据哈希。
- 原生矩阵：`windows-2022`（x64）、`windows-11-arm`（ARM64）、`ubuntu-24.04`（x64）、`ubuntu-24.04-arm`（ARM64）。每个任务构建自己的 VSIX，解压该 VSIX 后执行真实 Codex 握手。
- Linux 容器：x64 使用 Debian bookworm、Fedora 44、Arch rolling；ARM64 使用 Debian bookworm、Fedora 44。Ubuntu 原生任务已经检查。Docker 在对应原生架构 runner 运行，不通过 QEMU 假装原生验证。
- WindowsSender：单独 Windows x64 runner，发布 WinUI/.NET 自包含 ZIP。
- 全部通过后汇总为 `Vcodex-Chamber-<版本>` Actions artifact，包含四个 VSIX、WindowsSender ZIP、总 SHA256SUMS、Codex 版本清单；中间 artifact 保留 14 天，汇总 artifact 和清单保留 30 天。
- `v<版本>` 标签推送：标签、根包、扩展和 sender 版本必须一致；全部通过后创建 **Release 草稿**。不会覆盖已有 Release、推送 Git 提交或自动公开草稿。手动运行不创建 Release。

工作流使用只读默认权限，只有标签草稿任务授予 `contents: write`；依赖锁定 Bun/Node 主版本及 bun.lock，缓存只保存平台归档，每次使用仍重新核验 SHA-512。项目不需要额外 GitHub secrets，上游查询和 Release 使用当前任务 GitHub token。ARM 原生托管 runner 的可用性和配额取决于 GitHub 仓库/账号；当前公开仓库使用标准 runner 标签。

## 上游跟随与回退

默认构建会跟随上游最新稳定 Release，不必为每个补丁修改源码。为复现旧构建使用已发布的 `codex-runtime.json`；手动 `--codex-version <版本>` 则校验该稳定 GitHub tag 及 npm 包。源码中的 pinned 清单仅是主动回退入口，如需更新它，依据已通过矩阵的清单更新版本、URL、triple 和官方 `dist.integrity`。

上游若改变目录、协议或系统依赖，结构及握手检查将停止发布，需要检查许可证/资源并适配；不会跳过失败来假装兼容。不要仅替换主 EXE 或从本机 PATH 猜版本。如果协议生成类型需要同步，依据同一版本的官方 schema 更新并另行验证。

官方来源：[Codex 最新稳定 Release](https://github.com/openai/codex/releases/latest)、[Codex CLI](https://developers.openai.com/codex/cli)、[GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
