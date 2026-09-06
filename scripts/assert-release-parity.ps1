[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$ArtifactRoot
)

$packageFiles = @(
    'apps/server/package.json',
    'apps/desktop/package.json',
    'apps/web/package.json',
    'packages/contracts/package.json'
)

$mismatches = [System.Collections.Generic.List[string]]::new()
$cargoToml = Join-Path $RepoRoot 'Cargo.toml'
$cargoVersion = Select-String -Path $cargoToml -Pattern '^version\s*=\s*"([^"]+)"' |
    Select-Object -First 1 -ExpandProperty Matches |
    Select-Object -ExpandProperty Groups |
    Where-Object Name -eq 1 |
    Select-Object -ExpandProperty Value
if ($cargoVersion -ne $ExpectedVersion) {
    $mismatches.Add("Cargo.toml: expected $ExpectedVersion, found $cargoVersion")
}

foreach ($relativePath in $packageFiles) {
    $path = Join-Path $RepoRoot $relativePath
    $manifest = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
    if ($manifest.version -ne $ExpectedVersion) {
        $mismatches.Add("$relativePath`: expected $ExpectedVersion, found $($manifest.version)")
    }
}

$cargoLock = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'Cargo.lock')
foreach ($packageName in @('sparky_agent', 'sparky_ai', 'sparky_cli', 'sparky_compaction', 'sparky_config', 'sparky_extensions', 'sparky_prompt', 'sparky_session', 'sparky_tools')) {
    $escapedName = [regex]::Escape($packageName)
    $pattern = '(?ms)\[\[package\]\]\s+name = "' + $escapedName + '"\s+version = "([^"]+)"'
    $match = [regex]::Match($cargoLock, $pattern)
    if (-not $match.Success -or $match.Groups[1].Value -ne $ExpectedVersion) {
        $found = if ($match.Success) { $match.Groups[1].Value } else { '<missing>' }
        $mismatches.Add("Cargo.lock/$packageName`: expected $ExpectedVersion, found $found")
    }
}

if ($ArtifactRoot) {
    $requiredArtifacts = @('Sparky-x64.exe', 'Sparky-x64.exe.blockmap', 'latest.yml')
    foreach ($artifact in $requiredArtifacts) {
        if (-not (Test-Path -LiteralPath (Join-Path $ArtifactRoot $artifact))) {
            $mismatches.Add("ArtifactRoot: missing $artifact")
        }
    }
}

if ($mismatches.Count -gt 0) {
    $mismatches | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Output "Release parity OK: $ExpectedVersion"
