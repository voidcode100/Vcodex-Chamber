# Vcodex-Chamber

Vcodex-Chamber 是基于 [OpenChamber](https://github.com/openchamber/openchamber) 改造的 Codex 客户端，包含 VS Code 扩展、WinUI 3 WindowsSender 和独立提词器。聊天与工具调用通过 Codex CLI 的 app-server 协议运行；WindowsSender 将截图和录音控制发送到已配对的 VS Code 客户端。

[下载首版 v1.0.0](https://github.com/voidcode100/Vcodex-Chamber/releases/tag/v1.0.0) · [使用与协议](docs/windowssender.md) · [听写实现依据](packages/vscode/DICTATION.md)

## 功能

- Codex 会话、历史读取、占用时只读显示，模型、推理强度、fast 和权限选择。
- 流式回复、思考状态、命令输出及文件修改展示，复用 OpenChamber 的聊天组件。
- WindowsSender 截图键暂存图片，独立发送键将同一目标的多张图片提交为一次 Codex turn；两端支持预览、逐张移除、清空和失败重试。
- 可录制的键盘/鼠标热键，包括鼠标侧键。录音支持独立开始/停止键，或专用按住说话键：按下录音，松开停止、转写并发送。
- 录音由 **运行 VS Code 的客户端麦克风** 采集；WindowsSender 发送控制请求。手动麦克风和远程热键共享状态。
- Markdown 提词器显示当前轮回复，输出期间保持顶部，完成后按速度循环滚动；支持暂停、字号、行距及 Ctrl+滚轮缩放。
- TLS 指纹和配对令牌、当前/固定会话路由、会话 Prompt、重启恢复与提交结果未确认保护。
- WindowsSender 托盘后台和无窗口启动，关闭设置窗口继续运行。

## 安装

1. 从 Release 下载 `Vcodex-Chamber-1.0.0.vsix`，在 VS Code 中使用“扩展：从 VSIX 安装”，然后重新加载窗口。旧开发版更新到首版可使用 `code --install-extension Vcodex-Chamber-1.0.0.vsix --force`。
2. 首版 VSIX 为 Windows x64 构建，包含 Codex CLI。可通过 `captureCodex.codexBinary` 覆盖路径；Codex 未登录时在扩展首页按提示登录。
3. 语音功能需要安装并启用官方 [Codex Audio](https://marketplace.visualstudio.com/items?itemName=openai.codex-audio) 扩展。默认听写复用 Codex 的 ChatGPT 登录；也支持配置 OpenAI-compatible 转写服务。实现及验证范围见 [DICTATION.md](packages/vscode/DICTATION.md)。
4. 将 `Vcodex-Chamber-WindowsSender-1.0.0-win-x64.zip` 解压到固定目录，运行其中的 `WindowsSender.WinUI.exe`。**保留完整解压目录，不能只复制 EXE。** WindowsSender 使用自包含的 .NET / Windows App SDK，不要求用户额外安装 .NET SDK。
5. 在客户端设置的“WindowsSender 与 Codex 提词器”页面启动接收端，将 VS Code 主机地址、端口、配对令牌和证书指纹填入 WindowsSender 并保存。同机地址用 `127.0.0.1`，默认端口 `43127`；跨机器时两端需要能访问该端口。
6. 打开可写 Codex 会话，或固定目标会话。截图键加入会话输入框，发送键提交；录音停止后自动转写并提交。会话被占用、归档或忙碌时保留待处理内容并提示原因。

Release 同时提供 `SHA256SUMS.txt`，可用 `Get-FileHash -Algorithm SHA256` 核对下载文件。

## 热键和后台

| 默认动作 | 新配置的默认组合 |
| --- | --- |
| 截图并暂存 | Ctrl+Alt+Shift+S |
| 发送截图队列 | Ctrl+Alt+Shift+Enter |
| 开始录音 | Ctrl+Alt+V |
| 停止、转写并发送 | Ctrl+Alt+B |
| 移除最近一张待发送截图 | Ctrl+Alt+Shift+Backspace |

点击热键按钮后按键盘或鼠标组合即可保存，Esc 取消。开启“按住说话”后两个独立录音键隐藏并停用，显示可单独录制的长按热键。两种模式分别保存组合；已有配置会保留。

```powershell
.\WindowsSender.WinUI.exe --background # 托盘后台，不打开设置
.\WindowsSender.WinUI.exe --headless   # 无设置窗口、无托盘
.\WindowsSender.WinUI.exe --show       # 打开现有进程的设置
.\WindowsSender.WinUI.exe --exit       # 完全退出
```

关闭设置窗口仅隐藏，托盘双击可打开、右键可退出。后台启动偏好不会注册 Windows 开机自启。提词器可从聊天输入区按钮、设置页或命令面板 `Vcodex-Chamber: Open Teleprompter` 打开。

## 开发与构建

需要 Windows x64、Node.js 22+、Bun 1.3+、.NET 9 SDK、Windows SDK，以及可恢复的 Windows App SDK NuGet 包。NuGet 缓存位置由 `NUGET_PACKAGES` 控制，不将开发者本机路径写入项目。

```powershell
bun install --frozen-lockfile
bun run type-check
bun run test
bun run release
```

`bun run test` 运行接收端/.NET 和转写传输定向测试脚本。浏览器回归使用 Playwright；Windows 默认使用已安装的 Microsoft Edge，其他平台首次执行 `bunx playwright install chromium`。构建后运行 `bun run test:ui`。`bun run dev` 打开 VS Code 扩展开发宿主。

Release 构建脚本会检查版本一致性、类型、接收端/.NET 联调及转写传输，重新构建 WinUI 和 VSIX，验证包内 dist 字节，生成 ZIP 和 SHA-256。打包前需有可用 Codex CLI，或设置 `CODEX_CLI_SOURCE` 指定二进制。浏览器测试需在打包后运行。

| 路径 | 用途 |
| --- | --- |
| `packages/vscode` | 扩展宿主、Codex bridge、接收端、Webview |
| `packages/ui` | 复用的 OpenChamber React 聊天和设置组件 |
| `packages/sdk`、`packages/web` | 上游共享 SDK 和 Web 服务源码，本版不单独发布 Web 应用 |
| `WindowsSender.WinUI` | 唯一的 WindowsSender 产品源码 |
| `tests/windowssender` | .NET 联调测试宿主，不是另一个客户端 |
| `artifacts/build`、`artifacts/test` | 忽略的构建中间文件和测试输出 |
| `artifacts/v1.0.0` | 本轮 Release 的唯一分发目录 |

`plan.md` 是本地阶段记录，不进入 Git、VSIX 或 Release。截图队列、会话路由、证书和设置是业务状态；不属于待清理的诊断日志。

## 来源、兼容性和验证范围

界面及共享代码来自 MIT 授权的 OpenChamber；原来的 OpenCode 后端由 Codex app-server bridge 适配。此项目不是 OpenAI 官方客户端，也不代表 OpenChamber 官方发行。保留上游代码中的 `@openchamber/*`、命令和设置命名用于组件兼容；扩展内部 ID 继续使用 `fedaykindev.openchamber`，避免产生第二套会话/配对存储。产品显示名、仓库及 Release 名均为 Vcodex-Chamber。

听写参考官方 Codex Audio 麦克风命令与 Codex 客户端的 ChatGPT 转写链路，默认听写没有使用 thread Realtime。该 ChatGPT 内部端点不是公开稳定 API，账号或网络受限时可使用可配置的标准转写服务。实际证据、社区参考链接和实现边界保存在 [DICTATION.md](packages/vscode/DICTATION.md)。

网络联调采用合成 PNG、受控 Codex/语音响应，覆盖队列顺序、去重、删除、重启、失败保留与模式隔离；浏览器验证真实组件和提词器。用户已反馈本地长按测试基本成功。多显示器、跨机器网络及不同鼠标驱动仍取决于实际环境。

版本采用 SemVer：首版 `v1.0.0`，兼容修复增加 PATCH，兼容功能增加 MINOR，不兼容变更增加 MAJOR。远程首次提交是当前源码快照；此前开发历史仅保留在本地 Git 回滚分支。

## 许可

[MIT](LICENSE)。上游 OpenChamber 和 SDK 的版权声明保留在各包 LICENSE 中；[上游同步边界](OPENCHAMBER_SYNC.md) 说明可复用部分和 Codex 适配位置。VSIX 中附带的 Codex CLI 使用 Apache-2.0，许可证及 NOTICE 随其二进制分发，源码存放于 `third_party/codex`。
