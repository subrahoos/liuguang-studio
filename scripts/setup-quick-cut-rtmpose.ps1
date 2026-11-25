param(
  [string]$DataRoot = $(if ($env:LUMA_DATA_ROOT) { $env:LUMA_DATA_ROOT } else { 'D:\3100' })
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'runtime-assets\rtmpose-manifest.json') -Raw | ConvertFrom-Json
$visionRoot = Join-Path $DataRoot 'quick-cut\runtime\fashion-vision'
$python = Join-Path $visionRoot 'python\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw '先安装女装视觉分析的隔离 Python 环境。' }
$modelRoot = Join-Path $visionRoot 'models'
$modelFolder = Join-Path $modelRoot 'rtmpose-s'
New-Item -ItemType Directory -Path $modelFolder -Force | Out-Null
$model = Get-ChildItem -LiteralPath $modelFolder -Recurse -File -Filter '*.onnx' | Select-Object -First 1
if (-not $model) {
  $archive = Join-Path ([System.IO.Path]::GetTempPath()) ('luma-rtmpose-' + [guid]::NewGuid().ToString() + '.zip')
  try {
    Invoke-WebRequest -Uri $manifest.source -OutFile $archive -UseBasicParsing
    Expand-Archive -LiteralPath $archive -DestinationPath $modelFolder -Force
  } finally { Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue }
  $model = Get-ChildItem -LiteralPath $modelFolder -Recurse -File -Filter '*.onnx' | Select-Object -First 1
}
if (-not $model -or (Get-FileHash -LiteralPath $model.FullName).Hash.ToLowerInvariant() -ne $manifest.sha256) {
  throw 'RTMPose 权重 SHA256 校验失败，未启用新模型。'
}
$packages = Join-Path $visionRoot 'rtmpose-packages'
& $python -m pip install --target $packages --no-deps "rtmlib==$($manifest.rtmlib)" "onnxruntime==$($manifest.onnxruntime)"
if ($LASTEXITCODE -ne 0) { throw 'RTMPose 隔离依赖安装失败。' }
$readyFile = Join-Path $modelRoot 'READY.json'
$ready = Get-Content -LiteralPath $readyFile -Raw | ConvertFrom-Json
# Store portable paths; running this setup never changes the active backend.
$relative = $model.FullName.Substring($modelRoot.TrimEnd('\').Length + 1)
$ready | Add-Member -NotePropertyName rtmpose -NotePropertyValue ([pscustomobject]@{
  path=$relative; sha256=$manifest.sha256; source=$manifest.source; license=$manifest.license;
  rtmlib=$manifest.rtmlib; onnxruntime=$manifest.onnxruntime
}) -Force
[IO.File]::WriteAllText($readyFile, ($ready | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
Write-Output 'RTMPose 已准备并校验；现有后端未改变。通过真实素材对照后，再设置 READY.json 的 poseBackend 为 rtmpose。'
