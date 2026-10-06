param([string]$Version)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WindowsSender must be built on Windows' }
$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -LiteralPath (Join-Path $workspaceRoot 'packages/vscode/package.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $manifest.version }
if ($Version -notmatch '^\d+\.\d+\.\d+$' -or $Version -ne $manifest.version) { throw 'Version must match the extension MAJOR.MINOR.PATCH' }
$senderProject = [xml](Get-Content -LiteralPath (Join-Path $workspaceRoot 'WindowsSender.WinUI/WindowsSender.WinUI.csproj') -Raw)
if ($senderProject.Project.PropertyGroup.Version -ne $Version) { throw 'Sender version does not match release' }
$senderPath = Join-Path $workspaceRoot "artifacts/v$Version/windows-x64"
Push-Location $workspaceRoot
try {
    # Verify the generated path and every ancestor before clearing old publish output.
    & node --input-type=module -e "import {removeGenerated,root} from './scripts/lib/runtime-tools.mjs'; import {join} from 'node:path'; await removeGenerated(join(root,'artifacts','v$Version','windows-x64'),join(root,'artifacts'));"
    if ($LASTEXITCODE -ne 0) { throw 'Unsafe sender output directory' }
    & dotnet publish WindowsSender.WinUI/WindowsSender.WinUI.csproj --configuration Release --runtime win-x64 --self-contained true -p:Platform=x64 -o $senderPath
    if ($LASTEXITCODE -ne 0) { throw 'WinUI publication failed' }
    Copy-Item -LiteralPath LICENSE -Destination (Join-Path $senderPath 'LICENSE.txt')
    Copy-Item -LiteralPath docs/windowssender.md -Destination (Join-Path $senderPath 'README.md')
    & node scripts/package-release.mjs $Version --sender-only
    if ($LASTEXITCODE -ne 0) { throw 'WindowsSender archive failed' }
    Write-Output "WindowsSender distribution: $senderPath"
} finally { Pop-Location }
