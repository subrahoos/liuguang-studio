param([Parameter(Mandatory = $true)][string[]]$Paths)
$ErrorActionPreference = 'Stop'
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$resolvedPaths = foreach ($targetPath in $Paths) {
  $target = [IO.Path]::GetFullPath($targetPath).TrimEnd('\')
  $driveRoot = [IO.Path]::GetPathRoot($target).TrimEnd('\')
  $forbidden = @($driveRoot, $env:USERPROFILE, $env:WINDIR, $env:ProgramFiles, ${env:ProgramFiles(x86)})
  if (-not $target -or $target -in $forbidden) { throw "Refusing to change permissions on a system root: $target" }
  if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw "Application directory does not exist: $target" }
  $item = Get-Item -LiteralPath $target -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing a linked application directory: $target" }
  $target
}
foreach ($target in $resolvedPaths) {
  $acl = Get-Acl -LiteralPath $target
  # Inherited child permissions follow this root; explicit child grants are
  # retained, and should be audited separately for manually modified installs.
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($existing in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($existing) }
  foreach ($sidText in @('S-1-5-18', 'S-1-5-32-544')) {
    $sid = [System.Security.Principal.SecurityIdentifier]::new($sidText)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.SetAccessRule($rule)
  }
  $ownerRule = [System.Security.AccessControl.FileSystemAccessRule]::new($currentSid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.SetAccessRule($ownerRule)
  Set-Acl -LiteralPath $target -AclObject $acl
}
