# Upstream boundary

Vcodex-Chamber reuses the MIT-licensed OpenChamber `packages/vscode`, `packages/ui`, `packages/web`, and `packages/sdk` source snapshot from [openchamber/openchamber](https://github.com/openchamber/openchamber). The imported VS Code changelog identifies the 2.1.0 baseline. The local snapshot did not retain a verified upstream commit SHA, so it must not be presented as an exact checkout of a named upstream commit.

The Codex adaptations live in `packages/vscode/src/codex`, `captureReceiver.ts`, the extension bridge, and related UI capability gates. WindowsSender is the project's own WinUI application. The bundled shared Web sources are retained to support imports; this release publishes only the VS Code extension and Windows sender.

Internal OpenChamber command IDs, storage keys and package names remain compatible. Product branding and release metadata belong to Vcodex-Chamber. Do not replace identity strings indiscriminately: changing the extension ID or queue paths would split user state.

The root MIT license records this project's contributors alongside the preserved OpenChamber/SDK notices. Original package licenses remain in `packages/vscode/LICENSE` and `packages/sdk/LICENSE`.

Generated Codex protocol sources are in `packages/vscode/src/codex/generated`; regenerate using the matching installed CLI instead of hand-editing:

```text
codex app-server generate-ts --experimental --out packages/vscode/src/codex/generated
```

Future upstream syncs should compare the source snapshot, update shared packages, and reconcile the bridge/facade changes. Do not reintroduce OpenCode startup or authentication into the Codex VS Code runtime.

Retained upstream Google quota adapters have no bundled OAuth credentials. Operators of those optional adapters must supply `VCODEX_GEMINI_GOOGLE_CLIENT_ID` / `VCODEX_GEMINI_GOOGLE_CLIENT_SECRET` or `VCODEX_ANTIGRAVITY_GOOGLE_CLIENT_ID` / `VCODEX_ANTIGRAVITY_GOOGLE_CLIENT_SECRET`. Missing credentials skip token refresh. Codex authentication and dictation do not use these adapters.
