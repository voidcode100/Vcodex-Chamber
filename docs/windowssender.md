# Vcodex-Chamber v1.0.0 使用与协议

## 配对

安装 Release 中的 `Vcodex-Chamber-1.0.0.vsix` 并重新加载 VS Code。在 Vcodex-Chamber 设置的“WindowsSender 与 Codex 提词器”页面启动接收端；第一次会自动生成令牌和自签名证书。WindowsSender 中填写 **VS Code 所在主机** 的 IP、端口、令牌和证书指纹并保存。指纹支持带冒号的复制格式。同机可使用 `127.0.0.1`，跨机器需要相应网络能到达监听端口。

默认目标为当前打开会话，可以在客户端设置固定目标并使用“使用当前会话”填入 ID；固定目标保存在 VS Code 配置中。发送端也可显式指定目标；留空使用客户端目标。会话 Prompt 在新建会话时设置，截图和录音共用。

## 截图

截图键采集每个显示器并上传暂存；聊天输入框立即显示图片队列与预览。再次截图会追加图片，不发送 Codex turn。发送键将同一目标的图片按队列顺序一次性发送，使用 `turn/start` 的多个 `localImage`，同时带上该会话 Prompt 和当前模型、推理强度、fast 与权限设置。也可点击客户端队列中的“发送全部截图”。

接收时绑定目标，后来切换会话不会重定向已经暂存的图片。不同目标的队列分别发送。没有会话、已归档、只读、被其他应用占用或仍在回复时保留队列并显示状态，不创建隐藏会话。

本地离线队列每 5 秒尝试暂存；不会仅因恢复连接就自动发送。批次发送保留稳定的请求 ID，重试不会重复 turn。如果 Codex 已可能接收但连接中断，客户端会阻止重发并提供“确认已收到，清除队列”或“确认未收到，允许重试”。发送端本地副本只在收到提交确认后清理；客户端原始 PNG 保留供 Codex 延迟读取和会话历史使用。

两端预览都提供逐张打叉和清空。新增移除快捷键默认 Ctrl+Alt+Shift+Backspace，撤销最近一张待发送截图；已经提交到 Codex 的历史不撤回。客户端持久保存移除 ID，发送端重试不会重新加入该图，下一次暂存同步会清理发送端副本。发送端离线移除保存删除意图，恢复连接后先同步删除。提交结果未确认时拒绝删除，避免掩盖是否已提交。

## 录音

默认开始和停止是两个独立热键；开启“按住说话”立即保存并生效，隐藏、停用这两个热键按钮，显示“按住说话热键”。点击专用按钮监听用户的键盘或鼠标组合，即时保存。按住该键录音，释放主键或必要修饰键停止、转写并发送。关闭模式恢复原来两个独立热键；两种模式各自保存组合键，旧配置的长按热键首次继承开始录音键。录音期间不允许切换模式。按键重复不会重复开始，快速释放也会等待开始确认。客户端使用官方 Codex Audio `_codex.microphone.*` 命令采集本机麦克风；WindowsSender 不采集或上传音频。停止后排空最后的 PCM，按真实采样率编码 WAV，复用现有 Codex ChatGPT 登录转写，再将会话 Prompt 与转写文字自动提交到录音开始时绑定的会话。无需点击会话框发送按钮。

手动会话麦克风与远程热键共享录音状态。远程停止等待转写及 Codex 提交确认后才显示成功。上传失败保留内存 PCM；已转写但提交被拒绝时保留文字，重试不重复上传音频。丢弃、取消或退出登录清除内存内容。控制重复、重连和快速按键经过串行处理与 requestId 去重；模糊提交结果禁止自动重试。当前内部 ChatGPT 端点的实测依据与限制见 [DICTATION.md](../packages/vscode/DICTATION.md)。

误短按造成转写失败后，再次按住说话会请求新录音，由客户端丢弃失败的录音并清除错误状态；在松开前就开始采集。独立停止键仍可重试上一次失败的转写。已经转写成功但未发送的文字、提交结果不确定的请求需要先处理，避免丢失内容或重复发送。Linux ARM64 使用独立的 `Vcodex Audio ARM` 扩展采集麦克风，其他受支持平台优先使用官方 Codex Audio；对应 Audio 原包随主 VSIX 携带并在本地首次启动时自动安装，扩展列表中显示两个插件。

## 接口

所有请求使用 HTTPS/WSS，`Authorization: Bearer <配对令牌>` 位于请求头；发送端校验证书 SHA-256。配对令牌不出现在 URL。

| 接口 | 请求 / 响应 |
| --- | --- |
| `POST /v1/capture` | PNG；`x-capture-id`，可选 `x-capture-batch-id`、`x-monitor-name`、`x-target-session`。返回图片 ID、绑定 sessionId；重复请求返回原接收状态。 |
| `POST /v1/capture/send` | JSON：`requestId`、可选 `captureIds`、`sessionId`、`batchId`。返回提交数量与目标；HTTP 202 表示 turn 已提交，尚不代表 Codex 回复完成。 |
| `POST /v1/capture/remove` | JSON：`sessionId`，可选 `captureIds` 或 `mode: all/last`。按会话移除并持久保存 ID；重复上传返回 `discarded: true`。未确认提交禁止移除。 |
| `GET /v1/status` | 返回目标、当前会话、登录/连接/录音状态、暂存数量、未确认提交和证书指纹。 |
| `WS /v1/voice` | JSON：`type: start/stop/cancel`、`requestId`、可选 `sessionId`。回复 `ack` 或 `error`，携带相同 requestId；stop 成功含 transcript。连接 ready 消息不是动作成功确认。 |

客户端 `capture-outbox.json` 保存图片路径、绑定会话与提交回执；发送端 `capture-queue` 保存离线 PNG、图片元数据和发送意图。这些数据、证书和设置需要保留。录音及转写内容没有持久化日志。

## 热键与后台

点击热键按钮，再按键盘组合或鼠标按钮，即时保存。独立模式启用五个热键，长按模式启用四个。支持 Ctrl/Alt/Shift/Win 与键盘主键、左/右/中键或两个侧键组合，也支持不带修饰键的按钮；推荐带修饰键以避免拦截常用输入。Esc 取消，录制期间其他操作热键暂停。只检查当前模式的重复绑定和系统注册冲突；隐藏模式不注册热键。

关闭设置或点击“后台运行”只隐藏窗口，截图、录音控制和重试服务继续工作。默认有托盘入口：双击打开设置，右键退出。保存“启动时在后台运行”仅控制启动显示，不注册 Windows 开机自启。

```powershell
& '.\WindowsSender.WinUI.exe' --background # 托盘后台
& '.\WindowsSender.WinUI.exe' --headless   # 无设置窗口、无托盘
& '.\WindowsSender.WinUI.exe' --show       # 打开现有进程设置
& '.\WindowsSender.WinUI.exe' --exit       # 完全退出
```

重复启动不会创建第二个热键服务；不带参数启动会唤回现有设置窗口。

## 验证与产物

`node scripts/verify-windowssender.mjs` 构建并运行 `tests/windowssender` 真实 .NET 业务层到 Node HTTPS/WS 接收器的联调，图片采用合成 PNG，Codex RPC、麦克风和转写采用受控替代。12 项测试覆盖录音目标、重复停止、重试、取消、失败后重新长按、未确认提交，以及逐张删除、清空、会话隔离、重启后的删除去重；其中另验证 12 个键鼠/长按状态机场景。测试子进程单独确认启动就绪，启动最多等待 60 秒，每个协议操作最多等待 30 秒；失败报告具体操作与进程错误，便于诊断冷启动的 CI 环境。`scripts/verify-windowssender-ui.mjs` 使用实际 UI 组件验证预览、逐张打叉、清空、删除失败保留、发送、异常保留、提交确认和设置操作。

开发期间实际启动 WinUI 自包含程序，验证无窗口启动、单实例、命令行唤回/退出、设置关闭后继续运行，以及键盘/鼠标中键录制和保存；用户反馈长按测试基本成功。登录与提词器浏览器回归通过。首版已经移除临时持久化诊断及日志文件，保留界面按下/松开提示。默认 ChatGPT 云端转写此前用合成语音实测成功。自动测试没有录制用户声音或向用户会话发送测试 turn；不同鼠标驱动、多显示器、托盘菜单及跨机器网络仍依实际环境验收。

- WindowsSender：`artifacts/v1.0.0/windows-x64/WindowsSender.WinUI.exe`，须保留整个发布目录；分发使用同目录生成的 `Vcodex-Chamber-WindowsSender-1.0.0-win-x64.zip`。
- VSIX：`artifacts/v1.0.0/Vcodex-Chamber-1.0.0.vsix`。
- 校验：`artifacts/v1.0.0/SHA256SUMS.txt`。构建中间文件统一位于 `artifacts/build`，不在产品源码旁生成第二套 bin/obj 发布目录。
