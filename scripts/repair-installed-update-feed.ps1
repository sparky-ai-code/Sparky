[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot,

  [ValidateSet('windows', 'macos-arm64', 'macos-x64')]
  [string]$Platform = 'windows'
)

$resolvedRoot = (Resolve-Path -LiteralPath $InstallRoot -ErrorAction Stop).Path
$resourcesPath = Join-Path $resolvedRoot 'resources'
if (-not (Test-Path -LiteralPath $resourcesPath -PathType Container)) {
  throw "Sparky resources directory was not found under '$resolvedRoot'."
}

$feedPath = switch ($Platform) {
  'windows' { 'https://sparky.llc/get/updates/windows' }
  'macos-arm64' { 'https://sparky.llc/get/updates/macos/arm64' }
  'macos-x64' { 'https://sparky.llc/get/updates/macos/x64' }
}

$targetPath = Join-Path $resourcesPath 'app-update.yml'
if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
  Copy-Item -LiteralPath $targetPath -Destination "$targetPath.bak" -Force
}

$content = @"
provider: generic
url: $feedPath
updaterCacheDirName: sparky-desktop-updater
"@

Set-Content -LiteralPath $targetPath -Value $content -Encoding utf8 -NoNewline
Write-Output "Wrote Sparky updater feed: $targetPath"
Write-Output "Restart Sparky, then use Settings > Check for Updates."
