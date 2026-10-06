# Vcodex-Chamber for VS Code

Codex coding chat with paired Windows screenshots, dictation and a Markdown teleprompter. The UI is based on MIT-licensed [OpenChamber](https://github.com/openchamber/openchamber); model operations use Codex CLI app-server.

Install the VSIX from [Vcodex-Chamber Releases](https://github.com/voidcode100/Vcodex-Chamber/releases) matching your extension host: `win32-x64`, `win32-arm64`, `linux-x64` or `linux-arm64`. Each platform build includes the complete matching official Codex runtime. Linux packages use the upstream musl runtime directly; this project does not publish deb/rpm packages. ARM means ARM64, not ARMv7. For Remote SSH, match the remote host. The original v1.0.0 generic VSIX is Windows x64 only. Install the official **Codex Audio** extension for microphone capture, then sign in through the Codex login page.

Open the **Vcodex-Chamber** sidebar. Its settings include **WindowsSender 与 Codex 提词器** for HTTPS pairing and session routing. Commands are grouped under **Vcodex-Chamber**; **Open Teleprompter** opens the current reply in an editor-area panel.

Builds resolve and audit the latest stable official Codex Audio release; VS Code installs and updates it through Marketplace. Audio captures PCM locally; transcription is handled by the existing dictation transport. The audited Audio 26.930.61225 requires VS Code 1.96.2 or later and has no native Linux ARM64 recorder. On a local ARM Linux desktop, this build uses the separately installed Vcodex Audio ARM companion, built from public PvRecorder sources. Install `Vcodex-Audio-ARM-<version>-linux-arm64.vsix` alongside the client; no recorder is embedded in the client. It excludes loopback monitor inputs; select a specific device with the user setting `vcodexAudio.inputDevice` (names from `native/linux-arm64/recorder --list-devices`). Remote workspaces use official Audio on a supported local UI host and never record the server microphone.

WindowsSender stages screenshots in the composer and submits a batch with a separate hotkey. Voice controls use the VS Code client's microphone and automatically submit the transcription after stop. Configure a shared session prompt when creating a chat. Occupied sessions remain readable with the composer hidden.

The internal extension ID remains `fedaykindev.openchamber` for existing session/queue compatibility; this GitHub build is an independent fork, not an official OpenChamber or OpenAI release. When replacing a higher-numbered development build, install with `code --install-extension Vcodex-Chamber-1.0.0.vsix --force`.

See the [repository README](https://github.com/voidcode100/Vcodex-Chamber#readme), [WindowsSender guide](https://github.com/voidcode100/Vcodex-Chamber/blob/main/docs/windowssender.md), and [dictation evidence](https://github.com/voidcode100/Vcodex-Chamber/blob/main/packages/vscode/DICTATION.md).

## Development

From the repository root: `bun install --frozen-lockfile`, `bun run type-check`, `bun run dev`. Use Node 24 and Bun 1.3.14. `bun run vscode:package:all` creates all four VSIX files; `node scripts/build-vsix.mjs --target linux-arm64` builds a selected platform. Build independent Audio with `node scripts/build-arm-audio-vsix.mjs`; client-only packaging needs no C compiler or microphone cache. Cross-platform Audio builders need a verified `artifacts/arm-audio/linux-arm64` cache built with `node scripts/build-arm-audio.mjs`, or an `ARM_AUDIO_CC` cross compiler. WindowsSender is Windows x64 only; build the full distribution with `powershell -NoProfile -File scripts/build-release.ps1` on Windows. See [builds and GitHub Actions](https://github.com/voidcode100/Vcodex-Chamber/blob/main/docs/builds.md).

MIT. Original OpenChamber copyright is preserved in [LICENSE](LICENSE).
