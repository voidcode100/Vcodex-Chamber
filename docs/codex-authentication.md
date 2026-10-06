# Codex 登录首页与听写认证

2026-10-06

## 官方协议依据

- [Codex app-server 认证](https://learn.chatgpt.com/docs/app-server)：`account/read` 返回账号与 `requiresOpenaiAuth`；`account/login/start` 发起 ChatGPT 浏览器授权或设备代码流程；`account/login/completed`、`account/updated` 报告结果与账号变化。取消和退出分别使用 `account/login/cancel`、`account/logout`。
- [Voice](https://learn.chatgpt.com/docs/features/voice)：听写和实时语音对话是不同的交互方式。听写将语音转为可编辑文本。
- 听写采集和内部转写请求的本机实现依据、Cloudflare 实测见 [DICTATION.md](../packages/vscode/DICTATION.md)。录音保存在本机不表示语音识别在本机完成；截图不能确定具体识别模型，也不能说明它使用会话当前选择的聊天模型。

## 已实现

- 启动时先检查 app-server 的实际账号状态。未确认前隐藏聊天容器；未登录时显示独立首页，不再使用可关闭横幅。
- 使用 app-server 返回的 HTTPS 授权链接打开默认浏览器；不再把普通 ChatGPT 登录网页当作 Codex OAuth 的替代入口。支持设备代码、重开浏览器、取消和重新检查。
- 授权通知与等待期间轮询共同更新界面。账号确认有效后自动加载聊天；侧栏和会话编辑页使用同一个入口。已加载页面退出登录时隐藏并禁用聊天容器。
- 保留 API Key 登录；`account:null, requiresOpenaiAuth:false` 的自定义提供商允许使用，不强制 ChatGPT 登录。状态查询失败和连接失败分别显示错误与重试入口。
- 凭据由 Codex 管理。Webview 只接收账号展示字段、登录状态和授权链接，不接收访问令牌。
- WindowsSender 截图提交与录音启动在宿主检查登录状态。

## 验证与限制

- 37 项定向测试通过：认证状态、授权竞态/取消、听写、提词器与 Codex facade。
- 宿主和 Webview 类型检查通过。
- Edge 验证真实宿主 HTML/CSS 与登录组件：未登录不可使用聊天框、设备代码/取消/错误、自动进入、退出、免认证提供商、断开连接、避免重复挂载。另运行生产构建的 main 入口验证未登录时不挂载 React 聊天。
- 提词器生产构建回归通过：Markdown、Shiki、锁顶、循环滚动、换轮清空和 Ctrl＋滚轮。
- 对打包使用的 Codex 执行真实只读 `account/read(refreshToken:false)`：成功返回 `account.type=chatgpt`、`requiresOpenaiAuth=true`。未退出用户账号，未在测试中进行实际浏览器授权；OAuth 回调交互仍需用户在未登录环境验收。
- **登录首页本身不解决 Cloudflare。** 先前转写请求已经有 Codex 的 ChatGPT 凭据，仍返回 `403 / cf-mitigated: challenge`。后续修正宿主 HTTP 传输、代理与请求契约后，当前账号真实转写已成功，详见 `DICTATION.md`；没有绕过验证或复制浏览器 Cookie，不能保证重登能解决所有拦截。
- 默认 ChatGPT 内部听写已分别通过显式代理、环境代理与 Windows 系统代理的合成音频实测，无需额外 API Key。独立的标准 OpenAI 转写 API 仍需要 API Key；没有把 Codex OAuth 当成该公开 API 的密钥，也没有做付费 API 实测。
- 不添加持久化诊断日志，不提交 Git。产物见 `packages/vscode/openchamber-2.1.5.vsix`。
