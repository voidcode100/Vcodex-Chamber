# Bundled Codex CLI

The VSIX bundles an unmodified official Codex CLI platform runtime. By default,
`scripts/build-vsix.mjs` resolves the latest stable GitHub release and obtains
the exact corresponding official npm platform archives and SHA-512 metadata.
One resolved manifest is shared by every target in a build/Actions run; it is
included with the distribution as `codex-runtime.json`. `--codex-version` or
`--runtime-manifest` permits explicit version selection and reproduction.
`scripts/codex-runtime.json` is an explicit, known-good offline fallback used
only with `--codex-version pinned`, never a silent replacement for latest.
The build validates archive SHA-512 integrity and
PE/ELF architecture, and preserves its `bin/`, `codex-resources/`, `codex-path/`
layout, helpers and upstream third-party licenses. Windows/Linux x64 and ARM64
are separate VSIX targets; Linux uses the portable musl build.

`codex-package.json` preserves upstream layout fields and adds the VSIX target,
source URL/integrity, executable file list and resource SHA-256 hashes. Linux
execute permissions are explicitly preserved even when packaging on NTFS.
The runtime itself is not rebuilt or patched. See `docs/builds.md` for updating
the pin and for native/distribution smoke tests.

Source: https://github.com/openai/codex

The LICENSE (Apache-2.0) and NOTICE here were obtained from that repository on
2026-10-06 and are copied into the VSIX alongside the executable. They apply
to Codex, independently of Vcodex-Chamber's MIT license. A future runtime
upgrade must review the upstream license and notices again.
