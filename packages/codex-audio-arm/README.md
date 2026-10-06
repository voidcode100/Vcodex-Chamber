# Vcodex Audio ARM

Standalone Linux ARM64 microphone extension for Vcodex-Chamber. This is an MIT adapter built with public PvRecorder (Apache-2.0) and miniaudio sources, not an official Codex Audio distribution.

Install `Vcodex-Audio-ARM-<version>-linux-arm64.vsix` in the local VS Code desktop together with the Linux ARM64 Vcodex-Chamber VSIX. Reload the window. The adapter captures PCM16 in memory only; Vcodex-Chamber keeps its existing shared Codex login and cloud transcription. No separate login, model, network endpoint or token storage is added here.

On x64 use the official `openai.codex-audio` extension. Vcodex-Chamber prefers official Audio when it supports the host; otherwise its local Linux ARM64 router activates this companion using `_vcodex.audio.available/start/read/stop/cancel`. Command names are distinct, so the two extensions cannot overwrite each other. Remote workspaces never silently record their server microphone.

Requires a desktop microphone through PulseAudio/PipeWire or ALSA and glibc. Loopback monitor sources are excluded by default. Set `vcodexAudio.inputDevice` to an exact device name if needed (`native/linux-arm64/recorder --list-devices`). The old `captureCodex.voice.inputDevice` remains a compatibility fallback.

Build on Linux ARM64: `node scripts/build-arm-audio-vsix.mjs`. Cross-platform packaging accepts a verified native cache in `artifacts/arm-audio/linux-arm64`, or `ARM_AUDIO_CC` pointing to a Linux ARM64 cross compiler. See `docs/builds.md` for provenance and release checks.
