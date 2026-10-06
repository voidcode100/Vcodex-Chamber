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

- 本地和 Actions VSIX 构建会查询官方 Marketplace 最新稳定 Codex Audio，下载原包到忽略的审计缓存，校验官方 SHA-256、UI 宿主及五个命令；本项目 VSIX 仅包含来源清单，继续通过 `extensionPack` 安装和更新官方 Audio。当前审计版本 `26.930.61225` 没有 Linux ARM64 原生录音器；本机 ARM Linux 使用独立的 Vcodex Audio ARM 插件和 PvRecorder 源码构建适配，优先探测官方 Audio。Remote SSH 不会回退到服务器录音。详见 [构建说明](../../docs/builds.md)。

- 官方 Codex Audio 采集 PCM16 单声道，使用实际采样率生成 WAV。删除 Webview ScriptProcessor fallback、线程 Realtime、猜测的 transcript 事件和 RPC 落盘诊断。
- ARM 适配复用官方底层 PvRecorder（Apache 2.0），构建固定源码及 miniaudio 哈希，独立子进程通过 stdout 提供 PCM、stderr 提供状态、stdin 停止。默认过滤扬声器 monitor；可设置适配插件的 `vcodexAudio.inputDevice`。停止后读尽最后一帧、取消丢弃、错误终止、退出释放录音进程。没有复制官方扩展代码，没有新增持久化音频或诊断日志。
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

## Linux ARM64 录音适配验证（2026-10-06）

通过 SSH 在用户的 Ubuntu 26.04 / aarch64 桌面真机上执行相同 `build-arm-audio.mjs` 脚本，源码校验、原生编译和版本检查通过。PvRecorder 枚举 `Monitor of Anland remote speaker` 与 `Anland remote microphone`，适配自动选择后者。实际适配器和 Dictation 录音状态机短时采集 39,936 字节、16 kHz 单声道 PCM（约 1.248 秒，峰值 5,585），取消、重新开始和并发开始/停止通过。只统计内存音频，没有保存录音文件或上传到云端；本次不将此测试宣称为真实语音识别或自动提交 Codex turn 的验收。新加 7 项录音适配/路由测试与已有 15 项 Dictation 合约在真实 Node 下通过。类型检查、19 项打包检查（另含嵌套测试）、10 项 WindowsSender 集成及 actionlint 通过；ARM64 与 Windows x64 VSIX 均完成打包校验，Windows 包没有混入 ARM 录音器。新版 ARM VSIX 已通过 CLI 安装到真机，安装后 extension.js/recorder 哈希匹配构建文件，录音器执行权限为 0755。当前打开的 VS Code 窗口仍需重载后手动验证转写；没有启动或监视 Actions。

## CCswitch 与共享登录验证（2026-10-06）

ARM Linux 真机的 HTTP 401 原因为 CCswitch 关闭了 `preserveCodexOfficialAuthOnSwitch`：切到中转供应商后，共享 `~/.codex/auth.json` 仅保存中转 API Key，app-server 返回 `authMethod=apikey`，默认听写因此将该 Key 用于标准 OpenAI API。中转 Key 不等于 OpenAI API Key。Windows 正常环境开启了此选项，ChatGPT OAuth 保留在共享认证文件，中转 Key 由当前供应商的 `experimental_bearer_token` 提供。

本次按相同机制启用 Linux CCswitch 的“切换时保留 Codex 官方登录”，恢复 Linux 自己已保存的有效 ChatGPT 登录，并保留当前中转供应商和模型配置。没有新增语音账号、复制 Windows 凭据、自动读取 CCswitch 数据库的产品代码或更改登录首页。CCswitch 重启后配置仍生效；已运行的 VS Code 后端需执行“Developer: Reload Window”或重启 API 连接，以丢弃旧认证缓存。

使用原项目的 CodexTransport、transcribeRecording 和 createDictationFetch 在 ARM 真机实测：标准共享 app-server 返回 `chatgpt`；Windows 合成的 PCM16 / 16 kHz 测试语音经 ChatGPT `/transcribe` 成功返回 `Hello. This is a speech transcription test.`，没有录制或上传用户麦克风。另用 `codex exec --ephemeral` 和本机模拟 Responses 服务验证模型请求的 Bearer 是原中转 Key，并正常结束；此验证没有向云端模型发送请求或保存测试会话。没有创建独立的语音登录，也没有新增持久化诊断日志。

如其他机器遇到相同问题，先在 CCswitch 开启保留官方登录，并通过原有 Codex 登录流程恢复共享 ChatGPT 认证。只开启保留选项不会凭空生成已丢失的 OAuth。语音自定义转写地址留空才能使用默认 ChatGPT 链路。不要将中转 Key 填入 OpenAI 标准转写接口。

同日排查 ARM 真机的中文录音显示方框：会话原始消息实际为乌尔都语，Unicode 没有替换字符，系统 `fc-list :lang=ur` 没有匹配字体。此现象包含服务语言误识别和字体缺字，不能据此认定编码损坏。真机原设置为自动检测，当时临时将 `captureCodex.voice.language` 指定为 `zh` 进行验证，其他用户设置保持原样。用户随后确认并修复了麦克风问题，真机现已恢复默认自动语言识别。使用项目现有转写代码和 PCM16 / 16 kHz 中文合成音频，实际返回“你好，这是一段中文语音转文字测试，请问你是什么模型。”，没有编码替换字符。合成音频验证不代表用户麦克风的音量、噪声或真实语音识别精度已验收；原始录音未保留，无法判断当时误识别的收音原因。未更改全平台默认语言，未新增持久化诊断或录音文件。

## WindowsSender 联调补充（2.1.6）

录音开始/停止热键现在分别发送 `start` / `stop`，等待匹配 requestId 的确认。停止使用上述同一听写链路，并经会话目标、实际 ownership、归档和忙状态检查，将会话 Prompt 与转写文字提交一次 `turn/start`。转写成功但提交被拒绝时只重试文字；未知提交结果阻止重发。手动插入也会消费已保留文字，取消可阻止仍在验证目标/账号的提交。自动输入使用聊天渲染器接受的 `{text, files}` 事件，图片携带可直接展示的数据。

清理旧 `diagnostics/realtime.log` 与 `%LOCALAPPDATA%/CaptureCodex/capture-codex.log`，移除接收端 `/v1/log`；当前语音诊断只写 OutputChannel。截图队列/回执、证书与配置属于业务状态，保留。新增 9 项接收端、真实 .NET 网络与 manager 联调测试，麦克风和本轮转写/turn 响应由测试替代；不将其宣称为真实硬件端到端验收。详见 [WindowsSender 使用与协议](../../docs/windowssender.md)。

## 提词器维护

删除宿主与页面诊断事件、teleprompter.log 写入和历史文件；保留 ready/settings/clear 功能消息。Ctrl＋滚轮以 2 px 步进缩放，范围 12–72 px，保存到现有工作区设置，不暂停播放。Markdown、当前轮内容、输出期间锁顶和完成后循环滚动保持原有实现。

## 独立 ARM Audio 与失败后重新长按（2026-10-06）

录音器、进程管理和设备配置迁至 `packages/codex-audio-arm`，独立分发 `Vcodex-Audio-ARM-<版本>-linux-arm64.vsix`。客户端只探测官方录音命令，官方不可用时在本地 Linux ARM64 激活适配插件的独立命令；两者不覆盖命令、不共享登录实现。适配只采集 PCM，不保存音频、不发转写请求。客户端沿用共享 Codex 登录和现有转写服务。构建/汇总/Release 逐一校验两个产物，客户端拒绝内置 native 音频文件。

新一次 start 请求遇到纯转写失败时先清除旧 PCM 和错误状态，再开始新录音；并发开始合并，开始期间的停止等待新的麦克风准备完成。成功转写但提交被拒绝的文字及提交结果不确定的记录仍须明确重试或丢弃，避免重复 turn。没有恢复线程 Realtime 或新增诊断落盘。

验证：客户端、Webview、共享 UI 和独立插件类型检查通过；20 项打包测试（另含 22 项录音/听写和 3 项解析器嵌套测试）、12 项接收端/manager/.NET 集成、4 项实际 HTTP 传输测试通过，聊天/登录/提词器生产 UI 回归及 actionlint 通过。四个客户端 VSIX 和独立 Audio ARM VSIX 已本地构建、校验；云端工作流未触发。两个 ARM 包已通过 CLI 安装到真机。执行安装后的实际插件入口，五个独立命令注册正确，16 kHz 录音取得 5,120 字节内存 PCM，停止读尽、取消和再次开始通过，没有保存或上传用户录音；安装后的客户端目录没有 native 录音器。真机语言为自动识别。运行中的 VS Code 窗口仍需重载，用户长按与转写体验需要安装后手动验收。
