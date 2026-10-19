<#
  dsh-grsai-canvas - portable installer.

  Installs the canvas plugin into a DSH home as a proper profile bundle:

    <dsh home>/profiles/node_modules/dsh-grsai-canvas        (the package, default)
    <dsh home>/profiles/<profile>/package.json              (dsh.profile.bundles += dsh-grsai-canvas)

  Resolution: dsh resolves a bundle name from the install anchor first, then from
  the profile directory. Node's lookup walks *up* from the profile, so a package
  under <dsh home>/profiles/node_modules is found - and that directory is never
  touched by `pnpm` (which runs inside the profile), so a later
  `dsh plugin ... install` cannot prune this install and leave dsh unable to
  boot. Use -ProfileLocal for the conventional per-profile location instead.

  No pnpm, no build step, no network. Everything the plugin needs is inside the
  package folder this script ships in.

  Usage:
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -DshHome D:\dsh-home
    powershell -ExecutionPolicy Bypass -File install.ps1 -ProfileLocal
    powershell -ExecutionPolicy Bypass -File install.ps1 -UsePnpm

  Then restart DSH (close the window and open it again).

  Uninstall with uninstall.ps1 (same -DshHome / -Profile parameters).
#>
[CmdletBinding()]
param(
    # DSH home directory. Defaults to $env:DSH_HOME, then %USERPROFILE%\.dsh
    [string]$DshHome,
    # Profile name under <dsh home>\profiles
    [string]$Profile = 'web',
    # Package folder to install. Defaults to the parent of this script's folder.
    [string]$Source,
    # Install into <profile>\node_modules instead of <dsh home>\profiles\node_modules
    [switch]$ProfileLocal,
    # Hand the install to `dsh plugin --profile <p> add <path>` (needs pnpm on PATH)
    [switch]$UsePnpm,
    # Overwrite an existing installation / ignore the patch-layer conflict warning
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-grsai-canvas'

function Write-Step($text) { Write-Host "[*] $text" }
function Write-Ok($text) { Write-Host "[ok] $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "[!] $text" -ForegroundColor Yellow }

# Windows PowerShell's `Set-Content -Encoding UTF8` writes a BOM, and dsh reads
# the profile manifest with JSON.parse - a BOM makes it refuse to boot. Always
# write UTF-8 without one.
function Write-Utf8NoBom($path, $text) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $encoding)
}
# `Get-Content -Raw` decodes as ANSI on Windows PowerShell 5.1, which mangles any
# non-ASCII already in the file (our own package.json description, for one) and
# makes ConvertFrom-Json fail. Always read UTF-8 explicitly; a BOM is stripped.
function Read-Utf8($path) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    return [System.IO.File]::ReadAllText($path, $encoding)
}

# Find the dsh entry point: the command on PATH first, then the global npm
# install, then the npx cache. Returns $null when nothing is installed.
function Find-DshBin {
    $command = Get-Command dsh -ErrorAction SilentlyContinue
    if ($command) { return @{ kind = 'command'; path = $command.Source } }
    $candidates = @()
    if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js') }
    if ($env:LOCALAPPDATA) {
        $npxRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
        if (Test-Path -LiteralPath $npxRoot) {
            $candidates += (Get-ChildItem -LiteralPath $npxRoot -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js' } |
                Where-Object { Test-Path -LiteralPath $_ } |
                Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime } -Descending)
        }
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return @{ kind = 'bin'; path = $candidate } }
    }
    return $null
}

# Create a missing profile the way dsh itself would: `--dump-config` composes the
# config, initializes the profile on first use, and exits without binding a port.
function Initialize-DshProfile($DshHome, $Profile) {
    $found = Find-DshBin
    if (-not $found) {
        Write-Warn2 'dsh is not installed (and not found in the npm/npx caches)'
        Write-Warn2 'install it once with:  npm i -g @deepseek-ai/dsh'
        return
    }
    $arguments = @()
    if ($found.kind -eq 'bin') {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) {
            Write-Warn2 'node is not on PATH, so dsh cannot be started to create the profile'
            return
        }
        $arguments += @($found.path)
    }
    if ($Profile -eq 'web') { $arguments += @('web', '--dump-config') }
    else { $arguments += @('--profile', $Profile, '--dump-config') }

    $previousHome = $env:DSH_HOME
    $env:DSH_HOME = $DshHome
    # Do NOT send dsh's output to $null: when it fails, that output is the only
    # clue the user would ever get. Keep it in a temp log, print the tail on error.
    $log = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-grsai-canvas-init.log'
    try {
        if ($found.kind -eq 'bin') { & $node.Source @arguments *> $log }
        else { & $found.path @arguments *> $log }
        if ($LASTEXITCODE -ne 0) { Write-Warn2 "dsh --dump-config exited with $LASTEXITCODE" }
    } catch {
        Write-Warn2 "could not run dsh to create the profile: $($_.Exception.Message)"
    } finally {
        if ($previousHome) { $env:DSH_HOME = $previousHome } else { Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue }
    }
    if (Test-Path -LiteralPath (Join-Path (Join-Path $DshHome 'profiles') "$Profile\package.json")) {
        Write-Ok "profile ""$Profile"" created by dsh"
    } else {
        Write-Warn2 "dsh did not create profile ""$Profile"""
        if (Test-Path -LiteralPath $log) {
            Write-Warn2 "--- last lines from dsh (full log: $log) ---"
            Get-Content -LiteralPath $log -Tail 12 | ForEach-Object { Write-Warn2 "    $_" }
        }
    }
}

# ---- locate the package folder ------------------------------------------------
if (-not $Source) { $Source = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path -LiteralPath (Join-Path $Source 'package.json'))) {
    throw "not a dsh-grsai-canvas package folder: $Source"
}
$pkg = Read-Utf8 (Join-Path $Source 'package.json') | ConvertFrom-Json
if ($pkg.name -ne $PackageName) {
    throw "expected package ""$PackageName"" in $Source, found ""$($pkg.name)"""
}
Write-Ok "package: $Source"

# ---- locate the DSH home and profile -----------------------------------------
if (-not $DshHome) {
    if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
if (-not (Test-Path -LiteralPath $DshHome)) {
    New-Item -ItemType Directory -Path $DshHome -Force | Out-Null
    Write-Step "created DSH home: $DshHome"
}
$ProfilesDir = Join-Path $DshHome 'profiles'
$ProfileDir = Join-Path $ProfilesDir $Profile
$ProfileManifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $ProfileManifestPath)) {
    # This machine has never run DSH: let dsh initialize the profile itself
    # (--dump-config only composes the config, it never binds a port).
    Write-Step "profile ""$Profile"" does not exist yet - asking dsh to initialize it"
    Initialize-DshProfile -DshHome $DshHome -Profile $Profile
}
if (-not (Test-Path -LiteralPath $ProfileManifestPath)) {
    throw @"
profile "$Profile" is still missing at $ProfileDir.
Open a terminal once and run:  dsh web   (then close it)
or pass -DshHome / -Profile if this DSH lives somewhere else.
"@
}
Write-Ok "dsh home: $DshHome"
Write-Ok "profile:  $ProfileDir"

# ---- refuse to double-install ------------------------------------------------
$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
if (Test-Path -LiteralPath $patchFile) {
    # Only look at EFFECTIVE yaml lines (skip comments). A comment that merely
    # mentions the plugin - "# grsai-canvas was installed here before" - must not
    # block a fresh install; the old whole-file substring match refused exactly
    # that case.
    $patchText = ((Read-Utf8 $patchFile) -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
    if ($patchText -match 'grsai-canvas') {
        if (-not $Force) {
            throw @"
this profile already loads the plugin through its own patch layer:
  $patchFile
DSH rejects the same package arriving from two active sources, so remove the
grsai-canvas row from that file first (or re-run with -Force).
"@
        }
        Write-Warn2 "cordis.patch.yml still mentions grsai-canvas - remove that row or DSH will refuse the client half"
    }
}

# ---- optional: the official pnpm-backed path ---------------------------------
if ($UsePnpm) {
    $dsh = Get-Command dsh -ErrorAction SilentlyContinue
    if (-not $dsh) { throw "dsh is not on PATH; drop -UsePnpm for the manual install" }
    Write-Step "dsh plugin --profile $Profile add $Source"
    # -DshHome has to reach dsh as well, otherwise this branch installs into the
    # default %USERPROFILE%\.dsh instead of the home the caller asked for.
    $previousHome = $env:DSH_HOME
    $env:DSH_HOME = $DshHome
    try {
        & $dsh.Source plugin --profile $Profile add $Source
        if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed (exit $LASTEXITCODE)" }
    } finally {
        if ($previousHome) { $env:DSH_HOME = $previousHome } else { Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue }
    }
    Write-Ok "installed through dsh plugin (pnpm)"
    Write-Host ''
    Write-Host "Restart DSH, then open the canvas tab and fill in your GrsAI APIKEY." -ForegroundColor Cyan
    exit 0
}

# ---- copy the package in ------------------------------------------------------
$sharedTarget = Join-Path (Join-Path $ProfilesDir 'node_modules') $PackageName
$localTarget = Join-Path (Join-Path $ProfileDir 'node_modules') $PackageName
if ($ProfileLocal) {
    $target = $localTarget
    $stale = $sharedTarget
} else {
    $target = $sharedTarget
    $stale = $localTarget
}
# ---- refuse to install from inside the directory we are about to delete -------
# install.ps1 copies the whole deploy\ folder into the install target, so running
# the copy that lives in <target>\deploy\ would default -Source to <target> itself:
# the script would delete the installation first and then fail to copy anything
# back, leaving an empty shell. Catch that before touching anything.
$sourceFull = (Resolve-Path -LiteralPath $Source).Path.TrimEnd('\')
$targetFull = [System.IO.Path]::GetFullPath($target).TrimEnd('\')
if ($sourceFull -ieq $targetFull) {
    throw @"
-source resolves to the install target itself:
  $sourceFull
That is the copy carried inside the installed package. Run install.cmd from the
delivery folder instead, or pass -Source <path of the package to install>.
"@
}

if (Test-Path -LiteralPath $target) {
    Write-Step "removing previous installation at $target"
    Remove-Item -LiteralPath $target -Recurse -Force
}
if (Test-Path -LiteralPath $stale) {
    Write-Step "removing the copy left in the other location: $stale"
    Remove-Item -LiteralPath $stale -Recurse -Force
}
# Copy the ENTIRE package folder, recursively, hidden files included.
#
# Do NOT go back to a hardcoded file list or to `Get-ChildItem -File` (which is
# NOT recursive): both silently drop files. That is exactly how lib\update.js
# went missing once and the installed copy failed to boot - and how the root
# install.cmd / uninstall.cmd got dropped, leaving users to double-click the
# deploy\ copy (which used to delete the very installation it lived in).
New-Item -ItemType Directory -Path $target -Force | Out-Null
Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
}
Write-Ok "package copied to $target"

# ---- register the bundle in the profile manifest -----------------------------
# Keep the FIRST backup: overwriting it on every run would leave "the previous
# state" already containing the plugin, so it could not restore a clean manifest.
if (-not (Test-Path -LiteralPath "$ProfileManifestPath.bak")) {
    Copy-Item -LiteralPath $ProfileManifestPath -Destination "$ProfileManifestPath.bak" -Force
}
$doc = Read-Utf8 $ProfileManifestPath | ConvertFrom-Json

$top = [ordered]@{}
foreach ($prop in $doc.PSObject.Properties) { $top[$prop.Name] = $prop.Value }
$dshBlock = [ordered]@{}
if ($doc.dsh) { foreach ($prop in $doc.dsh.PSObject.Properties) { $dshBlock[$prop.Name] = $prop.Value } }
$profileBlock = [ordered]@{}
if ($doc.dsh -and $doc.dsh.profile) { foreach ($prop in $doc.dsh.profile.PSObject.Properties) { $profileBlock[$prop.Name] = $prop.Value } }

$bundles = @()
if ($profileBlock['bundles']) { $bundles = @($profileBlock['bundles']) }
if ($bundles -contains $PackageName) {
    Write-Ok "already listed in dsh.profile.bundles"
} else {
    $profileBlock['bundles'] = @($bundles + $PackageName)
    $dshBlock['profile'] = $profileBlock
    $top['dsh'] = $dshBlock
    # -Depth 20 silently turns anything nested deeper into a string ("@{...}"),
    # which corrupts other plugins' config. 100 is the max PowerShell accepts.
    Write-Utf8NoBom $ProfileManifestPath ($top | ConvertTo-Json -Depth 100)
    Write-Ok "added ""$PackageName"" to dsh.profile.bundles (backup: $ProfileManifestPath.bak)"
}

# ---- verify the layout the Loader resolves against ---------------------------
$installedManifest = Join-Path $target 'package.json'
if (Test-Path -LiteralPath $installedManifest) {
    $installedName = (Read-Utf8 $installedManifest | ConvertFrom-Json).name
    if ($installedName -eq $PackageName) { Write-Ok "package present at $target" }
    else { Write-Warn2 "unexpected package name ""$installedName"" at $target" }
} else {
    Write-Warn2 "package manifest missing at $installedManifest"
}
foreach ($relative in @('lib\index.js', 'lib\client.js', 'lib\update.js', 'lib\parts', 'tools')) {
    if (-not (Test-Path -LiteralPath (Join-Path $target $relative))) { Write-Warn2 "missing: $relative" }
}
# Every file that lives beside index.js in the source must be installed too,
# otherwise a required module is missing and the host half fails to load.
$sourceLib = Join-Path $Source 'lib'
$targetLib = Join-Path $target 'lib'
if (Test-Path -LiteralPath $sourceLib) {
    Get-ChildItem -LiteralPath $sourceLib -File -ErrorAction SilentlyContinue | ForEach-Object {
        if (-not (Test-Path -LiteralPath (Join-Path $targetLib $_.Name))) { Write-Warn2 "missing file: lib\$($_.Name)" }
    }
}

# ---- image-layering skill:铺到 <dsh home>\skills\image-layering --------------
# 画布「图片分层(交给 Agent)」要的就是这个技能。插件包里自带一份(deploy\skill\),
# 这里顺手铺到本机 —— 用户填好的 config\*.json(APIMart / Recraft 的地址与密钥)永不覆盖。
$skillSrc = Join-Path $target 'deploy\skill\image-layering'
$skillDst = Join-Path (Join-Path $DshHome 'skills') 'image-layering'
if (Test-Path -LiteralPath (Join-Path $skillSrc 'SKILL.md')) {
    $kept = @{}
    foreach ($relative in @('config\apimart_config.json', 'config\recraft_config.json')) {
        $from = Join-Path $skillDst $relative
        if (Test-Path -LiteralPath $from) { $kept[$relative] = Read-Utf8 $from }
    }
    if (Test-Path -LiteralPath $skillDst) {
        $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
        $skillBackup = Join-Path (Join-Path $DshHome 'skills\.backup') "image-layering-$stamp"
        if (Test-Path -LiteralPath $skillBackup) { Remove-Item -LiteralPath $skillBackup -Recurse -Force }
        New-Item -ItemType Directory -Path (Split-Path -Parent $skillBackup) -Force | Out-Null
        Move-Item -LiteralPath $skillDst -Destination $skillBackup -Force
        Write-Step "previous skill backed up to $skillBackup"
    }
    New-Item -ItemType Directory -Path $skillDst -Force | Out-Null
    Get-ChildItem -LiteralPath $skillSrc -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $skillDst -Recurse -Force
    }
    foreach ($relative in $kept.Keys) {
        $to = Join-Path $skillDst $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force | Out-Null
        Write-Utf8NoBom $to $kept[$relative]
    }
    $skillVersion = (Read-Utf8 (Join-Path $skillDst 'VERSION')).Trim()
    Write-Ok "image-layering skill -> $skillDst (v$skillVersion)"
} else {
    Write-Warn2 "no bundled image-layering skill in this package, skipped"
}

# The skill itself is Python; remind instead of installing behind the user's back.
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Warn2 'python not found: image layering needs it (install Python 3.x, then: pip install -r <skill>\requirements.txt)'
} else {
    Write-Step "python: $($python.Source) - first run needs: pip install -r `"$skillDst\requirements.txt`""
}

Write-Host ''
Write-Host "Installed. Next:" -ForegroundColor Cyan
Write-Host "  1. restart DSH (close the window, start it again)"
Write-Host "  2. open the canvas tab: the bottom-left sidebar button, or the right sidebar guide page"
Write-Host "  3. Settings -> paste your GrsAI APIKEY -> Save"
Write-Host ''
Write-Host "Health check after the restart: http://127.0.0.1:3080/grsai-canvas/ping"
Write-Host "Uninstall: powershell -ExecutionPolicy Bypass -File uninstall.ps1"
