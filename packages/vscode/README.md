# Vcodex-Chamber for VS Code

Codex coding chat with paired Windows screenshots, dictation and a Markdown teleprompter. The UI is based on MIT-licensed [OpenChamber](https://github.com/openchamber/openchamber); model operations use Codex CLI app-server.

Install the VSIX from [Vcodex-Chamber Releases](https://github.com/voidcode100/Vcodex-Chamber/releases). Windows x64 release builds include Codex CLI. Install the official **Codex Audio** extension for microphone capture, then sign in through the Codex login page.

Open the **Vcodex-Chamber** sidebar. Its settings include **WindowsSender 与 Codex 提词器** for HTTPS pairing and session routing. Commands are grouped under **Vcodex-Chamber**; **Open Teleprompter** opens the current reply in an editor-area panel.

WindowsSender stages screenshots in the composer and submits a batch with a separate hotkey. Voice controls use the VS Code client's microphone and automatically submit the transcription after stop. Configure a shared session prompt when creating a chat. Occupied sessions remain readable with the composer hidden.

The internal extension ID remains `fedaykindev.openchamber` for existing session/queue compatibility; this GitHub build is an independent fork, not an official OpenChamber or OpenAI release. When replacing a higher-numbered development build, install with `code --install-extension Vcodex-Chamber-1.0.0.vsix --force`.

See the [repository README](https://github.com/voidcode100/Vcodex-Chamber#readme), [WindowsSender guide](https://github.com/voidcode100/Vcodex-Chamber/blob/main/docs/windowssender.md), and [dictation evidence](https://github.com/voidcode100/Vcodex-Chamber/blob/main/packages/vscode/DICTATION.md).

## Development

From the repository root: `bun install --frozen-lockfile`, `bun run type-check`, `bun run dev`. Build both release artifacts with `powershell -NoProfile -File scripts/build-release.ps1` on Windows.

MIT. Original OpenChamber copyright is preserved in [LICENSE](LICENSE).
