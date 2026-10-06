# Bundled Codex CLI

The VSIX bundles an unmodified Codex CLI runtime found by `scripts/stage-codex-binary.mjs`.
`codex-package.json` records its actual version, target and file SHA-256 hashes.

Source: https://github.com/openai/codex

The LICENSE (Apache-2.0) and NOTICE here were obtained from that repository on
2026-10-06 and are copied into the VSIX alongside the executable. They apply
to Codex, independently of Vcodex-Chamber's MIT license. A future runtime
upgrade must review the upstream license and notices again.
