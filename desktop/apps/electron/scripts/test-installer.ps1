<#
.SYNOPSIS
  Native Windows assertions for the Bridgic Agent NSIS installer.

.DESCRIPTION
  Everything here guards a failure mode that is SILENT on Windows: an update that
  relocates an existing installation, an autostart opt-out that comes back by
  itself, a user's --port reset to the default, a daemon that gets
  TerminateProcess'd instead of stopped. None of these throw, none show up in
  unit tests, and several of them only surface at the user's next login.

  Isolation: the backend's data root is hard-coded to `Path.home() / ".bridgic"`
  (src/amphi_service/server/_manager.py) with no override variable, and
  Path.home() resolves USERPROFILE on Windows — so redirecting USERPROFILE is
  what keeps a test run out of the real profile. AMPHI_USER_DIR covers the
  desktop app's own directory, which is a different thing.

  What CANNOT be isolated: HKCU (the Run value, the user PATH, the install
  registration). Those are per-user, not per-process. Hence the -Force guard: on
  a developer machine this really does install Bridgic Agent and really does rewrite your
  PATH.

.PARAMETER Installer
  Path to the built Setup .exe. Required for every scenario except ConfigOnly.

.PARAMETER Scenario
  Which check to run. See the switch at the bottom for the list.

.PARAMETER Force
  Required outside CI, because the HKCU side effects above are not sandboxed.

.EXAMPLE
  pwsh -File test-installer.ps1 -ConfigOnly
  pwsh -File test-installer.ps1 -Installer .\release\Bridgic-Agent-0.1.0-x64.exe -Scenario Fresh
#>
[CmdletBinding()]
param(
  [string]$Installer,
  [ValidateSet(
    'Fresh',
    'Repair',
    'NoRelocateOnReinstall',
    'RejectsTooLongPath',
    'GracefulStop',
    'PathIdempotence',
    'AutostartOptOutSurvives',
    'AutostartArgsSurvive',
    'GuiAutostartLegacyMigration',
    'GuiAutostartOptOutSurvives',
    'GuiAutostartPathRepaired',
    'GuiAutostartStartupApprovedOptOut',
    'UninstallRetainsData',
    'ReleaseArtifacts'
  )]
  [string]$Scenario,
  [switch]$ConfigOnly,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
$ConfigPath = Join-Path $ElectronDir 'electron-builder.yml'
$InstallerNsh = Join-Path $ElectronDir 'build/installer.nsh'
$LanguagesNsh = Join-Path $ElectronDir 'build/installer-languages.nsh'
$ReleaseDir = Join-Path $ElectronDir 'release'

$DaemonRunValueName = 'Amphi Daemon'
$GuiRunValueName = 'Bridgic Agent'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$GuiAutostartStateKey = 'HKCU:\Software\Amphi'
$GuiAutostartMarkerName = 'GuiAutostartMigrated'
$StartupApprovedRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'

# ─────────────────────────────────────────────────────────────────────────────
# Static configuration assertions (no install required)
# ─────────────────────────────────────────────────────────────────────────────

function Assert-InstallerConfiguration {
  $text = Get-Content -Raw $ConfigPath
  if ($text -notmatch 'oneClick:\s*false') { throw 'NSIS must remain assisted (oneClick: false)' }
  if ($text -notmatch 'perMachine:\s*false') { throw 'NSIS must remain per-user (perMachine: false)' }
  if ($text -notmatch 'allowElevation:\s*false') {
    throw 'allowElevation must be false: the "for all users" option installs into Program Files and breaks the HKCU autostart/PATH model'
  }
  if ($text -match 'allowToChangeInstallationDirectory:\s*true') {
    throw 'The directory page is owned by customPageAfterChangeDir; electron-builder''s own page skips only on --updated and would let a manual over-install relocate an existing installation'
  }
  if ($text -notmatch 'appId:\s*ai\.bridgic\.agent') {
    throw 'appId is frozen: INSTALL_REGISTRY_KEY is Software\<UUIDv5 of appId>, so changing it makes every existing installation invisible to the new installer'
  }
  if ($text -notmatch '\$\{version\}') {
    throw 'artifactName must carry ${version}: the generic update provider addresses artifacts by filename'
  }
  Write-Host '  ok: installer configuration'
}

function Assert-InstallerLanguages {
  $text = Get-Content -Raw $ConfigPath
  if ($text -notmatch 'multiLanguageInstaller:\s*true') { throw 'NSIS must be multilingual' }
  if ($text -notmatch 'installerLanguages:\s*\[en_US, zh_CN\]') { throw 'P0 installer languages must be en_US and zh_CN' }
  if ($text -notmatch 'displayLanguageSelector:\s*false') { throw 'Installer must follow the Windows UI language, not ask' }
  Write-Host '  ok: installer languages'
}

function Assert-LangStringsInCustomHeader {
  # Our include lands in the shared script header, BEFORE `!insertmacro addLangs`
  # emits the MUI_LANGUAGE directives that define ${LANG_ENGLISH}. A LangString at
  # file scope therefore references an undefined language id, and makensis runs
  # with -WX, so it is a hard build failure. customHeader expands after addLangs.
  $nsh = Get-Content -Raw $InstallerNsh
  if ($nsh -match '(?m)^\s*LangString\s') {
    throw 'LangString at file scope in installer.nsh — move it inside !macro customHeader'
  }
  if ($nsh -notmatch '!macro customHeader') { throw 'installer.nsh is missing the customHeader macro' }
  if ($nsh -notmatch 'installer-languages\.nsh') { throw 'customHeader does not include installer-languages.nsh' }
  if (-not (Test-Path $LanguagesNsh)) { throw "missing $LanguagesNsh" }

  $lang = Get-Content -Raw $LanguagesNsh
  $ids = [regex]::Matches($lang, '(?m)^LangString\s+(\w+)\s+\$\{LANG_(\w+)\}') |
    ForEach-Object { [pscustomobject]@{ Id = $_.Groups[1].Value; Lang = $_.Groups[2].Value } }
  $byId = $ids | Group-Object Id
  foreach ($group in $byId) {
    $langs = @($group.Group | ForEach-Object { $_.Lang } | Sort-Object)
    if (($langs -join ',') -ne 'ENGLISH,SIMPCHINESE') {
      throw "LangString $($group.Name) is not defined for both languages (got: $($langs -join ', ')). A half-translated wizard is worse than an English one."
    }
  }
  Write-Host "  ok: $($byId.Count) LangString ids defined in both languages"
}

function Assert-MessageBoxDefaults {
  # electron-updater installs with /S. NSIS still SHOWS a MessageBox in silent
  # mode unless a /SD default is given, so a missing one turns a silent update
  # into a modal dialog nobody is watching.
  foreach ($path in @($InstallerNsh, $LanguagesNsh)) {
    foreach ($match in [regex]::Matches((Get-Content -Raw $path), '(?m)^\s*MessageBox[^\r\n]*')) {
      if ($match.Value -notmatch '/SD\s+ID') {
        throw "MessageBox without a /SD default in ${path}: $($match.Value.Trim())"
      }
    }
  }
  Write-Host '  ok: every MessageBox has a /SD default'
}

function Assert-AutostartContracts {
  # There are intentionally two Run values with different owners:
  #
  #   Amphi Daemon  -> Python CLI owns configurable argv; NSIS may only restore
  #                    the exact pre-update snapshot before asking CLI to repair.
  #                    Keeps the pre-rename name on purpose (see installer.nsh).
  #   Bridgic Agent -> NSIS owns one fixed, quoted `Bridgic Agent.exe --background` argv.
  #
  # Mixing those contracts would either reset a user's daemon --port or create
  # duplicate/inconsistent GUI login commands.
  $code = ((Get-Content $InstallerNsh) -notmatch '^\s*;') -join "`n"
  $writes = @([regex]::Matches($code, '(?m)^[^\r\n]*WriteRegStr[^\r\n]*CurrentVersion\\Run[^\r\n]*'))
  $daemonWrites = @($writes | Where-Object { $_.Value -match '"Amphi Daemon"' })
  if ($daemonWrites.Count -ne 1 -or $daemonWrites[0].Value -notmatch '\$amHadRunValue') {
    throw 'the daemon Run value must have exactly one NSIS write, restoring only $amHadRunValue for CLI repair'
  }

  $guiWrites = @($writes | Where-Object { $_.Value -match '"Bridgic Agent"' -and $_.Value -notmatch '"Amphi Daemon"' })
  if ($guiWrites.Count -ne 1) {
    throw "the GUI Run value must have exactly one canonical writer (found $($guiWrites.Count))"
  }
  $actualGuiWrite = ($guiWrites[0].Value -replace '\s+', ' ').Trim()
  $expectedGuiWrite = 'WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bridgic Agent" ''"$INSTDIR\Bridgic Agent.exe" --background'''
  if ($actualGuiWrite -cne $expectedGuiWrite) {
    throw "GUI autostart command is not the quoted canonical value: $actualGuiWrite"
  }

  $unexpectedWrites = @($writes | Where-Object {
    $_.Value -notmatch '"Amphi Daemon"' -and $_.Value -notmatch '"Bridgic Agent"'
  })
  if ($unexpectedWrites.Count -ne 0) {
    throw "unexpected Run-key writer: $($unexpectedWrites[0].Value.Trim())"
  }

  if ($code -notmatch 'server autostart repair') {
    throw 'installer.nsh does not call `amphi server autostart repair`'
  }

  $nsh = Get-Content -Raw $InstallerNsh
  foreach ($required in @(
    '!define AM_GUI_AUTOSTART_STATE_KEY "Software\Amphi"',
    '!define AM_GUI_AUTOSTART_MARKER_NAME "GuiAutostartMigrated"',
    'Var amHadGuiRunValue',
    'Var amHadGuiMarker',
    'Var amDaemonStartupApproved',
    'ReadRegStr $amHadGuiRunValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bridgic Agent"',
    'ReadRegStr $amHadGuiMarker HKCU "${AM_GUI_AUTOSTART_STATE_KEY}" "${AM_GUI_AUTOSTART_MARKER_NAME}"',
    'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run',
    '${ElseIf} $amHadRunValue == ""',
    '${ElseIf} $amDaemonStartupApproved != "0"',
    '${AndIf} $amDaemonStartupApproved != "2"',
    '${AndIf} $amDaemonStartupApproved != "255"',
    '${If} $amDaemonStartupApproved == "255"',
    '${ElseIf} $amHadGuiMarker == ""',
    '${ElseIf} $amHadGuiRunValue != ""',
    'WriteRegStr HKCU "${AM_GUI_AUTOSTART_STATE_KEY}" "${AM_GUI_AUTOSTART_MARKER_NAME}" "1"',
    'DeleteRegValue HKCU "${AM_GUI_AUTOSTART_STATE_KEY}" "${AM_GUI_AUTOSTART_MARKER_NAME}"',
    'DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Bridgic Agent"'
  )) {
    if (-not $nsh.Contains($required)) {
      throw "installer.nsh is missing GUI autostart lifecycle contract: $required"
    }
  }
  Write-Host '  ok: daemon and GUI Run values keep separate writer/lifecycle contracts'
}

function Assert-ReleaseArtifacts {
  # electron-updater's entry point is latest.yml, and differential download needs
  # the .blockmap sidecar. Building the .exe alone produces an update feed that
  # can never be consumed.
  if (-not (Test-Path $ReleaseDir)) { throw "no release directory at $ReleaseDir" }
  $exe = Get-ChildItem $ReleaseDir -Filter '*.exe' | Select-Object -First 1
  if (-not $exe) { throw 'no installer .exe was produced' }
  if ($exe.Name -notmatch '\d+\.\d+\.\d+') {
    throw "artifact has no version in its name ($($exe.Name)); one origin could then host only a single release"
  }
  foreach ($required in @('latest.yml')) {
    if (-not (Test-Path (Join-Path $ReleaseDir $required))) { throw "missing update metadata: $required" }
  }
  if (-not (Get-ChildItem $ReleaseDir -Filter '*.exe.blockmap')) {
    throw 'missing .blockmap — every update would fall back to a full download of the whole payload'
  }
  Write-Host '  ok: release artifacts complete'
}

# ─────────────────────────────────────────────────────────────────────────────
# Helpers for the install scenarios
# ─────────────────────────────────────────────────────────────────────────────

# Where the NSIS installer's install.log actually lands. NSIS resolves its
# $LOCALAPPDATA constant through the User Shell Folders registry value —
# %USERPROFILE%\AppData\Local, REG_EXPAND_SZ — expanded with the INSTALLER
# process's environment. The installer inherits this script's redirected
# USERPROFILE, so under the sandbox the log lands in <sandbox home>\AppData\
# Local\Amphi, not the real %LOCALAPPDATA% (verified on CI: the sandbox tree
# grew home\AppData\Local\* while the real location stayed empty).
function Get-AmphiInstallLog {
  param([string]$Name = 'install.log')
  $candidates = @(
    (Join-Path $env:USERPROFILE ('AppData\Local\Amphi\' + $Name)),
    (Join-Path $env:LOCALAPPDATA ('Amphi\' + $Name))
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function Get-AmphiUninstallEntry {
  # INSTALL_REGISTRY_KEY is Software\<UUIDv5 of appId>, not Software\ai.bridgic.agent
  # (NsisTarget.js: UUID.v5(appInfo.id, ELECTRON_BUILDER_NS_UUID)), so the GUID is
  # discovered rather than hard-coded.
  Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
    Where-Object { $_.PSObject.Properties.Name -contains 'DisplayName' -and $_.DisplayName -like 'Bridgic Agent*' } |
    Select-Object -First 1
}

# StrictMode makes reading an absent registry value a terminating error, so
# every property on these PSCustomObjects goes through this.
function Get-RegValue {
  param($Entry, [string]$Name)
  if ($Entry -and $Entry.PSObject.Properties.Name -contains $Name) { return $Entry.$Name }
  return $null
}

function Get-AmphiUninstallString {
  $entry = Get-AmphiUninstallEntry
  $value = Get-RegValue $entry 'UninstallString'
  if (-not $value) { return $null }
  # The stored value is `"C:\...\Uninstall Bridgic Agent.exe" /currentuser`
  # (templates/include/installer.nsh:122) — a quoted path FOLLOWED BY ARGUMENTS.
  # Trim('"') only strips quotes at the ends, so the embedded `" /currentuser`
  # tail survived into every path derived from this value: InstallLocation came
  # out wrong and Start-Process was handed a file that does not exist.
  if ($value -match '^"([^"]+)"') { return $Matches[1] }
  return ($value -split ' ')[0]
}

function Get-AmphiInstallLocation {
  # NOT read from the uninstall entry: electron-builder writes InstallLocation
  # only to Software\<GUID> (templates/include/installer.nsh:104); the uninstall
  # key carries DisplayName/UninstallString but no InstallLocation (:119-123).
  # The uninstaller always lives directly in $INSTDIR, so its parent IS the
  # install location — and this needs no knowledge of the GUID.
  $uninstaller = Get-AmphiUninstallString
  if (-not $uninstaller) { return $null }
  return Split-Path -Parent $uninstaller
}

function Get-AmphiRunValue {
  $item = Get-ItemProperty $RunKey -ErrorAction SilentlyContinue
  if (-not $item) { return $null }
  if ($item.PSObject.Properties.Name -notcontains $DaemonRunValueName) { return $null }
  return $item.$DaemonRunValueName
}

function Get-AmphiGuiRunValue {
  $item = Get-ItemProperty $RunKey -ErrorAction SilentlyContinue
  if (-not $item) { return $null }
  if ($item.PSObject.Properties.Name -notcontains $GuiRunValueName) { return $null }
  return $item.$GuiRunValueName
}

function Get-GuiAutostartMarker {
  $item = Get-ItemProperty $GuiAutostartStateKey -ErrorAction SilentlyContinue
  if (-not $item) { return $null }
  if ($item.PSObject.Properties.Name -notcontains $GuiAutostartMarkerName) { return $null }
  return $item.$GuiAutostartMarkerName
}

function Test-GuiStartupApprovedValue {
  $item = Get-ItemProperty $StartupApprovedRunKey -ErrorAction SilentlyContinue
  return [bool]($item -and $item.PSObject.Properties.Name -contains $GuiRunValueName)
}

function Invoke-WithDaemonStartupApprovedStatus {
  param(
    [ValidateSet(2, 3)]
    [byte]$Status,
    [scriptblock]$Action
  )
  # StartupApproved is real per-user state, not sandboxable. Preserve it exactly
  # around scenarios that need deterministic enabled/disabled semantics.
  $originalItem = Get-ItemProperty $StartupApprovedRunKey -ErrorAction SilentlyContinue
  $hadOriginal = $originalItem -and $originalItem.PSObject.Properties.Name -contains $DaemonRunValueName
  $originalValue = if ($hadOriginal) { [byte[]]($originalItem.$DaemonRunValueName) } else { $null }
  New-Item -Path $StartupApprovedRunKey -Force | Out-Null
  New-ItemProperty -Path $StartupApprovedRunKey -Name $DaemonRunValueName -PropertyType Binary `
    -Value ([byte[]]($Status, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)) -Force | Out-Null

  try {
    & $Action
  }
  finally {
    if ($hadOriginal) {
      New-ItemProperty -Path $StartupApprovedRunKey -Name $DaemonRunValueName -PropertyType Binary `
        -Value $originalValue -Force | Out-Null
    } else {
      Remove-ItemProperty -Path $StartupApprovedRunKey -Name $DaemonRunValueName -ErrorAction SilentlyContinue
    }
  }
}

function Get-AmphiPathEntries {
  param([string]$InstallDir)
  # StrictMode makes a missing `Path` value a hard error, and a profile that never
  # had a user PATH genuinely has none.
  $env_key = Get-ItemProperty 'HKCU:\Environment' -ErrorAction SilentlyContinue
  $raw = if ($env_key -and $env_key.PSObject.Properties.Name -contains 'Path') { $env_key.Path } else { $null }
  if (-not $raw) { return , @() }
  $want = (Join-Path $InstallDir 'resources\bin').TrimEnd('\')
  # `, @(...)` — without the leading comma PowerShell unrolls a zero-element array
  # to $null, and `$null.Count` throws under StrictMode. That would fail the
  # uninstall assertion exactly when the uninstaller had done the right thing.
  return , @($raw -split ';' | Where-Object { $_.TrimEnd('\') -ieq $want })
}

function Invoke-Installer {
  param([string]$TargetDir)
  # /D must be the LAST argument and unquoted (NSIS parses the raw command line),
  # so the whole argument string is passed verbatim rather than as an array that
  # PowerShell would re-quote.
  $arguments = if ($TargetDir) { "/S /D=$TargetDir" } else { '/S' }
  $attempt = 0
  while ($true) {
    $attempt++
    $started = Get-Date
    $process = Start-Process -FilePath $Installer -ArgumentList $arguments -Wait -PassThru
    $elapsed = [int]((Get-Date) - $started).TotalSeconds
    # Deliberately NOT asserting on the exit code — an interactive cancel also
    # returns 0 — but LOGGING it is the discriminator when an install dies early:
    # NSIS exits 2 on a script Abort under /S, 1 on cancel, 0 on success. A
    # sub-10s "install" of a ~300 MB payload cannot have extracted anything, so
    # call that out rather than letting the file assertions report a bare
    # "missing Bridgic Agent.exe" with no hint of why.
    Write-Host "  installer exit=$($process.ExitCode) elapsed=${elapsed}s"
    if ($elapsed -lt 10) {
      Write-Host "  WARNING: installer exited after ${elapsed}s - it cannot have extracted the payload; exit=$($process.ExitCode) (2 = script Abort under /S)" -ForegroundColor Yellow
    }
    # A negative exit code is an NTSTATUS — the installer PROCESS crashed, it did
    # not Abort. Seen once on CI: 0xC0000005 after the same exe had installed
    # cleanly eleven times in the same job (run 31152955039), most plausibly a
    # collision with the previous scenario's uninstaller still winding down in
    # %TEMP%. That is environmental, so retry once; a deterministic crash will
    # crash again and still fail the scenario. Positive codes (Abort/cancel) are
    # real answers and are returned to the caller unretried.
    if ($process.ExitCode -ge 0 -or $attempt -ge 2) { return $process.ExitCode }
    Write-Host "  installer crashed (NTSTATUS $($process.ExitCode)); retrying once in 10s" -ForegroundColor Yellow
    Start-Sleep -Seconds 10
  }
}

function Invoke-Uninstaller {
  $uninstaller = Get-AmphiUninstallString
  if (-not $uninstaller) { throw 'no uninstaller registered' }
  $installDir = Get-AmphiInstallLocation

  # Deliberately NOT `_?=`. That switch makes NSIS run in place, which also means
  # it cannot delete its own Uninstall exe or $INSTDIR — so the uninstall would
  # "succeed" while leaving the whole tree behind, and UninstallRetainsData could
  # no longer catch the leftover-install bug it exists for.
  #
  # Without it NSIS copies itself to %TEMP% and the process we launched returns
  # in milliseconds, so -Wait proves nothing. Poll for the observable end state
  # instead of sleeping a guessed interval.
  # /currentuser first — that is what electron-builder's own QuietUninstallString
  # passes (installer.nsh:123), and it skips the uninstaller's install-mode probing.
  Start-Process -FilePath $uninstaller -ArgumentList '/currentuser', '/S' | Out-Null

  $probe = if ($installDir) { Join-Path $installDir 'Bridgic Agent.exe' } else { $null }
  if ($probe) {
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
      if (-not (Test-Path $probe) -and -not (Get-AmphiUninstallEntry)) { break }
    }
  }
  # customUnInstall sleeps 800ms after its taskkill calls; leave the OS a moment
  # past that to release handles before anything asserts on the directory.
  Start-Sleep -Seconds 2
}

function Get-AmphiCli {
  param([string]$InstallDir)
  return Join-Path $InstallDir 'resources\bin\amphi.exe'
}

$script:TestRoot = $null

function Initialize-Sandbox {
  if (-not $Force -and -not $env:CI) {
    throw @'
This scenario installs Bridgic Agent and rewrites HKCU (Run value, user PATH, install
registration). Those are per-user and cannot be sandboxed. Re-run with -Force if
that is what you want.
'@
  }
  # Short on purpose. The installer refuses an $INSTDIR over 80 chars
  # (AM_INSTDIR_MAX_LEN), and a descriptive prefix plus a full 32-char GUID eats
  # most of that before $env:TEMP is even prepended — on a GitHub runner that
  # alone put every scenario over the cap, so all of them failed with "missing
  # Bridgic Agent.exe" and nothing said why. 8 hex chars is plenty of collision
  # resistance for a directory that lives for one job.
  #
  # The 2026-08 rename spends 8 more of that budget ("Bridgic Agent" vs
  # "Amphi"), so there is less slack here than the original 62-char-threshold
  # era — do not lengthen the prefix.
  $suffix = ([guid]::NewGuid().ToString('N')).Substring(0, 8)
  $script:TestRoot = Join-Path $env:TEMP "amphi-e2e-$suffix"
  New-Item -ItemType Directory -Path $script:TestRoot -Force | Out-Null
  # NOT $home: that is a read-only PowerShell automatic variable and assigning to
  # it throws.
  $sandboxHome = Join-Path $script:TestRoot 'home'
  New-Item -ItemType Directory -Path $sandboxHome -Force | Out-Null
  # Redirect the daemon's data root. NEVER delete the real %USERPROFILE%\.bridgic.
  $env:USERPROFILE = $sandboxHome
  $env:AMPHI_USER_DIR = Join-Path $sandboxHome '.bridgic\amphi'
  Write-Host "  sandbox: $script:TestRoot"
}

function Remove-Sandbox {
  param([switch]$KeepForDiagnostics)
  if (-not $script:TestRoot -or -not (Test-Path $script:TestRoot)) { return }
  if ($KeepForDiagnostics) {
    # Leave it for the workflow's artifact upload. Deleting it in `finally` meant
    # the diagnostics steps ran against a directory that no longer existed, so the
    # artifact was always empty and the whole failure path was dead code.
    Write-Host "  sandbox kept for diagnostics: $script:TestRoot"
    return
  }
  Remove-Item -LiteralPath $script:TestRoot -Recurse -Force -ErrorAction SilentlyContinue
}

function New-DataSentinel {
  # NOTE ON WHAT THIS CAN AND CANNOT PROVE.
  #
  # It proves the uninstaller has no code path that walks ~/.bridgic — a real
  # regression risk, since `deleteAppDataOnUninstall` is on and someone could
  # plausibly "extend" it to the user data directory.
  #
  # It does NOT prove much about path resolution: NSIS resolves $PROFILE through
  # the shell, not through the USERPROFILE we redirect, so the sentinel and
  # anything the uninstaller might delete are not guaranteed to be the same
  # directory. Asserting on the real profile instead would mean writing into the
  # developer's actual data directory, which is worse.
  $sentinel = Join-Path $env:USERPROFILE '.bridgic\AmphiAgent\e2e-sentinel.txt'
  New-Item -ItemType Directory -Path (Split-Path -Parent $sentinel) -Force | Out-Null
  Set-Content -Path $sentinel -Value 'user data must survive' -Encoding utf8
  return $sentinel
}

# ─────────────────────────────────────────────────────────────────────────────
# Scenarios
# ─────────────────────────────────────────────────────────────────────────────

function Test-Fresh {
  # A space in the path is the point of this directory name: NSIS /D= parsing and
  # every quoted command line we generate have to survive one. Kept short because
  # AM_INSTDIR_MAX_LEN is 80 and the runner's %TEMP% plus the sandbox name
  # already spend ~57 of it.
  $target = Join-Path $script:TestRoot 'P F\Amphi'
  Invoke-Installer -TargetDir $target | Out-Null

  foreach ($relative in @('Bridgic Agent.exe', 'resources\bin\amphi.exe', 'resources\bin\_internal', 'resources\release-manifest.json')) {
    $path = Join-Path $target $relative
    if (-not (Test-Path $path)) { throw "fresh install is missing $relative" }
  }

  $location = Get-AmphiInstallLocation
  if (-not $location) { throw 'no InstallLocation was registered' }
  if ($location.TrimEnd('\') -ine $target.TrimEnd('\')) {
    throw "InstallLocation is $location, expected $target"
  }

  $run = Get-AmphiRunValue
  if (-not $run) { throw 'fresh install did not register autostart' }
  if ($run -notlike "*amphi-autostart.exe*") { throw "Run value does not point at the windowless shim: $run" }

  $guiRun = Get-AmphiGuiRunValue
  $expectedGuiRun = '"' + (Join-Path $target 'Bridgic Agent.exe') + '" --background'
  if ($guiRun -cne $expectedGuiRun) {
    throw "fresh install GUI autostart is not canonical: got '$guiRun', expected '$expectedGuiRun'"
  }
  if ((Get-GuiAutostartMarker) -cne '1') {
    throw 'fresh install did not write the fixed GUI autostart migration marker'
  }

  $paths = Get-AmphiPathEntries -InstallDir $target
  if ($paths.Count -ne 1) { throw "expected exactly one PATH entry, got $($paths.Count)" }

  $log = Get-AmphiInstallLog
  if (-not $log) { throw 'installer did not write install.log (checked sandbox home and the real LOCALAPPDATA)' }

  Write-Host '  ok: fresh install'
  return $target
}

function Test-Repair {
  $target = Test-Fresh
  $before = Get-AmphiInstallLocation
  Invoke-Installer | Out-Null
  $after = Get-AmphiInstallLocation
  if ($before -ne $after) { throw "repair moved the installation: $before -> $after" }
  if (-not (Test-Path (Join-Path $target 'Bridgic Agent.exe'))) { throw 'repair removed the product executable' }
  Write-Host '  ok: repair keeps the installation in place'
}

function Test-NoRelocateOnReinstall {
  $target = Test-Fresh
  # A second run WITHOUT /D. electron-builder's own directory-page skip keys off
  # --updated, which a manual over-install does not set, so this is exactly the
  # path that used to be able to produce two parallel installations.
  Invoke-Installer | Out-Null
  $after = Get-AmphiInstallLocation
  if ($after.TrimEnd('\') -ine $target.TrimEnd('\')) {
    throw "reinstall relocated the installation: $target -> $after"
  }
  $paths = Get-AmphiPathEntries -InstallDir $target
  if ($paths.Count -ne 1) { throw "reinstall left $($paths.Count) PATH entries" }
  Write-Host '  ok: reinstall stays in place'
}

function Test-RejectsTooLongPath {
  # MAX_PATH overruns do not report themselves — they surface as DLL load
  # failures and bare ENOENTs deep inside the bundled runtimes.
  $long = Join-Path $script:TestRoot ('x' * 120)
  Invoke-Installer -TargetDir $long | Out-Null
  if (Test-Path (Join-Path $long 'Bridgic Agent.exe')) {
    throw "installer accepted a $($long.Length)-char install directory"
  }
  Write-Host '  ok: over-long install directory refused'
}

function Test-GracefulStop {
  $target = Test-Fresh
  $cli = Get-AmphiCli -InstallDir $target
  & $cli server start --timeout 60 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not start the daemon for the graceful-stop check (exit $LASTEXITCODE)" }

  $existing = Get-AmphiInstallLog
  if ($existing) { Remove-Item $existing -ErrorAction SilentlyContinue }
  Invoke-Installer | Out-Null

  $log = Get-AmphiInstallLog
  if (-not $log) { throw 'installer wrote no log' }
  $text = Get-Content -Raw $log
  if ($text -notmatch 'server stop ->') {
    throw 'installer did not attempt a graceful daemon stop; it would be TerminateProcess-killed by the stock running-app check'
  }
  Write-Host '  ok: daemon is asked to stop before the files are replaced'
}

function Test-PathIdempotence {
  $target = Test-Fresh
  Invoke-Installer | Out-Null
  Invoke-Installer | Out-Null
  $paths = Get-AmphiPathEntries -InstallDir $target
  if ($paths.Count -ne 1) { throw "expected one PATH entry after two repairs, got $($paths.Count)" }
  Write-Host '  ok: PATH stays single-entry across repeated installs'
}

function Test-AutostartOptOutSurvives {
  $target = Test-Fresh
  $cli = Get-AmphiCli -InstallDir $target
  & $cli server autostart disable | Out-Null
  if (Get-AmphiRunValue) { throw 'autostart disable did not remove the Run value' }
  if (-not (Get-AmphiGuiRunValue)) {
    throw 'test setup lost GUI autostart before the installer could enforce daemon-off => GUI-off'
  }

  Invoke-Installer | Out-Null

  if (Get-AmphiRunValue) {
    throw 'the update re-enabled an autostart the user had turned off'
  }
  if (Get-AmphiGuiRunValue) {
    throw 'daemon autostart was disabled but the update left GUI autostart enabled'
  }
  if ((Get-GuiAutostartMarker) -cne '1') {
    throw 'daemon-off update did not retain the GUI migration marker'
  }
  Write-Host '  ok: daemon autostart opt-out removes GUI autostart and survives an update'
}

function Test-AutostartArgsSurvive {
  $target = Test-Fresh
  $cli = Get-AmphiCli -InstallDir $target
  & $cli server autostart enable --port 9123 --timeout 60 | Out-Null
  $before = Get-AmphiRunValue
  if ($before -notmatch '--port 9123') { throw "autostart enable did not record the custom port: $before" }

  Invoke-Installer | Out-Null

  $after = Get-AmphiRunValue
  if ($after -notmatch '--port 9123') {
    throw "the update reset the user's autostart arguments: $after"
  }
  Write-Host '  ok: custom autostart arguments survive an update'
}

function Test-GuiAutostartLegacyMigration {
  $target = Test-Fresh
  # Simulate the last release before GUI autostart existed: daemon registration
  # is enabled, but neither the GUI Run value nor the one-way marker exists.
  Remove-ItemProperty -Path $RunKey -Name $GuiRunValueName -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $GuiAutostartStateKey -Name $GuiAutostartMarkerName -ErrorAction SilentlyContinue
  if (-not (Get-AmphiRunValue)) { throw 'legacy-migration setup unexpectedly lost daemon autostart' }

  Invoke-WithDaemonStartupApprovedStatus -Status 2 -Action {
    Invoke-Installer | Out-Null

    $expected = '"' + (Join-Path $target 'Bridgic Agent.exe') + '" --background'
    if ((Get-AmphiGuiRunValue) -cne $expected) {
      throw 'first upgrade from a Windows-approved daemon legacy install did not create canonical GUI autostart'
    }
    if ((Get-GuiAutostartMarker) -cne '1') {
      throw 'first legacy GUI-autostart migration did not write its marker'
    }
  }
  Write-Host '  ok: first legacy upgrade migrates GUI autostart only from Windows-approved daemon state'
}

function Test-GuiAutostartOptOutSurvives {
  Test-Fresh | Out-Null
  # Marker remains: unlike the legacy case above, this missing value is a durable
  # user opt-out even though daemon autostart is still enabled.
  Remove-ItemProperty -Path $RunKey -Name $GuiRunValueName -ErrorAction Stop
  if ((Get-GuiAutostartMarker) -cne '1') { throw 'GUI opt-out setup lost the migration marker' }
  if (-not (Get-AmphiRunValue)) { throw 'GUI opt-out setup unexpectedly disabled daemon autostart' }

  Invoke-WithDaemonStartupApprovedStatus -Status 2 -Action {
    Invoke-Installer | Out-Null

    if (Get-AmphiGuiRunValue) {
      throw 'update re-enabled GUI autostart after a marked user opt-out'
    }
    if ((Get-GuiAutostartMarker) -cne '1') {
      throw 'update lost the GUI autostart migration marker'
    }
  }
  Write-Host '  ok: marked GUI autostart opt-out survives an update'
}

function Test-GuiAutostartPathRepaired {
  $target = Test-Fresh
  $stale = '"C:\stale install\Bridgic Agent.exe" --background'
  Set-ItemProperty -Path $RunKey -Name $GuiRunValueName -Value $stale

  Invoke-WithDaemonStartupApprovedStatus -Status 2 -Action {
    Invoke-Installer | Out-Null

    $expected = '"' + (Join-Path $target 'Bridgic Agent.exe') + '" --background'
    if ((Get-AmphiGuiRunValue) -cne $expected) {
      throw 'update did not repoint an existing GUI autostart value to the current install'
    }
  }
  Write-Host '  ok: existing GUI autostart is repointed without changing its argv'
}

function Test-GuiAutostartStartupApprovedOptOut {
  Test-Fresh | Out-Null
  # Simulate a legacy install whose daemon Run value still exists but has been
  # disabled through Windows Settings / Task Manager. StartupApproved uses byte
  # 0 = 3 for disabled (2 is enabled). Preserve the developer/runner's real value
  # byte-for-byte because this registry location cannot be sandboxed.
  Remove-ItemProperty -Path $RunKey -Name $GuiRunValueName -ErrorAction Stop
  Remove-ItemProperty -Path $GuiAutostartStateKey -Name $GuiAutostartMarkerName -ErrorAction Stop

  Invoke-WithDaemonStartupApprovedStatus -Status 3 -Action {
    Invoke-Installer | Out-Null
    if (Get-AmphiGuiRunValue) {
      throw 'legacy migration created GUI autostart despite daemon StartupApproved=disabled'
    }
    if ((Get-GuiAutostartMarker) -cne '1') {
      throw 'StartupApproved opt-out migration did not write its one-way marker'
    }
  }
  Write-Host '  ok: Windows StartupApproved daemon opt-out blocks first GUI migration'
}

function Test-UninstallRetainsData {
  $target = Test-Fresh
  $sentinel = New-DataSentinel
  Invoke-Uninstaller

  if (Test-Path (Join-Path $target 'Bridgic Agent.exe')) { throw 'uninstall left the product executable behind' }
  if (Get-AmphiRunValue) { throw 'uninstall left daemon autostart behind' }
  if (Get-AmphiGuiRunValue) { throw 'uninstall left GUI autostart behind' }
  if (Test-GuiStartupApprovedValue) { throw 'uninstall left the GUI StartupApproved value behind' }
  if (Get-GuiAutostartMarker) { throw 'uninstall left the GUI autostart migration marker behind' }
  $paths = Get-AmphiPathEntries -InstallDir $target
  if ($paths.Count -ne 0) { throw "uninstall left $($paths.Count) PATH entries behind" }
  if (-not (Test-Path $sentinel)) { throw 'uninstall deleted user data under ~/.bridgic' }
  Write-Host '  ok: uninstall removes the app and keeps user data'
}

# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

if ($ConfigOnly) {
  Write-Host 'Static installer checks:'
  Assert-InstallerConfiguration
  Assert-InstallerLanguages
  Assert-LangStringsInCustomHeader
  Assert-MessageBoxDefaults
  Assert-AutostartContracts
  Write-Host 'All static checks passed.'
  exit 0
}

if (-not $Scenario) { throw 'Specify -Scenario or -ConfigOnly.' }

if ($Scenario -eq 'ReleaseArtifacts') {
  Write-Host "Scenario: $Scenario"
  Assert-ReleaseArtifacts
  exit 0
}

if (-not $Installer) { throw "-Installer is required for scenario $Scenario." }
if (-not (Test-Path $Installer)) { throw "installer not found: $Installer" }
$Installer = (Resolve-Path $Installer).Path

Write-Host "Scenario: $Scenario"
$originalUserProfile = $env:USERPROFILE
$scenarioFailed = $false
Initialize-Sandbox
try {
  switch ($Scenario) {
    'Fresh' { Test-Fresh | Out-Null }
    'Repair' { Test-Repair }
    'NoRelocateOnReinstall' { Test-NoRelocateOnReinstall }
    'RejectsTooLongPath' { Test-RejectsTooLongPath }
    'GracefulStop' { Test-GracefulStop }
    'PathIdempotence' { Test-PathIdempotence }
    'AutostartOptOutSurvives' { Test-AutostartOptOutSurvives }
    'AutostartArgsSurvive' { Test-AutostartArgsSurvive }
    'GuiAutostartLegacyMigration' { Test-GuiAutostartLegacyMigration }
    'GuiAutostartOptOutSurvives' { Test-GuiAutostartOptOutSurvives }
    'GuiAutostartPathRepaired' { Test-GuiAutostartPathRepaired }
    'GuiAutostartStartupApprovedOptOut' { Test-GuiAutostartStartupApprovedOptOut }
    'UninstallRetainsData' { Test-UninstallRetainsData }
  }
}
catch {
  $scenarioFailed = $true
  throw
}
finally {
  # Best-effort teardown so scenarios do not leak an installation into each other.
  $location = Get-AmphiInstallLocation
  if ($location -and $Scenario -ne 'UninstallRetainsData') {
    try { Invoke-Uninstaller } catch { Write-Warning "teardown uninstall failed: $_" }
  }
  Remove-Sandbox -KeepForDiagnostics:$scenarioFailed
  $env:USERPROFILE = $originalUserProfile
}

Write-Host "Scenario $Scenario passed."
