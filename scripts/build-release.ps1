param([string]$Version)
$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -LiteralPath (Join-Path $workspaceRoot 'packages/vscode/package.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $manifest.version }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must be MAJOR.MINOR.PATCH' }
if ($manifest.version -ne $Version) { throw 'Update the extension and sender versions before building a release' }
$senderProject = [xml](Get-Content -LiteralPath (Join-Path $workspaceRoot 'WindowsSender.WinUI/WindowsSender.WinUI.csproj') -Raw)
if ($senderProject.Project.PropertyGroup.Version -ne $Version) { throw 'Sender version does not match release' }
$releasePath = Join-Path $workspaceRoot "artifacts/v$Version"
New-Item -ItemType Directory -Path $releasePath -Force | Out-Null
Push-Location $workspaceRoot
try {
    & bun run --cwd packages/vscode type-check
    if ($LASTEXITCODE -ne 0) { throw 'VS Code type check failed' }
    & bun run --cwd packages/ui type-check
    if ($LASTEXITCODE -ne 0) { throw 'Shared UI type check failed' }
    & bun run test:packaging
    if ($LASTEXITCODE -ne 0) { throw 'Packaging/resolver tests failed' }
    & node scripts/verify-windowssender.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Sender integration tests failed' }
    & node scripts/verify-dictation-transport.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Dictation transport tests failed' }
    & node scripts/build-arm-audio-vsix.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Standalone ARM Audio packaging failed' }
    & node scripts/build-vsix.mjs --target all
    if ($LASTEXITCODE -ne 0) { throw 'Platform VSIX packaging failed' }
    & bun run test:ui
    if ($LASTEXITCODE -ne 0) { throw 'Browser regressions failed' }
    & (Join-Path $PSScriptRoot 'build-windowssender.ps1') -Version $Version
    & node scripts/package-release.mjs $Version --collect-only --runtime-manifest artifacts/build/codex-runtime.json
    if ($LASTEXITCODE -ne 0) { throw 'Release archive verification failed' }
    Write-Output "Release artifacts: $releasePath"
} finally { Pop-Location }
