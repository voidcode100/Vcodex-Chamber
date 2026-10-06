# Delete only reviewed generated files, then empty directories. No recursive deletion.
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$generatedPaths = @('WindowsSender', 'WindowsSender.Tests', 'WindowsSender.WinUI/artifacts', 'WindowsSender.WinUI/bin', 'WindowsSender.WinUI/obj', 'dist', 'dist-test', '.tmp', 'tests/windowssender/bin', 'tests/windowssender/obj')
foreach ($relativePath in $generatedPaths) {
    $candidatePath = [IO.Path]::GetFullPath((Join-Path $workspaceRoot $relativePath))
    if (!$candidatePath.StartsWith($workspaceRoot + [IO.Path]::DirectorySeparatorChar)) { throw 'Cleanup path escaped workspace' }
    if (!(Test-Path -LiteralPath $candidatePath)) { continue }
    $rootItem = Get-Item -LiteralPath $candidatePath -Force
    $items = @(Get-ChildItem -LiteralPath $candidatePath -Recurse -Force)
    if (@($rootItem) + $items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw "Linked path in $relativePath; refusing cleanup" }
    $files = @($items | Where-Object { !$_.PSIsContainer })
    Write-Output "$relativePath : $($files.Count) generated files"
    if ($Apply) {
        foreach ($file in $files) { Remove-Item -LiteralPath $file.FullName -Force }
        foreach ($directory in ($items | Where-Object PSIsContainer | Sort-Object { $_.FullName.Length } -Descending)) { Remove-Item -LiteralPath $directory.FullName -Force }
        Remove-Item -LiteralPath $candidatePath -Force
    }
}
