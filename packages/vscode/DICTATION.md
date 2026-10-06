# Codex 听写实现依据与验证

2026-10-06 核对并重构。此记录取代 plan.md 中旧的“线程 Realtime 听写已完成”结论。

## 依据

- [OpenAI File transcription](https://developers.openai.com/api/docs/guides/speech-to-text)：录制完毕的音频通过 `POST /v1/audio/transcriptions` 上传，multipart 包含 `file` 和 `model`，JSON 响应包含 `text`。语音识别使用转写模型，不需要通过编码会话生成回复来取得文本。
- 本机官方 Codex Desktop `26.930.4958.0` 的 `app.asar`：`webview/assets/app-initial-146770bfc1f4.js` 中 `Azi` 使用 multipart `file`、可选 `language` 调用 `/transcribe`，`Lzi` 校验 `text`；`.vite/build/bootstrap-BXPOZU-a.js` 包含 `https://chatgpt.com/backend-api`、`getAuthStatus(includeToken, refreshToken)` 和 Bearer / ChatGPT-Account-Id 认证头。这是观察到的客户端内部接口，不是公开、稳定的第三方 API 承诺。官方另有独立的 `/dictation/stream` 路径；本实现使用录完上传，不接线程 Realtime。
- 本机官方 `openai.codex-audio-26.930.61225/out/extension.js`：`_codex.microphone.available/start/read/stop/cancel` 命令。`start(UUID)` 返回实际 `sampleRate`；`read(UUID)` 返回 base64 PCM 或 stopped/error；stop 后仍需读取队列尾部，cancel 则清空。它负责本地麦克风，不负责云端转写。远程工作区需要在本机安装该 UI 扩展。
- 仓库生成协议 `GetAuthStatusParams.ts`、`GetAuthStatusResponse.ts` 验证认证字段。认证信息只保留在宿主请求内，不送到 Webview、不写日志或复制 auth.json。
- 官方 VS Code 扩展 `openai.chatgpt 26.5930.61225` 的完整 `out/extension.js`：宿主 `fetchHttp/buildHeaders` 使用 OAuth Bearer、账号头和客户端标识，并检查请求所属账号。此扩展没有公开可直接调用的转写命令。下载包未完整下载，仅提取了完整宿主源码供核对，没有安装或打包进 OpenChamber。
- 社区 [Wangnov/codex-asr](https://github.com/Wangnov/codex-asr) 的 `src/lib.rs` 和 [B4PT0R/codex-backend-sdk](https://github.com/B4PT0R/codex-backend-sdk) 的 HTTP/OAuth 实现交叉验证了 `/transcribe`、multipart、账号头与代理传输。只参考协议，没有移植整包代码；客户端使用真实的 `OpenChamber/<version>` / `originator: openchamber`，不冒充 Codex Desktop。

## 当前实现

- 官方 Codex Audio 采集 PCM16 单声道，使用实际采样率生成 WAV。删除 Webview ScriptProcessor fallback、线程 Realtime、猜测的 transcript 事件和 RPC 落盘诊断。
- 手动麦克风默认可见；勾选按钮转写后插入原输入框，发送按钮转写后复用正常消息发送，取消不上传、不发送。录音状态同步侧栏和编辑区会话页，并提供录音计时。
- WindowsSender 的 start/stop 控制复用相同录音器。停止后按已绑定会话的 prompt 自动发一个 turn；请求 ID 去重，按接收顺序处理控制，错误回传发送端。并发 stop 复用一次转写和提交。
- 默认 ChatGPT 登录调用上述内部 `/transcribe`；API key 登录调用标准 OpenAI `/v1/audio/transcriptions`。明确配置 `captureCodex.voice.transcriptionUrl` 后使用该地址、`transcriptionModel` 和 `transcriptionApiKey`，不将 Codex 账号 token 发往自定义服务。
- 有 60 秒 HTTP 超时、取消、空音频/空文本检查和明确错误。只对 401 刷新认证一次，不再猜测协议重试。音频仅在内存保留，不生成录音文件或持久化日志。
- Node HTTP(S) 请求适配器优先使用 VS Code `http.proxy`，其次对应的环境代理，再尝试 Windows 显式系统代理。遵守 `NO_PROXY`，不修改全局设置、不关闭 TLS 校验、不跟随带令牌的重定向。Windows PAC 与复杂系统绕过规则未单独实现；这类环境可设置 VS Code `http.proxy`。
- 上传失败保留本段 PCM，点击重试复用录音；丢弃、取消和退出登录清除录音。开始与重试时校验账号身份。`captureCodex.voice.language` 可设置 `zh` / `en`，空值让服务自动识别。

## 实测结果与限制（2026-10-06 更新）

旧版使用本机 ChatGPT 认证调用时曾返回 **HTTP 403，`cf-mitigated: challenge`**。本轮修正宿主传输、代理选择、multipart 长度和客户端标识后，使用相同账号与 Windows 合成的测试语音，真实云端转写成功：`Hello. This is a speech transcription test.`。分别验证显式 Clash HTTP 代理、环境代理，以及清除子进程代理环境变量后自动读取 Windows 系统代理，三次均成功。没有配置额外 API Key，没有发送 Codex turn，也没有录制用户麦克风。

这验证了当前账号与网络下的完整上传/识别/文本返回，不能将成功归因于某一个单独请求头，也不承诺所有免费账号或网络均可用。官方也有 [VS Code 403 报告](https://github.com/openai/codex/issues/50430)；若再次被拦截，显示请求编号及重试/丢弃操作，不复制 Cookie 或绕过验证。该内部端点没有公开的第三方稳定性保证。

46 项定向测试通过：Bun 运行 43 项，3 项网络测试因 Bun 的 Node 兼容差异在真实 Node 下单独执行通过。覆盖请求合约、代理转发、取消、认证变化、录音重试、提词器与会话兼容。`scripts/probe-codex-dictation.ts` 保留可选实测入口，必须显式传入测试 WAV，不自动采集音频或输出令牌。

需要使用标准 API 时，设置 `captureCodex.voice.transcriptionUrl` 为 `https://api.openai.com/v1/audio/transcriptions`，配置可用的 OpenAI API Key，模型默认 `gpt-4o-mini-transcribe`。ChatGPT 订阅登录不能代替此 API 的密钥。未获得这样的密钥，标准 API 合约使用模拟响应验证，未做真实付费 API 调用。

本轮没有实际操作用户麦克风；硬件权限、远程 VS Code 的命令桥和 WindowsSender 热键仍需安装新版 VSIX 后实机验收。默认 ChatGPT 登录无需设置 `transcriptionUrl` 或 `transcriptionApiKey`；清除之前填写的自定义地址才能使用此默认链路。

## WindowsSender 联调补充（2.1.6）

录音开始/停止热键现在分别发送 `start` / `stop`，等待匹配 requestId 的确认。停止使用上述同一听写链路，并经会话目标、实际 ownership、归档和忙状态检查，将会话 Prompt 与转写文字提交一次 `turn/start`。转写成功但提交被拒绝时只重试文字；未知提交结果阻止重发。手动插入也会消费已保留文字，取消可阻止仍在验证目标/账号的提交。自动输入使用聊天渲染器接受的 `{text, files}` 事件，图片携带可直接展示的数据。

清理旧 `diagnostics/realtime.log` 与 `%LOCALAPPDATA%/CaptureCodex/capture-codex.log`，移除接收端 `/v1/log`；当前语音诊断只写 OutputChannel。截图队列/回执、证书与配置属于业务状态，保留。新增 9 项接收端、真实 .NET 网络与 manager 联调测试，麦克风和本轮转写/turn 响应由测试替代；不将其宣称为真实硬件端到端验收。详见 [WindowsSender 使用与协议](../../docs/windowssender.md)。

## 提词器维护

删除宿主与页面诊断事件、teleprompter.log 写入和历史文件；保留 ready/settings/clear 功能消息。Ctrl＋滚轮以 2 px 步进缩放，范围 12–72 px，保存到现有工作区设置，不暂停播放。Markdown、当前轮内容、输出期间锁顶和完成后循环滚动保持原有实现。
