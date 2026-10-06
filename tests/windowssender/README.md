# WindowsSender integration harness

This console project links the production capture service, settings and hotkey state machine. It is test code, not another sender application.

Run `node scripts/verify-windowssender.mjs` from the repository root on Windows. The Node suite launches the harness against a temporary HTTPS/WSS receiver, using synthetic PNGs and controlled Codex/voice responses. No microphone access or real Codex turn is required.

Build outputs go to `artifacts/build` and `artifacts/test/windowssender`; they are ignored by Git and are not release assets.
