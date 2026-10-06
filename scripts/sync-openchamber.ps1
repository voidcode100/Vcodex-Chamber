param(
  [string]$Ref = "main",
  [string]$Repository = "https://github.com/openchamber/openchamber.git"
)

$ErrorActionPreference = "Stop"
$temp = Join-Path $env:TEMP "capture-codex-openchamber-sync"
if (Test-Path $temp) { Remove-Item -Recurse -Force $temp }
git clone --filter=blob:none --sparse $Repository $temp
git -C $temp sparse-checkout set packages/vscode packages/ui packages/web packages/sdk package.json bun.lock
git -C $temp checkout $Ref
Copy-Item "$temp/packages/vscode" "packages/vscode" -Recurse -Force
Copy-Item "$temp/packages/ui" "packages/ui" -Recurse -Force
Copy-Item "$temp/packages/web" "packages/web" -Recurse -Force
Copy-Item "$temp/packages/sdk" "packages/sdk" -Recurse -Force
Write-Host "OpenChamber snapshot synchronized. Re-run codex app-server generate-ts and review OPENCHAMBER_SYNC.md boundaries."
