; Windows NSIS install/uninstall customization.
;
; Responsibilities, in the order electron-builder runs them
; (app-builder-lib/templates/nsis/installSection.nsh):
;
;   .onInit → customInit                 snapshot pre-install state, open the log
;   pages   → customPageAfterChangeDir   our own directory page (fresh install only)
;   §1      → customCheckAppRunning      graceful daemon stop, then the stock check
;   §2      → uninstallOldVersion        electron-builder runs the OLD uninstaller
;   §3      → installApplicationFiles
;   §4      → customInstall              PATH + autostart registration
;
; Three facts about the surrounding machinery drive most of what is below. They
; are non-obvious and were each verified against app-builder-lib 26.8.1 rather
; than inferred from the docs.
;
; 1. `${isUpdated}` does NOT mean "an installation already exists".
;    out/targets/nsis/nsisScriptGenerator.js:27-37 compiles it into a
;    `${StdUtils.TestParameter} "updated"` check — i.e. "was the installer
;    launched with --updated", which only electron-updater ever passes
;    (electron-updater/out/NsisUpdater.js:107). A user who downloads a newer
;    .exe and double-clicks it over an existing install does NOT set it. So
;    anything gated on ${isUpdated} silently skips the most common upgrade path,
;    which is why we snapshot our own $amHasExistingInstall in customInit.
;
; 2. electron-builder already force-kills our daemon.
;    templates/nsis/include/allowOnlyOneInstallerInstance.nsh:66-99 — when
;    PowerShell is available (the norm on Win10/11) it does not match by process
;    name at all; it kills every process whose image path starts with $INSTDIR.
;    `resources\bin\amphi.exe` and `amphi-autostart.exe` both live under it. The
;    problem was never "the update fails"; it is that an agent gets
;    TerminateProcess'd mid-turn. Hence customCheckAppRunning: ask nicely first,
;    then let the stock logic handle whatever survives.
;
; 3. An over-install runs the OLD uninstaller, i.e. THIS file's customUnInstall,
;    with --updated (templates/nsis/include/installUtil.nsh:200-216). That is why
;    customUnInstall must not delete either autostart registration during an update.
;
; Why the installer no longer starts the daemon
; ---------------------------------------------
; There used to be an `Exec '… amphi.exe server start'` here. It popped a console
; window during every install: the installer is a GUI process, `amphi.exe` is
; built with console=True (the CLI needs stdout), so Windows handed it a fresh
; console. Users read that black window as something going wrong.
;
; The step is now dropped rather than hidden. Its whole value was saving a few
; seconds on first launch, and that value collapsed once the CLI stopped being a
; PyInstaller onefile — cold start went from 22.6 s to 0.29 s (measured on
; Windows 11, 2026-07-28). The daemon still comes up two ways: PythonClient
; spawns it when the GUI starts (see PythonClient.ts `_runStart`), and the Run
; key from customInstall starts it at every logon. An update is therefore applied
; while the daemon is stopped, which is exactly what we want.
;
; Trade-off: between finishing the install and either opening the app or logging
; in again, no daemon runs, so an unattended scheduled task in that window will
; not fire. Judged acceptable — that window only exists right after an install.
;
; Why the Run key and not a Scheduled Task
; ----------------------------------------
; This used to run `schtasks /Create /SC ONLOGON`. It NEVER ONCE SUCCEEDED:
; creating a logon-triggered task writes to the Task Scheduler root folder, which
; requires elevation, and this is a per-user installer that deliberately never
; prompts for UAC. Every install failed with "拒绝访问 / Access is denied", and
; because that `ExecWait` did not capture an exit code the failure was silent.
; The follow-up PowerShell hardening step then failed too — it looked up a task
; that did not exist — and THAT is the error console users saw flash past during
; install (confirmed on Windows 11, 2026-07-28).
;
; The Run key is the correct per-user, zero-elevation mechanism here; it is the
; closest Windows analogue of the `~/Library/LaunchAgents` plist used on macOS.
;
; Known trade-off, accepted deliberately: the Run key has no crash-restart
; equivalent to launchd's `KeepAlive={SuccessfulExit:false}`. While the GUI is
; open this is already covered — PythonClient's 30s health probe re-spawns a dead
; daemon (see PythonClient.ts `_probeHealth`). It is NOT covered when the GUI is
; closed, so an unattended scheduled task can miss its window if the daemon dies.
; Restoring that would require elevation, so it stays uncovered.
;
; Why `server start` and not `server serve`
; -----------------------------------------
; The Run key invokes `amphi-autostart.exe`, a GUI-subsystem PyInstaller shim
; that cannot allocate a console. It forwards only `server start` to the
; console-enabled `amphi.exe` with CREATE_NO_WINDOW. `server start` then spawns
; the daemon with the same flag and exits after readiness, so no process in the
; login chain creates a visible console. Terminal users still call `amphi.exe`
; directly and keep normal stdout/stderr.
;
; IMPORTANT — naming constants must match apps/electron/src/shared/app-meta.ts:
;   - "Bridgic Agent"        (PRODUCT_NAME -> %APP_PRODUCT_NAME%. Sourced from
;                            electron-builder.yml's `productName`, NOT from
;                            package.json — apps/electron/package.json has no
;                            productName field, only `"name": "amphi"`. Editing
;                            package.json here changes nothing and fails silently.)
;   - "Amphi Daemon"         (WIN_AUTOSTART_NAME; also _run_key.py::RUN_VALUE_NAME)
;                            Deliberately still the old name: it is an existing
;                            HKCU Run *value name*, not display text. Renaming it
;                            with the product would orphan every installed
;                            autostart entry — see app-meta.ts for the full note.
;   - "Bridgic Agent"        (WIN_GUI_AUTOSTART_NAME; the GUI login item. Unlike
;                            the daemon entry above this one DOES track the
;                            product name — it has never shipped, so there is no
;                            installed entry to orphan.)
;   - --background            (GUI_BACKGROUND_ARG; hidden Electron login launch)
;   - amphi.exe              (BACKEND_CLI_NAME + .exe)
;   - amphi-autostart.exe    (windowless Run-key shim)
;
; The GUI login item has a deliberately separate owner and value name from the
; daemon. `amphi server autostart repair` remains the ONLY writer of "Amphi
; Daemon" because that command has user-configurable argv. The GUI command is
; fixed, so NSIS owns its install/update/uninstall lifecycle directly.

!define AM_GUI_AUTOSTART_STATE_KEY "Software\Amphi"
!define AM_GUI_AUTOSTART_MARKER_NAME "GuiAutostartMigrated"

; Keep the canonical GUI command in one physical WriteRegStr. Apart from making
; quoting auditable, this lets test-installer.ps1 prove that no branch silently
; grows a different argv. The quotes around $INSTDIR are part of the registry
; value; spaces in a user-selected install directory must survive logon parsing.
!macro amWriteGuiAutostart
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bridgic Agent" '"$INSTDIR\Bridgic Agent.exe" --background'
!macroend

; ── Variables ───────────────────────────────────────────────────────────────
; Declared at file scope because `Var` needs no LogicLib. Everything that DOES
; need LogicLib (or the MUI language IDs) lives inside a macro instead: this file
; is compiled before installer.nsi's `!include MUI2.nsh`, so `${If}` is not yet
; available at this point.

Var amLogPath
Var amLogHandle

!ifndef BUILD_UNINSTALLER
  Var amHasExistingInstall  ; "1" when a registered installation was found
  Var amOldInstallDir       ; its InstallLocation ("" on a fresh install)
  Var amOldVersion          ; its DisplayVersion ("" if unregistered or fresh)
  Var amMode                ; "fresh" | "upgrade" | "repair" | "downgrade"
  Var amHadRunValue         ; HKCU Run value BEFORE the old uninstaller wipes it
  Var amHadGuiRunValue      ; Electron Run value before the old uninstaller
  Var amHadGuiMarker        ; non-empty once GUI autostart migration has run
  Var amDaemonStartupApproved ; 0=implicit, 2=enabled, 255=query failed, other=off
  Var amFirstPageRadioGo    ; first page: the primary action (upgrade/repair/downgrade)
  Var amFirstPageRadioUn    ; first page: uninstall instead
  Var amFirstPageKeepData   ; first page: "keep my data" — only live under uninstall
  ; Normally pulled in by allowOnlyOneInstallerInstance.nsh:5-8, but that block
  ; is guarded by `!ifmacrondef customCheckAppRunning` — defining our own hook
  ; means we have to supply them, or _CHECK_APP_RUNNING will not compile.
  Var pid
!endif

; MAX_PATH budget, paired with MAX_PAYLOAD_RELATIVE = 165 in
; desktop/scripts/check-payload-paths.ts (measured on Windows: 161 — uv's
; Windows CPython ships byte-compiled pip vendored modules its macOS build does
; not, which is why an earlier macOS-derived 150 was wrong).
;
;   80  $INSTDIR cap enforced below
;  + 1  separator
;  +165 longest packaged path
;  + 6  `\${APP_FILENAME}` that amInstFilesPre may append afterwards
;  ----
;   252 of the 260 Windows allows
;
; The two constants move together: raising the payload ceiling without lowering
; this one is how the limit gets exceeded without anything saying so.
;
; The warn threshold sits above the default location — `C:\Users\<user>\AppData\
; Local\Programs\Bridgic Agent` is ~66 chars even for a long user name — so it
; only fires on a directory the user actually chose.
;
; Raised 62 -> 70 with the 2026-08 `Amphi` -> `Bridgic Agent` rename: with
; oneClick:false the NSIS install dir is derived from `productName`
; (`electron-builder`'s getWindowsInstallationDirName), so the
; default path grew by 8 chars. At the old threshold every default install by a
; user with a long account name would have warned about a path *they never
; chose* — exactly what this threshold exists to avoid.
;
; MAX deliberately stays 80: it is derived from MAX_PATH above, not chosen, so
; raising it to restore the pre-rename headroom would trade a false warning for
; a real >260 truncation. The rename does narrow the ceiling — the default path
; is 46 + len(account name), so a default install now needs an account name of
; <=34 chars where it used to allow <=42. Long AD-style names
; (`firstname.lastname.DOMAIN.000`) can cross that and hit AM_PATH_TOO_LONG on a
; directory the user never picked. Shortening the packaged 165-char path is the
; only way to buy that back; a shorter productName would be the other.
!define AM_INSTDIR_MAX_LEN 80
!define AM_INSTDIR_WARN_LEN 70

; ── Logging ─────────────────────────────────────────────────────────────────
; NSIS's own `LogSet` needs a debug-enabled makensis (nsis.customNsisBinary +
; debugLogging) and writes to a path that cannot be configured, so we keep our
; own append-only log instead. Every user-facing failure message can point at it.

!macro amLogInit FILENAME
  CreateDirectory "$LOCALAPPDATA\Amphi"
  StrCpy $amLogPath "$LOCALAPPDATA\Amphi\${FILENAME}"
!macroend

; File only. This used to also call DetailPrint, which never once reached a
; user: installSection.nsh:5-7 runs `SetDetailsPrint none` for every non-silent
; install, and common.nsh:5 sets `ShowInstDetails nevershow` so there is no
; details pane to open either. Use amStage below for anything the user should
; actually read.
!macro amLog TEXT
  ${If} $amLogPath != ""
    ClearErrors
    FileOpen $amLogHandle "$amLogPath" a
    ${IfNot} ${Errors}
      FileSeek $amLogHandle 0 END
      FileWrite $amLogHandle "${TEXT}$\r$\n"
      FileClose $amLogHandle
    ${EndIf}
    ClearErrors
  ${EndIf}
!macroend

; One user-facing progress line, written to the status bar above the progress
; bar on the INSTFILES page — the only surface this installer has for telling a
; user what is happening (there is no details pane; see amLog).
;
; The `none` afterwards is not tidiness, it is the whole trick: with details
; printing left on, the very next command overwrites our sentence with its own
; auto-generated status ("Extract: …"), so the label is gone before anyone reads
; it. Print, then silence, then let the slow work run underneath the label.
;
; Scoped to non-silent installs for the same reason installSection.nsh:5-7
; scopes its own `SetDetailsPrint none` that way: a silent install has no status
; bar to write to, and leaving details printing suppressed would swallow the
; template's own failure diagnostics — handleUninstallResult's "Uninstall was
; not successful" (installUtil.nsh:125,130) and extractUsing7za's "Can't modify
; …'s files" (extractAppPackage.nsh:111) — for the whole rest of the run.
; The log line is unconditional; only the screen half is skipped.
!macro amStage TEXT
  !insertmacro amLog "${TEXT}"
  ${IfNot} ${Silent}
    SetDetailsPrint textonly
    DetailPrint "${TEXT}"
    SetDetailsPrint none
  ${EndIf}
!macroend

; ── Header: language strings + helper functions ─────────────────────────────
; Expanded at installer.nsi:45 — after `addLangs` (so the LANG_* IDs exist) and
; after MUI2 (so LogicLib is available), and at file scope (so Functions are
; legal here; customInit / customInstall are expanded INSIDE a function or
; section and cannot define one).

!macro customHeader
  ; Absolute path via ${PROJECT_DIR}, not a bare filename: makensis runs with its
  ; CWD set to app-builder-lib's own template dir and the only extra include dirs
  ; are that template's `include/` and `directories.buildResources` (resources/).
  ; `build/` is on neither list, so a bare `!include "installer-languages.nsh"`
  ; would not resolve.
  !include "${PROJECT_DIR}\build\installer-languages.nsh"

  !ifndef BUILD_UNINSTALLER
    !include "getProcessInfo.nsh"
    ; StrContains.nsh has no include guard and declares Vars + a Function at file
    ; scope. assistedInstaller.nsh:23 includes the same file when
    ; `allowToChangeInstallationDirectory` is on — flipping that yml flag back to
    ; true would fail the build with "Var already declared" and nothing would
    ; point at the flag as the cause.
    !include "StrContains.nsh"

    ; VersionCompare needs no `!insertmacro` to instantiate it: in NSIS 3.x the
    ; macro of that name is empty and the real body is emitted on demand by
    ; ${CallArtificialFunction} (WordFunc.nsh:1590-1601), which is idempotent.
    !include "WordFunc.nsh"

    ; ── First page ────────────────────────────────────────────────────────────
    ; Fills the customWelcomePage slot (assistedInstaller.nsh:9-11), i.e. the
    ; very first page electron-builder emits. It has two jobs.
    ;
    ; 1. Be shown UNCONDITIONALLY, so that index 0 of the page list is a page
    ;    that actually exists. The page after it, PAGE_INSTALL_MODE, always
    ;    Aborts because customInstallMode forces the current-user branch — and
    ;    NSIS's Abort continues in the direction of travel, so pressing Back on
    ;    the directory page unwound past the front of the page list and closed
    ;    the installer.
    ;
    ;    Back is now disabled on every page from the directory page onward
    ;    (amDirectoryPageShow, amInstFilesPre), so that unwind is unreachable by
    ;    a second, independent route. Do not conclude from this that the page is
    ;    only decoration and can be dropped: deleting it puts the directory page
    ;    back at index 1, and the two Back-disables are the only thing then
    ;    standing between a user and a closed installer. Job 2 is the reason the
    ;    page earns its place; this is the reason it must not move.
    ;
    ; 2. Tell a returning user what is about to happen. The directory page Aborts
    ;    for an existing install (amDirectoryPagePre), so before this page the
    ;    first thing a re-installing user saw was the progress bar already
    ;    overwriting their installation.
    ;
    ; The primary action is deliberately NOT a fixed "repair". This package
    ; carries exactly one version of the program files, so repairing is only
    ; meaningful when that version is the installed one; otherwise the only thing
    ; the package can do is replace it.
    Function amFirstPageCreate
      ${If} $amMode == "fresh"
        !insertmacro MUI_HEADER_TEXT "$(AM_WELCOME_TITLE)" "$(AM_WELCOME_SUBTITLE)"
      ${Else}
        !insertmacro MUI_HEADER_TEXT "$(AM_MAINT_TITLE)" "$(AM_MAINT_SUBTITLE)"
      ${EndIf}

      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${If} $amMode == "fresh"
        ${NSD_CreateLabel} 0 0 100% 50u "$(AM_WELCOME_BODY)"
        Pop $0
      ${Else}
        ${If} $amOldVersion == ""
          ${NSD_CreateLabel} 0 0 100% 20u "$(AM_MAINT_BODY_NOVER)"
        ${Else}
          ${NSD_CreateLabel} 0 0 100% 20u "$(AM_MAINT_BODY)"
        ${EndIf}
        Pop $0

        ${If} $amMode == "upgrade"
          ${NSD_CreateRadioButton} 0 26u 100% 11u "$(AM_MAINT_UPGRADE)"
        ${ElseIf} $amMode == "downgrade"
          ${NSD_CreateRadioButton} 0 26u 100% 11u "$(AM_MAINT_DOWNGRADE)"
        ${Else}
          ${NSD_CreateRadioButton} 0 26u 100% 11u "$(AM_MAINT_REPAIR)"
        ${EndIf}
        Pop $amFirstPageRadioGo
        ${NSD_OnClick} $amFirstPageRadioGo amFirstPageChoiceChanged

        ${If} $amMode == "downgrade"
          ${NSD_CreateLabel} 10u 38u 94% 18u "$(AM_MAINT_DOWNGRADE_HINT)"
        ${Else}
          ${NSD_CreateLabel} 10u 38u 94% 18u "$(AM_MAINT_PRIMARY_HINT)"
        ${EndIf}
        Pop $0

        ${NSD_CreateRadioButton} 0 60u 100% 11u "$(AM_MAINT_UNINSTALL)"
        Pop $amFirstPageRadioUn
        ${NSD_OnClick} $amFirstPageRadioUn amFirstPageChoiceChanged
        ${NSD_CreateLabel} 10u 72u 94% 18u "$(AM_MAINT_UNINSTALL_HINT)"
        Pop $0

        ${NSD_CreateCheckbox} 10u 94u 94% 11u "$(AM_MAINT_KEEP_DATA)"
        Pop $amFirstPageKeepData
        ; Checked, because the recoverable mistake is keeping data you meant to
        ; delete. Disabled to start with, because the primary action is
        ; preselected and installing never deletes anything — a live checkbox
        ; there would suggest the install can take your data away.
        ${NSD_Check} $amFirstPageKeepData
        EnableWindow $amFirstPageKeepData 0

        ; Preselect the primary action. Someone who double-clicked an installer
        ; almost always means to install it, and a stray Enter must never land
        ; on "uninstall".
        ${NSD_Check} $amFirstPageRadioGo
      ${EndIf}

      nsDialogs::Show
    FunctionEnd

    ; Keep the data checkbox live only while "Uninstall" is selected. nsDialogs
    ; hands the clicked control's HWND to the callback on the stack; we do not
    ; need it, but it has to come off or the stack is left unbalanced.
    Function amFirstPageChoiceChanged
      Pop $0
      ${NSD_GetState} $amFirstPageRadioUn $0
      ${If} $0 == ${BST_CHECKED}
        EnableWindow $amFirstPageKeepData 1
      ${Else}
        EnableWindow $amFirstPageKeepData 0
      ${EndIf}
    FunctionEnd

    Function amFirstPageLeave
      ${If} $amMode == "fresh"
        Return
      ${EndIf}
      ${NSD_GetState} $amFirstPageRadioUn $0
      ${If} $0 == ${BST_CHECKED}
        Call amDeleteUserDataIfAsked
        Call amRunUninstaller
        ; Only reachable when the uninstaller could not be started — and
        ; amRunUninstaller has already said so. Abort holds the user on this page
        ; instead of proceeding with an install they did not ask for.
        Abort
      ${EndIf}
    FunctionEnd

    ; Honour an unchecked "Keep my data" before handing over to the uninstaller.
    ;
    ; This deletes irrecoverable user content, so it is gated twice: the box is
    ; checked by default and only becomes clickable under "Uninstall", and
    ; unchecking it still has to survive a confirmation whose default answer is
    ; "no".
    ;
    ; Why it happens HERE, before the uninstaller runs, rather than after:
    ; a NSIS uninstaller copies itself to $TEMP and relaunches, so the process we
    ; start exits at once and there is nothing to wait on. There is no "after".
    ; The cost is real and worth stating plainly — a user who deletes their data
    ; and then cancels the uninstall wizard is left with the app installed and
    ; the data gone. AM_MAINT_CONFIRM_DELETE says "now, before the uninstaller
    ; starts" for exactly that reason.
    ;
    ; Only Amphi's own two directories are removed, never the ~/.bridgic family
    ; root itself: that root is shared (see desktop/.../main/paths.ts, which
    ; documents ~/.bridgic as the family dir holding both ~/.bridgic/amphi and
    ; ~/.bridgic/AmphiAgent), and a sibling product's data is not ours to touch.
    Function amDeleteUserDataIfAsked
      ${NSD_GetState} $amFirstPageKeepData $0
      ${If} $0 == ${BST_CHECKED}
        Return
      ${EndIf}

      MessageBox MB_ICONEXCLAMATION|MB_YESNO|MB_DEFBUTTON2 "$(AM_MAINT_CONFIRM_DELETE)" /SD IDNO IDYES amConfirmedDelete
      !insertmacro amLog "data deletion declined at the confirmation"
      Return

      amConfirmedDelete:
      ; Stop the daemon first. It holds files under both directories open, and
      ; on Windows an open handle makes RMDir fail — silently, since RMDir /r
      ; only sets the error flag, which would leave a half-deleted profile.
      Call amStopOldDaemon
      nsExec::Exec 'taskkill /F /T /IM amphi.exe'
      Pop $0
      nsExec::Exec 'taskkill /F /T /IM amphi-autostart.exe'
      Pop $0
      Sleep 800

      ClearErrors
      RMDir /r "$PROFILE\.bridgic\amphi"
      RMDir /r "$PROFILE\.bridgic\AmphiAgent"
      ${If} ${Errors}
        !insertmacro amLog "user data deletion reported errors; some files may remain"
        ClearErrors
      ${Else}
        !insertmacro amLog "user data deleted at the user's request"
      ${EndIf}
    FunctionEnd

    ; Hand over to the registered uninstaller and get out of its way.
    ;
    ; Exec, not ExecWait: an NSIS uninstaller copies itself into $TEMP and
    ; relaunches from there, so the process we spawn exits almost immediately and
    ; waiting on it would say nothing about whether the uninstall worked. The
    ; user gets the uninstall wizard; this installer is done either way.
    Function amRunUninstaller
      ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
      ${If} $0 == ""
        ; Legacy per-machine installs registered under HKLM. Nothing this
        ; installer can produce lands there (allowElevation is off), but an older
        ; build could have left one behind.
        ReadRegStr $0 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
      ${EndIf}
      ${If} $0 == ""
        !insertmacro amLog "uninstall requested but no UninstallString is registered"
        MessageBox MB_ICONSTOP|MB_OK "$(AM_MAINT_UNINSTALL_FAILED)" /SD IDOK
        Return
      ${EndIf}

      !insertmacro amLog "user chose uninstall; handing over to $0"
      ClearErrors
      Exec '$0'
      ${If} ${Errors}
        !insertmacro amLog "failed to start the uninstaller"
        MessageBox MB_ICONSTOP|MB_OK "$(AM_MAINT_UNINSTALL_FAILED)" /SD IDOK
        Return
      ${EndIf}
      ; quitSuccess, not a bare Quit: NSIS reports exit code 2 for a Quit and
      ; anything scripting this installer (winget, a deploy job, the e2e harness)
      ; would read a successful handoff as a failure. common.nsh:78-82.
      !insertmacro quitSuccess
    FunctionEnd

    ; Directory page PRE: an existing installation is updated in place, always.
    ; electron-builder's own skip logic keys off ${isUpdated} and therefore does
    ; not fire for a manual over-install (see fact 1 in the file header).
    Function amDirectoryPagePre
      ${If} $amHasExistingInstall == "1"
        Abort
      ${EndIf}
    FunctionEnd

    ; Directory page SHOW: take Back away.
    ;
    ; Back from here is not merely useless, it is destructive. Walking backwards
    ; runs the install-mode page's PRE, which takes the $isForceCurrentInstall
    ; branch and calls setInstallModePerUser — and that re-derives $INSTDIR from
    ; an empty HKCU InstallLocation, i.e. resets it to the default
    ; (multiUser.nsh:21-47). A folder the user typed here is silently replaced
    ; with %LOCALAPPDATA%\Programs\Bridgic Agent on the way back, and there is no hook
    ; between the two pages to preserve it.
    ;
    ; PRE would work equally well — NSIS configures the Back button BEFORE the
    ; page's PRE callback, not during page creation (exehead/Ui.c: EnableWindow
    ; on the Back button at :584, prefunc at :611, CreateDialogParam at :632,
    ; showfunc at :647), which is also why amInstFilesPre can disable it from a
    ; PRE. SHOW is used here only because it is unambiguously after everything
    ; NSIS does to the buttons, and this file is maintained from macOS where the
    ; ordering cannot be re-checked by running it.
    ;
    ; Nothing is lost — the page before this one is purely informational.
    Function amDirectoryPageShow
      GetDlgItem $0 $HWNDPARENT 3
      EnableWindow $0 0
    FunctionEnd

    ; Directory page LEAVE: MAX_PATH guard. Overrunning it does not produce a
    ; "path too long" error — it produces `Failed to load python313.dll`, bare
    ; ENOENTs from npm, and checksum failures, none of which mention the path.
    Function amDirectoryPageLeave
      StrLen $0 "$INSTDIR"
      ${If} $0 > ${AM_INSTDIR_MAX_LEN}
        MessageBox MB_ICONSTOP|MB_OK "$(AM_PATH_TOO_LONG)" /SD IDOK
        Abort
      ${ElseIf} $0 > ${AM_INSTDIR_WARN_LEN}
        MessageBox MB_ICONEXCLAMATION|MB_OKCANCEL "$(AM_PATH_LONG_WARN)" /SD IDOK IDOK amPathAccepted
        Abort
        amPathAccepted:
      ${EndIf}
    FunctionEnd

    ; INSTFILES PRE: same sanitization electron-builder applies in its own
    ; directory-page branch (assistedInstaller.nsh:34-39) — make sure the chosen
    ; folder ends up inside an app-named subfolder rather than, say, D:\ itself.
    Function amInstFilesPre
      ${If} $amHasExistingInstall == "0"
        ${StrContains} $0 "${APP_FILENAME}" "$INSTDIR"
        ${If} $0 == ""
          StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
        ${EndIf}
      ${EndIf}
      !insertmacro amLog "install target resolved: $INSTDIR"

      ; Control 3 is the Back button of the outer dialog. Installing is not
      ; reversible by walking backwards through the wizard: from here Back would
      ; return to a page whose Next re-runs the whole section over files that are
      ; already in place.
      GetDlgItem $0 $HWNDPARENT 3
      EnableWindow $0 0
    FunctionEnd

    ; Graceful daemon shutdown, using the CLI of the installation being replaced.
    ; Called from customCheckAppRunning, i.e. after every page and immediately
    ; before uninstallOldVersion — the only point where stopping the daemon is
    ; not immediately undone by the GUI's 30s health probe re-spawning it.
    Function amStopOldDaemon
      ${If} $amHasExistingInstall != "1"
        Return
      ${EndIf}
      ${IfNot} ${FileExists} "$amOldInstallDir\resources\bin\amphi.exe"
        !insertmacro amLog "no CLI under $amOldInstallDir — skipping graceful stop"
        Return
      ${EndIf}

      !insertmacro amLog "$(AM_STOPPING_GATEWAY)"
      ; nsExec (not ExecWait): amphi.exe is a console application, so ExecWait
      ; hands it a fresh console and a black window flashes over the installer.
      ;
      ; `server stop` takes --timeout/--force. There is no --json flag anywhere on
      ; this CLI — `server status` prints JSON unconditionally and always exits 0
      ; (src/amphi_cli/_server.py), so the text is the signal, not the exit code.
      nsExec::ExecToStack '"$amOldInstallDir\resources\bin\amphi.exe" server stop --timeout 20'
      Pop $0
      Pop $1
      !insertmacro amLog "server stop -> code=$0"
      Sleep 500

      nsExec::ExecToStack '"$amOldInstallDir\resources\bin\amphi.exe" server status'
      Pop $0
      Pop $1
      ${StrContains} $2 '"running"' "$1"
      ${If} $2 != ""
        ; Not fatal: _CHECK_APP_RUNNING runs next and owns the retry / "cannot be
        ; closed" interaction. We only own the polite attempt.
        !insertmacro amLog "daemon still reports running after graceful stop"
      ${Else}
        !insertmacro amLog "daemon stopped cleanly"
      ${EndIf}
    FunctionEnd
  !endif
!macroend

; ── Install mode ────────────────────────────────────────────────────────────
; With oneClick:false + perMachine:false, electron-builder inserts an
; install-mode page (assistedInstaller.nsh:19) offering "for all users", which
; elevates and installs into Program Files — breaking the entire HKCU model
; (autostart Run key, user PATH, ~/.bridgic). Forcing the current-user branch
; makes that page's PRE Abort, so it is never shown.

; multiUserUi.nsh:41-43 expands this in the uninstaller build too, which is
; harmless: that build's own `!ifdef BUILD_UNINSTALLER` branch a few lines later
; already calls setInstallModePerUser for a per-user installation, and a silent
; uninstall skips the page loop entirely.
!macro customInstallMode
  StrCpy $isForceCurrentInstall 1
!macroend

; ── Pages ───────────────────────────────────────────────────────────────────
; `allowToChangeInstallationDirectory` is false in electron-builder.yml so that
; we own the directory page outright; see amDirectoryPagePre for why its built-in
; skip condition is not usable.

; The first page in the wizard. Callbacks are forward references here on
; purpose: this macro is expanded from assistedInstaller.nsh:10, which runs at
; installer.nsi:40 — five lines BEFORE addLangs defines the LangStrings the page
; needs. Declaring the page here and building it in a function defined inside
; customHeader (installer.nsi:45, just after addLangs) keeps the page first
; without referencing a language string that does not exist yet.
!ifndef BUILD_UNINSTALLER
  !macro customWelcomePage
    Page custom amFirstPageCreate amFirstPageLeave
  !macroend
!endif

!ifndef BUILD_UNINSTALLER
  !macro customPageAfterChangeDir
    !define MUI_PAGE_CUSTOMFUNCTION_PRE amDirectoryPagePre
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW amDirectoryPageShow
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE amDirectoryPageLeave
    !insertmacro MUI_PAGE_DIRECTORY
    !define MUI_PAGE_CUSTOMFUNCTION_PRE amInstFilesPre
  !macroend
!endif

; ── .onInit ─────────────────────────────────────────────────────────────────

!ifndef BUILD_UNINSTALLER
  !macro customInit
    !insertmacro amLogInit "install.log"
    !insertmacro amLog "=== install session start ==="

    StrCpy $amHasExistingInstall "0"
    StrCpy $amOldInstallDir ""
    StrCpy $amOldVersion ""
    StrCpy $amMode "fresh"
    StrCpy $amHadRunValue ""
    StrCpy $amHadGuiRunValue ""
    StrCpy $amHadGuiMarker ""
    StrCpy $amDaemonStartupApproved "255"

    ; initMultiUser (assistedInstaller.nsh:106-120) has just read
    ; HKCU\Software\${APP_GUID}\InstallLocation and, when it found one, pointed
    ; $INSTDIR at it. Snapshot that NOW: the install-mode page overwrites
    ; $hasPerUserInstallation unconditionally a moment later
    ; (multiUserUi.nsh:59-63), so this is the last moment the answer is true.
    ${If} $hasPerUserInstallation == "1"
    ${OrIf} $hasPerMachineInstallation == "1"
      StrCpy $amHasExistingInstall "1"
      StrCpy $amOldInstallDir "$INSTDIR"

      ; Which of upgrade / repair / downgrade the first page offers. Written by
      ; registryAddInstallInfo (app-builder-lib templates/nsis/include/
      ; installer.nsh:124) on every install this project has ever shipped.
      ReadRegStr $amOldVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
      ${If} $amOldVersion == ""
        ReadRegStr $amOldVersion HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
      ${EndIf}
      ClearErrors

      ; "repair" is the neutral answer, not a fallback for failure: it promises
      ; only that the program files get rewritten, which is true whatever is on
      ; disk. Both branches below fall back to it rather than guessing a
      ; direction, because naming the wrong direction is worse than naming none —
      ; the downgrade copy in particular warns about data loss.
      ; BOTH sides have to be checked. VersionCompare mis-orders any comparison
      ; where exactly one side carries a prerelease suffix, whichever side that
      ; is: the segment loop reaches "0" against "0-beta", the leading-zero strip
      ; halts at the hyphen, and the StrCmp chain (WordFunc.nsh:1649-1651) then
      ; reports the PRERELEASE side as the newer one. Traced both directions:
      ;
      ;   VersionCompare "0.1.0" "0.1.0-beta.1"  -> 2  (ver2 newer)
      ;   VersionCompare "0.1.0-beta.1" "0.1.0"  -> 1  (ver1 newer)
      ;
      ; Against our call `${VersionCompare} "${VERSION}" "$amOldVersion"`, that
      ; makes BOTH directions wrong: shipping 0.1.0 over an installed
      ; 0.1.0-beta.1 reads as a downgrade (a real upgrade shown with the
      ; data-loss warning), and shipping 0.1.0-beta.1 over an installed 0.1.0
      ; reads as an upgrade (a real downgrade shown as "your data is kept").
      ;
      ; So neither guard is the redundant one. Today ${VERSION} is 0.1.0 with no
      ; hyphen, which makes $2 permanently "" — the $amOldVersion guard is the
      ; only half currently doing any work, and it covers the first case above.
      ${StrContains} $1 "-" "$amOldVersion"
      ${StrContains} $2 "-" "${VERSION}"
      ${If} $amOldVersion == ""
        StrCpy $amMode "repair"
      ${ElseIf} $1 != ""
      ${OrIf} $2 != ""
        !insertmacro amLog "prerelease in ${VERSION} or $amOldVersion — not ordering them"
        StrCpy $amMode "repair"
      ${Else}
        ${VersionCompare} "${VERSION}" "$amOldVersion" $0
        ${If} $0 == 1
          StrCpy $amMode "upgrade"
        ${ElseIf} $0 == 2
          StrCpy $amMode "downgrade"
        ${Else}
          StrCpy $amMode "repair"
        ${EndIf}
      ${EndIf}
    ${EndIf}

    ; Same reasoning for the autostart registration: uninstallOldVersion runs the
    ; OLD uninstaller before any file is copied, and that uninstaller is free to
    ; remove this value. Reading it here is what lets customInstall tell "the
    ; user turned autostart off" apart from "the update just deleted it".
    ClearErrors
    ReadRegStr $amHadRunValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Amphi Daemon"
    ${If} ${Errors}
      StrCpy $amHadRunValue ""
      ClearErrors
    ${EndIf}

    ; A Run value can still be disabled in Windows Settings / Task Manager.
    ; Looking only at "Amphi Daemon" above would misread that state as enabled,
    ; create the GUI login item, and let Electron start the daemon the user had
    ; explicitly disabled. StartupApproved is REG_BINARY, which NSIS cannot read
    ; with ReadRegStr, so query its first status byte through hidden PowerShell:
    ;   no value -> 0 (Run is active by default), 2 -> explicitly enabled,
    ;   other    -> disabled/non-approved, 255 -> query failed (do not migrate).
    ; The PowerShell variables use $$ so NSIS emits a literal `$`.
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { $$item = Get-ItemProperty -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' -ErrorAction Stop; $$property = $$item.PSObject.Properties['Amphi Daemon']; if ($$null -eq $$property) { exit 0 }; $$value = $$property.Value; if ($$null -eq $$value -or $$value.Length -lt 1) { exit 255 }; exit [int]$$value[0] } catch [System.Management.Automation.ItemNotFoundException] { exit 0 } catch { exit 255 }"`
    Pop $amDaemonStartupApproved
    ${If} $amDaemonStartupApproved == "error"
      StrCpy $amDaemonStartupApproved "255"
    ${EndIf}

    ; The Electron tray is a second login item. Snapshot both its Run value and
    ; the one-way migration marker before uninstallOldVersion runs. A missing Run
    ; value means "old build, never migrated" only while the marker is absent;
    ; once marked, missing means the user deliberately opted out and updates must
    ; not bring it back.
    ClearErrors
    ReadRegStr $amHadGuiRunValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bridgic Agent"
    ${If} ${Errors}
      StrCpy $amHadGuiRunValue ""
      ClearErrors
    ${EndIf}
    ReadRegStr $amHadGuiMarker HKCU "${AM_GUI_AUTOSTART_STATE_KEY}" "${AM_GUI_AUTOSTART_MARKER_NAME}"
    ${If} ${Errors}
      StrCpy $amHadGuiMarker ""
      ClearErrors
    ${EndIf}

    !insertmacro amLog "existing=$amHasExistingInstall mode=$amMode oldVersion=$amOldVersion oldDir=$amOldInstallDir daemonAutostartWasSet=$amHadRunValue daemonStartupApproved=$amDaemonStartupApproved guiAutostartWasSet=$amHadGuiRunValue guiMigrated=$amHadGuiMarker"

    ; Silent installs (electron-updater, winget, scripted deploys) bypass every
    ; page, so the directory-page guard never runs for them. /D= still has to be
    ; length-checked or the same MAX_PATH breakage lands without any warning.
    StrLen $0 "$INSTDIR"
    ${If} $0 > ${AM_INSTDIR_MAX_LEN}
      !insertmacro amLog "refusing install: $INSTDIR is $0 chars (max ${AM_INSTDIR_MAX_LEN})"
      MessageBox MB_ICONSTOP|MB_OK "$(AM_PATH_TOO_LONG)" /SD IDOK
      Abort
    ${EndIf}
  !macroend
!endif

; ── Pre-install lifecycle ───────────────────────────────────────────────────

!ifndef BUILD_UNINSTALLER
  !macro customCheckAppRunning
    ; Label first. IS_POWERSHELL_AVAILABLE launches PowerShell twice
    ; (allowOnlyOneInstallerInstance.nsh:50-56) and its cold start is the first
    ; multi-second pause of the whole install — precisely the stall this label
    ; exists to explain, so it must not run behind it.
    !insertmacro amStage "$(AM_STAGE_CHECK)"

    ; $IsPowerShellAvailable is declared and set by this macro; _CHECK_APP_RUNNING
    ; reads it, and the stock CHECK_APP_RUNNING only inserts it on the branch we
    ; are replacing.
    !insertmacro IS_POWERSHELL_AVAILABLE

    Call amStopOldDaemon

    ; Then the stock behaviour, unchanged. Do NOT reimplement it: with PowerShell
    ; present it matches every process whose image path starts with $INSTDIR
    ; (covering `Bridgic Agent.exe`, `resources\bin\amphi.exe` and
    ; `amphi-autostart.exe` alike), and it owns the retry loop and the
    ; "cannot be closed" dialog. Our only addition is asking first.
    ;
    ; KNOWN GAP, introduced by the 2026-08 rename and NOT closed here. Without
    ; PowerShell, electron-builder falls back to
    ; `FIND_PROCESS "${APP_EXECUTABLE_FILENAME}"`
    ; (allowOnlyOneInstallerInstance.nsh). That used to catch the daemon by
    ; accident: the executable was `Amphi.exe` and Windows IMAGENAME matching is
    ; case-insensitive, so it also matched `amphi.exe`
    ; because Windows IMAGENAME matching is case-insensitive. `Bridgic Agent.exe` shares
    ; no such collision. So on a PowerShell-less machine where the graceful
    ; `server stop` above already failed (hung daemon), `amphi.exe` keeps
    ; `_internal\*.dll` open, electron-builder's rename-based un.atomicRMDir
    ; aborts, and both $INSTDIR and the Uninstall registry entry survive.
    ; Closing it means an explicit `taskkill /IM amphi.exe` on the no-PowerShell
    ; branch — deliberately not added blind, since this is the force-kill path
    ; and nothing here has been exercised on real Windows.
    !insertmacro _CHECK_APP_RUNNING

    ; Label the long stretch that starts the moment this macro returns:
    ; uninstallOldVersion (installSection.nsh:52) followed by
    ; installApplicationFiles (:66). electron-builder offers no hook between the
    ; two, so they share one label — which is also the honest thing to show,
    ; since both are "the installer is replacing files and you can only wait".
    ;
    ; This label has to be set BEFORE returning for a second reason: partway
    ; through, Nsis7z::Extract (extractAppPackage.nsh:97) takes the progress bar
    ; over and restarts it from zero, so the bar visibly falls back after
    ; climbing to ~90%. The step counter changing from [1/3] to [2/3] at that
    ; moment is what stops it reading as a crash-and-retry.
    !insertmacro amStage "$(AM_STAGE_FILES)"
  !macroend
!endif

; ── Install ─────────────────────────────────────────────────────────────────

!macro customInstall
  !insertmacro amStage "$(AM_STAGE_CONFIG)"

  ; Log only. The user was already told this on the first page, which names the
  ; existing installation and its folder before anything is touched; the
  ; directory page being skipped is no longer a surprise that needs explaining
  ; after the fact.
  ${If} $amHasExistingInstall == "1"
    !insertmacro amLog "$(AM_UPDATE_IN_PLACE)"
  ${EndIf}

  ; 1. PATH (HKCU = user-scoped, no admin needed).
  ;
  ; The old uninstaller has already removed the previous entry, but do not rely
  ; on that: a failed or skipped uninstall would leave a duplicate, and EnVar has
  ; no "add once" semantics we can lean on across PATH lengths.
  EnVar::SetHKCU
  ${If} $amOldInstallDir != ""
  ${AndIf} $amOldInstallDir != $INSTDIR
    EnVar::DeleteValue "Path" "$amOldInstallDir\resources\bin"
    Pop $0
    !insertmacro amLog "PATH cleanup of previous dir -> $0"
  ${EndIf}
  EnVar::DeleteValue "Path" "$INSTDIR\resources\bin"
  Pop $0
  EnVar::AddValue "Path" "$INSTDIR\resources\bin"
  Pop $0
  ${If} $0 = 0
    !insertmacro amLog "PATH updated: added $INSTDIR\resources\bin"
  ${Else}
    ; Never report a fully successful install when the terminal integration
    ; silently did not happen. EnVar fails on a PATH longer than NSIS's max
    ; string length, which is a real machine state, not a theoretical one.
    !insertmacro amLog "PATH update FAILED with code $0"
    MessageBox MB_ICONEXCLAMATION|MB_OK "$(AM_PATH_FAILED)" /SD IDOK
  ${EndIf}

  ; Broadcast change so already-open Explorer / new cmd see the new PATH.
  System::Call 'user32::SendMessageTimeout(p 0xFFFF, i 0x1A, p 0, t "Environment", i 0, i 5000, *p .r0)'

  ; 2. Logon autostart.
  ;
  ; Single writer: `amphi server autostart repair` (Python) owns the command
  ; line, including the --host / --port / --log-level a user may have configured.
  ; This installer only asks it to point at the new location. Writing the value
  ; from NSIS as well is what used to reset a custom port on every update and
  ; silently re-enable autostart for users who had turned it off — see
  ; src/amphi_service/server/supervisor/_run_key.py::repair.
  ;
  ;   fresh install               -> create with canonical defaults
  ;   update whose value existed  -> recreate, keeping the user's arguments
  ;   update whose value was gone -> the user opted out; write nothing
  ;
  ; The decision is driven ENTIRELY by $amHadRunValue, captured in customInit.
  ; It is tempting to let the CLI decide by looking at the registry, and that is
  ; exactly wrong here: by the time this runs, installSection.nsh:52 has executed
  ; the PREVIOUS release's uninstaller, and every uninstaller shipped so far
  ; deletes the Run value unconditionally. The CLI would see nothing and would
  ; either write nothing (losing autostart) or rebuild from argparse defaults
  ; (losing a configured --host / --port / --log-level). Reading the registry
  ; before that happens is the only reliable signal.
  ;
  ; Restoring the snapshot below is NOT this installer authoring a command line —
  ; the contract that the CLI owns the value's CONTENT still holds. It writes
  ; back, byte for byte, a value the user's own `autostart enable` produced, so
  ; that `repair` has something to repoint. Everything about which arguments
  ; survive is still decided in _run_key.py::repair.
  ${If} $amHadRunValue != ""
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Amphi Daemon" "$amHadRunValue"
    !insertmacro amLog "restored the pre-update autostart command for repair to repoint"
  ${EndIf}

  ${If} $amHasExistingInstall == "0"
  ${OrIf} $amHadRunValue != ""
    nsExec::Exec '"$INSTDIR\resources\bin\amphi.exe" server autostart repair'
    Pop $0
    ; `==` (string compare), not `=`. nsExec pushes the STRING "error" when the
    ; process cannot be created at all — a missing or AV-quarantined amphi.exe,
    ; i.e. the most severe failure there is — and LogicLib's integer `=` coerces
    ; "error" to 0, reporting that exact case as success.
    ${If} $0 == 0
      !insertmacro amLog "autostart registration repaired"
    ${Else}
      ; With the GUI closed, the Run key is the ONLY thing that starts the
      ; daemon, so a failure here is as user-visible as a broken PATH and gets
      ; the same treatment rather than a log line nobody reads.
      !insertmacro amLog "autostart repair FAILED with code $0"
      MessageBox MB_ICONEXCLAMATION|MB_OK "$(AM_AUTOSTART_FAILED)" /SD IDOK
    ${EndIf}
  ${Else}
    !insertmacro amLog "autostart was disabled before this update; leaving it off"
  ${EndIf}

  ; 3. Electron tray login item.
  ;
  ; This is independent from the daemon Run value at the OS layer, but the
  ; product-level invariant is one-way: a disabled daemon must never leave a GUI
  ; login item behind, because that GUI immediately starts/discovers the daemon.
  ;
  ;   fresh install                         -> create GUI item
  ;   first migration, daemon Windows-approved -> create GUI item
  ;   daemon Run absent / StartupApproved off  -> keep GUI off
  ;   later update, GUI value existed       -> repoint to this $INSTDIR
  ;   later update, GUI value absent        -> preserve the user's opt-out
  ;
  ; The fixed marker removes the otherwise-unresolvable ambiguity between "this
  ; release predates GUI autostart" and "the user removed GUI autostart". It is
  ; written after every successful installer pass; presence, rather than its
  ; exact contents, is the durable migration signal.
  ${If} $amHasExistingInstall == "0"
    !insertmacro amWriteGuiAutostart
    !insertmacro amLog "GUI autostart created for fresh install"
  ${ElseIf} $amHadRunValue == ""
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bridgic Agent"
    !insertmacro amLog "daemon autostart was disabled; GUI autostart removed"
  ${ElseIf} $amDaemonStartupApproved != "0"
  ${AndIf} $amDaemonStartupApproved != "2"
  ${AndIf} $amDaemonStartupApproved != "255"
    ; The daemon Run value exists but Windows has disabled it in Startup Apps.
    ; Leaving/creating GUI autostart would bypass that decision because Electron
    ; discovers or starts the daemon as soon as it launches.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bridgic Agent"
    !insertmacro amLog "daemon startup is not approved by Windows; GUI autostart removed"
  ${ElseIf} $amHadGuiMarker == ""
    ${If} $amDaemonStartupApproved == "255"
      ; Query failure is ambiguous. Never convert ambiguity into a new login
      ; program: this preserves a possible Windows Startup Apps opt-out.
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bridgic Agent"
      !insertmacro amLog "could not read daemon StartupApproved; skipped first GUI migration"
    ${Else}
      !insertmacro amWriteGuiAutostart
      !insertmacro amLog "GUI autostart created by first migration"
    ${EndIf}
  ${ElseIf} $amHadGuiRunValue != ""
    !insertmacro amWriteGuiAutostart
    !insertmacro amLog "GUI autostart repointed to $INSTDIR\Bridgic Agent.exe"
  ${Else}
    ; The marker proves this is an opt-out, not a legacy install. Delete is
    ; idempotent and also protects against an old uninstaller recreating a value
    ; between customInit and this point.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bridgic Agent"
    !insertmacro amLog "GUI autostart was disabled before this update; leaving it off"
  ${EndIf}
  WriteRegStr HKCU "${AM_GUI_AUTOSTART_STATE_KEY}" "${AM_GUI_AUTOSTART_MARKER_NAME}" "1"

  !insertmacro amLog "=== install session end: $INSTDIR ==="
  !insertmacro amStage "$(AM_STAGE_DONE)"
!macroend

; ── Uninstall ───────────────────────────────────────────────────────────────

!macro customUnInstall
  !insertmacro amLogInit "uninstall.log"

  ; 1. Autostart registrations.
  ;
  ; An over-install runs THIS uninstaller with --updated
  ; (installUtil.nsh:200-216). Deleting the value there would destroy the only
  ; evidence customInstall has of whether the user wanted autostart at all, and
  ; an interrupted update would silently lose it. So it is removed only on a real
  ; uninstall — and even then FIRST, so an uninstall interrupted after the daemon
  ; is stopped cannot resurrect it at the next logon.
  ${IfNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Amphi Daemon"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bridgic Agent"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Bridgic Agent"
    DeleteRegValue HKCU "${AM_GUI_AUTOSTART_STATE_KEY}" "${AM_GUI_AUTOSTART_MARKER_NAME}"
    DeleteRegKey /ifempty HKCU "${AM_GUI_AUTOSTART_STATE_KEY}"
    !insertmacro amLog "daemon + GUI autostart registrations removed (real uninstall)"
  ${Else}
    !insertmacro amLog "update in progress: leaving daemon + GUI autostart state in place"
  ${EndIf}

  ; 2. Stop daemon. Non-fatal: a non-zero code usually just means "not running".
  ;
  ;    nsExec (not ExecWait) — same reason spelled out at the taskkill calls
  ;    below: amphi.exe is a console application, so ExecWait hands it a fresh
  ;    console and a black window flashes over the uninstaller. nsExec runs it
  ;    hidden and still leaves the exit code on the stack.
  nsExec::Exec '"$INSTDIR\resources\bin\amphi.exe" server stop'
  Pop $0
  !insertmacro amLog "daemon stop returned $0 (non-zero usually = not running)"

  ; Remove the obsolete scheduled-task definition used by earlier builds.
  ; Failure is harmless when the task never existed (the common case).
  nsExec::Exec 'schtasks /Delete /F /TN "Amphi Daemon"'
  Pop $0
  !insertmacro amLog "legacy scheduled-task cleanup returned $0"

  ; 3. Force-kill any survivor, then let the OS release the handles.
  ;
  ;    This is not paranoia — the uninstaller CANNOT tolerate a live daemon.
  ;    electron-builder removes files by RENAMING them into $PLUGINSDIR
  ;    (templates/nsis/uninstaller.nsh :: un.atomicRMDir), and Rename fails on an
  ;    open file. One surviving handle on either launcher or _internal\*.dll
  ;    aborts the whole removal, so $INSTDIR and the uninstall registry entry both
  ;    stay behind and the app is still listed under Apps & features — which is
  ;    why users found themselves clicking Uninstall several times.
  ;
  ;    The graceful stop above can legitimately miss it: if the GUI is still
  ;    running, its 30s health probe (PythonClient::_probeHealth) sees the daemon
  ;    vanish and RE-SPAWNS it, right into the window we are about to delete files
  ;    in. On the update path customCheckAppRunning has already stopped the daemon
  ;    politely, so this only fires for a genuinely stuck process.
  nsExec::Exec 'taskkill /F /T /IM amphi-autostart.exe'
  Pop $0
  !insertmacro amLog "force-kill of leftover autostart launcher returned $0 (128 = none running)"
  nsExec::Exec 'taskkill /F /T /IM amphi.exe'
  Pop $0
  !insertmacro amLog "force-kill of leftover daemon returned $0 (128 = none running)"
  Sleep 800

  ; 4. Strip our PATH entry.
  EnVar::SetHKCU
  EnVar::DeleteValue "Path" "$INSTDIR\resources\bin"
  Pop $0
  !insertmacro amLog "PATH entry removal returned $0"

  ; Re-broadcast.
  System::Call 'user32::SendMessageTimeout(p 0xFFFF, i 0x1A, p 0, t "Environment", i 0, i 5000, *p .r0)'

  ; User data under %USERPROFILE%\.bridgic is intentionally never touched here.
  ${IfNot} ${isUpdated}
    !insertmacro amLog "$(AM_UNINSTALL_DATA_RETAINED)"
  ${EndIf}
!macroend
