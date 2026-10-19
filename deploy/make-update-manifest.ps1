# ============================================================================
#  dsh-grsai-canvas -- build the update manifest (version.json)
#
#  Usage (run from the plugin folder, i.e. the parent of deploy\):
#     powershell -ExecutionPolicy Bypass -File deploy\make-update-manifest.ps1 `
#          -Zip dsh-grsai-canvas-vX.Y.Z.zip `
#          -Base https://your-site/grsai `
#          -NotesFile notes.txt
#
#  What it does: sha256 of the zip -> read version -> write version.json
#  (UTF-8 without BOM). Upload BOTH files, then paste the FULL url of
#  version.json into the canvas: Settings -> (3) plugin update.
#
#  Keep this file PURE ASCII: Windows PowerShell 5.1 reads UTF-8 scripts as
#  ANSI and would garble any Chinese text. For Chinese release notes use
#  -NotesFile (it is read as UTF-8), not -Notes.
# ============================================================================
[CmdletBinding()]
param(
  [string]$Zip = '',
  [string]$Base = '',
  [string]$Notes = '',
  [string]$NotesFile = '',
  [string]$Version = '',
  [string]$Out = '',
  # Write a RELATIVE url (just the zip file name). Recommended: the plugin
  # resolves it against the manifest url, so the same version.json works on any
  # domain / sub-directory without regenerating.
  [switch]$Relative
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

if (-not $Zip) {
  $cand = Get-ChildItem -Path $root -Filter 'dsh-grsai-canvas-v*.zip' -File | Sort-Object LastWriteTime -Descending
  if (-not $cand) {
    throw "No zip found under $root. Build one first: Compress-Archive -Path dsh-grsai-canvas -DestinationPath dsh-grsai-canvas-vX.Y.Z.zip -Force"
  }
  $Zip = $cand[0].FullName
}
# Test first: Resolve-Path throws its own ItemNotFoundException for a missing
# file, which made the friendly message below unreachable.
if (-not (Test-Path -LiteralPath $Zip)) { throw "Zip not found: $Zip" }
$Zip = (Resolve-Path -LiteralPath $Zip).Path

# Version: from -Version, else from the plugin package.json
if (-not $Version) {
  $pkgPath = Join-Path $root 'dsh-grsai-canvas\package.json'
  if (-not (Test-Path $pkgPath)) { $pkgPath = Join-Path $root 'package.json' }
  if (-not (Test-Path $pkgPath)) { throw 'Cannot find package.json to read the version from - pass -Version' }
  $pkg = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $Version = [string]$pkg.version
}
if ($Version -notmatch '^\d+(\.\d+)*') { throw "Bad version: $Version" }

# If the zip name carries a version, warn when it disagrees (wrong package?)
$nameMatch = [regex]::Match((Split-Path -Leaf $Zip), 'v(\d+(\.\d+)*)')
if ($nameMatch.Success -and $nameMatch.Groups[1].Value -ne $Version) {
  Write-Warning ("Zip name says v" + $nameMatch.Groups[1].Value + " but package.json says " + $Version + " - double check which package you publish.")
}

if ($NotesFile) {
  if (-not (Test-Path $NotesFile)) { throw "NotesFile not found: $NotesFile" }
  $Notes = [System.IO.File]::ReadAllText((Resolve-Path $NotesFile).Path, [System.Text.Encoding]::UTF8)
}

$hash = (Get-FileHash -Path $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
$bytes = (Get-Item $Zip).Length

# Relative url: when the manifest sits next to the zip, only the file name is
# needed; the plugin resolves it against the manifest url.
$zipName = Split-Path -Leaf $Zip
$baseTrim = $Base.TrimEnd('/')
if ($baseTrim -match '\.json$') {
  # Guard the LastIndexOf: "-Base version.json" (no slash) used to throw
  # "Length cannot be less than zero" from Substring(0, -1).
  $slash = $baseTrim.LastIndexOf('/')
  if ($slash -lt 0) {
    throw "-Base looks like a manifest FILE, not a directory: $Base`nPass -Base <https://site/dir>, or use -Relative."
  }
  $baseTrim = $baseTrim.Substring(0, $slash)
}
if ($Relative) {
  $zipUrl = $zipName
} elseif ($baseTrim) {
  $zipUrl = ($baseTrim + '/' + $zipName)
} else {
  throw 'Pass -Base <https://site/dir> for an absolute url, or -Relative to write just the file name.'
}

$manifest = [ordered]@{
  version = $Version
  url     = $zipUrl
  sha256  = $hash
  bytes   = $bytes
  notes   = $Notes
}

if (-not $Out) { $Out = Join-Path (Split-Path -Parent $Zip) 'version.json' }
$json = ($manifest | ConvertTo-Json -Depth 4)
[System.IO.File]::WriteAllText($Out, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host '[ok] manifest written:' -ForegroundColor Green
Write-Host ('     ' + $Out)
Write-Host ''
Write-Host ('     version : ' + $Version)
Write-Host ('     sha256  : ' + $hash)
Write-Host ('     bytes   : ' + $bytes)
Write-Host ('     url     : ' + $manifest.url + $(if ($Relative) { '   (relative: works on any domain/dir)' } else { '' }))
Write-Host ''
Write-Host 'Upload BOTH files to the same folder:' -ForegroundColor Cyan
Write-Host ('     1) ' + $zipName)
Write-Host '     2) version.json'
Write-Host ''
Write-Host 'Then in the canvas: Settings -> (3) plugin update -> paste the FULL url of version.json'
Write-Host ''
