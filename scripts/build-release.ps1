param([string]$Version = '1.0.0')
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must be MAJOR.MINOR.PATCH' }
$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -LiteralPath (Join-Path $workspaceRoot 'packages/vscode/package.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne $Version) { throw 'Update the extension and sender versions before building a release' }
$senderProject = [xml](Get-Content -LiteralPath (Join-Path $workspaceRoot 'WindowsSender.WinUI/WindowsSender.WinUI.csproj') -Raw)
if ($senderProject.Project.PropertyGroup.Version -ne $Version) { throw 'Sender version does not match release' }
$releasePath = Join-Path $workspaceRoot "artifacts/v$Version"
$senderPath = Join-Path $releasePath 'windows-x64'
New-Item -ItemType Directory -Path $releasePath -Force | Out-Null
Push-Location $workspaceRoot
try {
    & bun run --cwd packages/vscode type-check
    if ($LASTEXITCODE -ne 0) { throw 'VS Code type check failed' }
    & bun run --cwd packages/ui type-check
    if ($LASTEXITCODE -ne 0) { throw 'Shared UI type check failed' }
    & node scripts/verify-windowssender.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Sender integration tests failed' }
    & node scripts/verify-dictation-transport.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Dictation transport tests failed' }
    & dotnet publish WindowsSender.WinUI/WindowsSender.WinUI.csproj --configuration Release --runtime win-x64 --self-contained true -p:Platform=x64 -o $senderPath
    if ($LASTEXITCODE -ne 0) { throw 'WinUI publication failed' }
    Push-Location packages/vscode
    try {
        & bun run package --out (Join-Path $releasePath "Vcodex-Chamber-$Version.vsix")
        if ($LASTEXITCODE -ne 0) { throw 'VSIX package failed' }
    } finally { Pop-Location }
    Copy-Item -LiteralPath LICENSE -Destination (Join-Path $senderPath 'LICENSE.txt')
    Copy-Item -LiteralPath docs/windowssender.md -Destination (Join-Path $senderPath 'README.md')
    & node scripts/package-release.mjs $Version
    if ($LASTEXITCODE -ne 0) { throw 'Release archive verification failed' }
    Write-Output "Release artifacts: $releasePath"
} finally { Pop-Location }
