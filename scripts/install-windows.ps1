param(
  [string]$AssetsDirectory = '',
  [string]$DataRoot = '',
  [ValidateRange(1024,65535)][int]$Port = 3100,
  [string]$ProxyUrl = ''
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
$localDir = Join-Path $projectRoot '.local'
New-Item -ItemType Directory -Path $localDir -Force | Out-Null
$configFile = Join-Path $localDir 'config.json'
$oldConfig = if (Test-Path -LiteralPath $configFile) { Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
if (-not $DataRoot) { $DataRoot = if ($oldConfig) { $oldConfig.dataRoot } else { Join-Path $projectRoot 'data' } }
if ($oldConfig -and -not $PSBoundParameters.ContainsKey('Port')) { $Port = $oldConfig.port }
if ($oldConfig -and -not $PSBoundParameters.ContainsKey('ProxyUrl')) { $ProxyUrl = $oldConfig.proxyUrl }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$runtimeRoot = Join-Path $projectRoot '.runtime'
$env:LUMA_DATA_ROOT = $DataRoot
$env:LUMA_RUNTIME_ROOT = $runtimeRoot
$env:NEXT_TELEMETRY_DISABLED = '1'
$env:PYTHONUTF8 = '1'
$vcRuntime = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
if (-not $vcRuntime -or $vcRuntime.Installed -ne 1) {
  $vcInstaller = Join-Path $projectRoot 'deployment\prerequisites\vc_redist.x64.exe'
  $vcManifest = Get-Content -LiteralPath (Join-Path $projectRoot 'deployment\prerequisites\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ((Get-FileHash -LiteralPath $vcInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $vcManifest.sha256) { throw 'Microsoft runtime installer checksum failed.' }
  $signature = Get-AuthenticodeSignature -LiteralPath $vcInstaller
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Microsoft Corporation*') { throw 'Microsoft runtime installer signature failed.' }
  Write-Host 'Installing bundled Microsoft Visual C++ x64 runtime (Windows may request administrator permission)...'
  $vcProcess = Start-Process -FilePath $vcInstaller -ArgumentList '/install','/passive','/norestart' -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  if ($vcProcess.ExitCode -notin @(0,1638,3010)) { throw "Microsoft runtime installation failed: $($vcProcess.ExitCode)" }
  if ($vcProcess.ExitCode -eq 3010) { throw 'Windows requires a restart. Restart this computer and run this installer again.' }
}
if ($ProxyUrl) {
  $env:HTTP_PROXY = $ProxyUrl; $env:HTTPS_PROXY = $ProxyUrl
  $env:NODE_USE_ENV_PROXY = '1'; $env:NO_PROXY = 'localhost,127.0.0.1,::1'
}
$release = Get-Content -LiteralPath (Join-Path $projectRoot 'deployment\release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $Port is in use. Stop that service or choose -Port 3200 before installing."
}
$cache = if ($AssetsDirectory) { [IO.Path]::GetFullPath($AssetsDirectory) } else { Join-Path $localDir 'downloads' }
New-Item -ItemType Directory -Path $cache -Force | Out-Null

function Assert-Hash([string]$File, [string]$Expected) {
  if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected.ToLowerInvariant()) { throw "SHA256 verification failed: $File" }
}
function Invoke-Checked([string]$Exe, [string[]]$Arguments) {
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Command failed: $Exe (exit $LASTEXITCODE)" }
}

$savedGhToken = $env:GH_TOKEN
$savedGitPrompt = $env:GIT_TERMINAL_PROMPT
$savedGcmInteractive = $env:GCM_INTERACTIVE
try {
  $missing = @($release.archives | ForEach-Object { $_.parts } | Where-Object { -not (Test-Path -LiteralPath (Join-Path $cache $_.name)) })
  if ($missing.Count -gt 0) {
    if ($AssetsDirectory) { throw 'The specified asset folder is incomplete. Download every part listed in deployment/release.json.' }
    $gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
    if (-not $gh) {
      $gh = Join-Path $localDir 'gh\bin\gh.exe'
      if (-not (Test-Path -LiteralPath $gh)) {
        $ghZip = Join-Path $localDir 'github-cli.zip'
        Write-Host 'Downloading official GitHub CLI...'
        Invoke-WebRequest -UseBasicParsing -Uri $release.githubCli.url -OutFile $ghZip
        Assert-Hash $ghZip $release.githubCli.sha256
        Expand-Archive -LiteralPath $ghZip -DestinationPath (Join-Path $localDir 'gh') -Force
      }
    }
    if (-not $env:GH_TOKEN -and (Get-Command git -ErrorAction SilentlyContinue)) {
      $env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never'
      $credentialLines = $null
      try { $credentialLines = "protocol=https`nhost=github.com`nusername=subrahoos`n`n" | & git credential fill 2>$null } catch { $credentialLines = $null }
      if ($LASTEXITCODE -eq 0) {
        $credential = $credentialLines | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
        if ($credential) { $env:GH_TOKEN = $credential.Substring(9) }
      }
      $credential = $null; $credentialLines = $null
    }
    & $gh auth status --hostname github.com *> $null
    if ($LASTEXITCODE -ne 0) { Invoke-Checked $gh @('auth','login','--hostname','github.com','--git-protocol','https','--web') }
    foreach ($part in $missing) {
      Write-Host "Downloading $($part.name)..."
      Invoke-Checked $gh @('release','download',$release.tag,'--repo',$release.repository,'--pattern',$part.name,'--dir',$cache,'--clobber')
    }
  }
} finally {
  $env:GH_TOKEN = $savedGhToken; $env:GIT_TERMINAL_PROMPT = $savedGitPrompt; $env:GCM_INTERACTIVE = $savedGcmInteractive
}

foreach ($archive in $release.archives) {
  Write-Host "Checking and assembling $($archive.name)..."
  $zip = Join-Path $localDir $archive.name
  $output = [IO.File]::Open($zip,[IO.FileMode]::Create,[IO.FileAccess]::Write)
  try {
    foreach ($part in $archive.parts) {
      $source = Join-Path $cache $part.name
      Assert-Hash $source $part.sha256
      $inputStream = [IO.File]::OpenRead($source)
      try { $inputStream.CopyTo($output) } finally { $inputStream.Dispose() }
    }
  } finally { $output.Dispose() }
  Assert-Hash $zip $archive.sha256
  $destination = if ($archive.target -eq 'runtime') { $runtimeRoot } else { $projectRoot }
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Write-Host "Extracting $($archive.name)..."
  # Windows 10/11's built-in bsdtar avoids Expand-Archive's legacy path limits.
  Invoke-Checked 'tar.exe' @('-xf',$zip,'-C',$destination)
  Remove-Item -LiteralPath $zip -Force
}
$node = Join-Path $runtimeRoot 'tools\node\node.exe'
Push-Location $projectRoot
try {
  Invoke-Checked $node @('scripts/configure-runtime.cjs')
  Invoke-Checked $node @('scripts/verify-install.cjs')
  $dbFile = Join-Path $DataRoot 'system\sqlite.db'
  if ((-not (Test-Path -LiteralPath $dbFile) -or (Get-Item -LiteralPath $dbFile).Length -eq 0) -and -not $env:LUMA_ADMIN_PASSWORD) {
    $password = Read-Host 'Set a NEW administrator password (minimum 12 characters)' -AsSecureString
    $confirm = Read-Host 'Repeat the administrator password' -AsSecureString
    $plain = [Net.NetworkCredential]::new('', $password).Password
    if ($plain -ne [Net.NetworkCredential]::new('', $confirm).Password) { throw 'Passwords do not match.' }
    if ($plain.Length -lt 12) { throw 'The administrator password must contain at least 12 characters.' }
    $env:LUMA_ADMIN_PASSWORD = $plain
    $plain = $null; $password = $null; $confirm = $null
  }
  Invoke-Checked $node @('scripts/initialize-database.cjs')
  $keyFile = Join-Path $DataRoot 'system\model-credential-encryption.key'
  $env:LUMA_CREDENTIAL_ENCRYPTION_KEY = (Get-Content -LiteralPath $keyFile -Raw).Trim()
  Write-Host 'Building the complete application (Webpack)...'
  Invoke-Checked $node @('node_modules/next/dist/bin/next','build','--webpack')
  $config = @{ dataRoot=$DataRoot; runtimeRoot=$runtimeRoot; port=$Port; secureCookies=$false; proxyUrl=$ProxyUrl }
  [IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
} finally {
  Pop-Location
  Remove-Item Env:LUMA_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:LUMA_CREDENTIAL_ENCRYPTION_KEY -ErrorAction SilentlyContinue
}
Write-Host "Installed. Username: admin. Start with scripts\start-3100.ps1, then open http://127.0.0.1:$Port"
Write-Host "Local data: $DataRoot"
