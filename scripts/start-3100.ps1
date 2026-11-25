$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $projectRoot '.local\config.json'
if (-not (Test-Path -LiteralPath $configFile)) { throw 'Run scripts\install-windows.ps1 first.' }
$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$node = Join-Path $config.runtimeRoot 'tools\node\node.exe'
& $node (Join-Path $PSScriptRoot 'start-windows.cjs')
if ($LASTEXITCODE -ne 0) { throw "Service exited: $LASTEXITCODE" }
