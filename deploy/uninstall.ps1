<#
  dsh-grsai-canvas - uninstaller.

  Drops the package from the profile's dsh.profile.bundles and deletes the copy
  under BOTH candidate locations (the shared <dsh home>\profiles\node_modules and
  the per-profile <profile>\node_modules), so it does not matter which one the
  installer used. Your APIKEY lives in the browser's localStorage, not on disk
  here, so nothing else is touched. Restart DSH afterwards.

  Usage:
    powershell -ExecutionPolicy Bypass -File uninstall.ps1
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -DshHome D:\dsh-home
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -KeepPackage
#>
[CmdletBinding()]
param(
    [string]$DshHome,
    [string]$Profile = 'web',
    # Leave the package folder in place, only unregister it
    [switch]$KeepPackage
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-grsai-canvas'

function Write-Step($text) { Write-Host "[*] $text" }
function Write-Ok($text) { Write-Host "[ok] $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "[!] $text" -ForegroundColor Yellow }

# See install.ps1: dsh reads the profile manifest with JSON.parse, so no BOM.
function Write-Utf8NoBom($path, $text) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $encoding)
}
# See install.ps1: `Get-Content -Raw` is ANSI on Windows PowerShell 5.1.
function Read-Utf8($path) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    return [System.IO.File]::ReadAllText($path, $encoding)
}

if (-not $DshHome) {
    if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
$ProfilesDir = Join-Path $DshHome 'profiles'
$ProfileDir = Join-Path $ProfilesDir $Profile
$ProfileManifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $ProfileManifestPath)) { throw "profile ""$Profile"" not found at $ProfileDir" }

# Keep the FIRST backup (see install.ps1): overwriting it every run would leave
# "the previous state" already containing the plugin.
if (-not (Test-Path -LiteralPath "$ProfileManifestPath.bak")) {
    Copy-Item -LiteralPath $ProfileManifestPath -Destination "$ProfileManifestPath.bak" -Force
}
$doc = Read-Utf8 $ProfileManifestPath | ConvertFrom-Json
$current = @()
if ($doc.dsh -and $doc.dsh.profile -and $doc.dsh.profile.bundles) { $current = @($doc.dsh.profile.bundles) }

if ($current -contains $PackageName) {
    $top = [ordered]@{}
    foreach ($prop in $doc.PSObject.Properties) { $top[$prop.Name] = $prop.Value }
    $dshBlock = [ordered]@{}
    foreach ($prop in $doc.dsh.PSObject.Properties) { $dshBlock[$prop.Name] = $prop.Value }
    $profileBlock = [ordered]@{}
    foreach ($prop in $doc.dsh.profile.PSObject.Properties) { $profileBlock[$prop.Name] = $prop.Value }
    $profileBlock['bundles'] = @($current | Where-Object { $_ -ne $PackageName })
    $dshBlock['profile'] = $profileBlock
    $top['dsh'] = $dshBlock
    # -Depth 20 turns anything nested deeper into a string ("@{...}") and would
    # corrupt other plugins' config; 100 is the max PowerShell accepts.
    Write-Utf8NoBom $ProfileManifestPath ($top | ConvertTo-Json -Depth 100)
    Write-Ok "removed ""$PackageName"" from dsh.profile.bundles (backup: $ProfileManifestPath.bak)"
} else {
    Write-Warn2 "not listed in dsh.profile.bundles"
}

$targets = @(
    (Join-Path (Join-Path $ProfilesDir 'node_modules') $PackageName),
    (Join-Path (Join-Path $ProfileDir 'node_modules') $PackageName)
)
foreach ($target in $targets) {
    if ($KeepPackage) {
        if (Test-Path -LiteralPath $target) { Write-Step "kept $target" }
    } elseif (Test-Path -LiteralPath $target) {
        # When this script runs from inside the folder it is deleting (the copy the
        # installer carries along), cmd.exe would fail to read the rest of its own
        # batch file. Hand the deletion to a short-lived helper that starts after
        # this process is gone.
        $resolved = (Resolve-Path -LiteralPath $target).Path
        $scriptRoot = $PSScriptRoot
        $insideTarget = $false
        if ($scriptRoot) {
            try {
                # Compare with a trailing separator: a sibling folder whose name
                # merely starts with the same characters is NOT "inside".
                $insideTarget = (($scriptRoot.TrimEnd('\') + '\').ToLower()).StartsWith(($resolved.TrimEnd('\') + '\').ToLower())
            } catch {
                $insideTarget = $false
            }
        }
        if ($insideTarget) {
            $command = 'ping -n 3 127.0.0.1 >nul & rmdir /s /q "' + $resolved + '"'
            Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $command -WindowStyle Hidden | Out-Null
            Write-Ok "deleting $target after this script exits (it lives inside it)"
        } else {
            Remove-Item -LiteralPath $target -Recurse -Force
            Write-Ok "deleted $target"
        }
    }
}

# Remove our own row from the profile patch layer.
#
# Leaving it behind used to be a dead end: install.ps1 refuses to install while a
# row is present, and this script only printed "delete those lines too" - so the
# user could neither uninstall cleanly nor reinstall, and had to hand-edit YAML.
# Comments are never touched (only effective lines are matched).
# NOTE: the patch layer identifies us as "grsai-canvas" (the *package* name is
# dsh-grsai-canvas), so match that row id - matching the package name misses it.
$patchRowId = 'grsai-canvas'
$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
if (Test-Path -LiteralPath $patchFile) {
    $lines = @((Read-Utf8 $patchFile) -split "`r?`n")
    $kept = New-Object System.Collections.ArrayList
    $removed = 0
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        $isComment = $line -match '^\s*#'
        if ((-not $isComment) -and ($line -match $patchRowId)) {
            $indent = ($line -replace '^(\s*).*$', '$1').Length
            $removed++
            # Also drop the lines belonging to this entry (deeper indent, not a new "- " item).
            while ($i + 1 -lt $lines.Count) {
                $next = $lines[$i + 1]
                if ($next -match '^\s*$') { break }
                if ($next -match '^\s*#') { break }
                $nextIndent = ($next -replace '^(\s*).*$', '$1').Length
                if ($nextIndent -le $indent) { break }
                $i++
                $removed++
            }
            continue
        }
        [void]$kept.Add($line)
    }

    if ($removed -gt 0) {
        # Drop an "- insert:" header that just lost every entry it had.
        $final = New-Object System.Collections.ArrayList
        for ($i = 0; $i -lt $kept.Count; $i++) {
            $line = $kept[$i]
            if ($line -match '^(\s*)-\s*insert:\s*$') {
                $headIndent = $Matches[1].Length
                $hasChild = $false
                for ($j = $i + 1; $j -lt $kept.Count; $j++) {
                    $probe = $kept[$j]
                    if (($probe -match '^\s*$') -or ($probe -match '^\s*#')) { continue }
                    # Only a DEEPER line counts as this header's child; a sibling
                    # "- insert:" at the same indent is the next entry, not a child.
                    $probeIndent = ($probe -replace '^(\s*).*$', '$1').Length
                    if ($probeIndent -gt $headIndent) { $hasChild = $true }
                    break
                }
                if (-not $hasChild) { continue }
            }
            [void]$final.Add($line)
        }
        [System.IO.File]::WriteAllText($patchFile, ($final -join "`n"), (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "removed $removed line(s) of $PackageName from cordis.patch.yml"
    }
}

Write-Host ''
Write-Host "Done. Restart DSH to unload the plugin." -ForegroundColor Cyan
