; Custom installer strings, English + Simplified Chinese.
;
; !!! This file MUST be included from inside `!macro customHeader` in
; installer.nsh — never at file scope, and always through ${PROJECT_DIR}. !!!
;
; electron-builder inserts our `nsis.include` file into the shared script header
; (app-builder-lib/out/targets/nsis/NsisTarget.js: computeCommonInstallerScriptHeader),
; which is prepended to installer.nsi. That puts it BEFORE
; `!insertmacro addLangs` (templates/nsis/installer.nsi:41) — the line that
; actually emits the `MUI_LANGUAGE` directives defining ${LANG_ENGLISH} and
; ${LANG_SIMPCHINESE}. A LangString at file scope therefore references undefined
; language IDs, and makensis runs with -WX (NsisTarget.js:509), so it is a hard
; build failure rather than a warning. `customHeader` expands at installer.nsi:45,
; immediately AFTER addLangs, which is why it is the right home.
;
; The language itself is chosen from the Windows UI language at runtime
; (multiLanguageInstaller + no displayLanguageSelector), falling back to English
; for any locale we do not bundle. The renderer's own locale preference is
; deliberately not consulted — at first install it does not exist yet.
;
; Every call site MUST pass `/SD ID…` to its MessageBox: electron-updater runs
; this installer with /S, and NSIS still displays message boxes in silent mode
; unless a silent default is given. A missing /SD turns a silent update into a
; modal dialog nobody is watching.

; The first-page strings reference $amOldVersion / $amOldInstallDir, which are
; declared only in the installer build (installer.nsh guards them with
; !ifndef BUILD_UNINSTALLER). Unused LangStrings are dropped silently, so the
; uninstaller builds clean today by luck; the first `$(AM_MAINT_…)` reference
; added on the uninstaller side would fail with `warning 6000: unknown
; variable/constant` — which -WX turns into a build error that points at the
; string, not at the missing declaration. Guard them the same way instead.
!ifndef BUILD_UNINSTALLER

; ─── First page: fresh install ──────────────────────────────────────────────
; Rendered by amFirstPageCreate. Carries little information on a fresh install
; on purpose: its job there is to occupy index 0 of the page list, because the
; page after it (electron-builder's install-mode page) is always skipped via
; Abort and NSIS's Abort is direction-aware. See installer.nsh's amFirstPageCreate
; for the full reasoning, including why disabling Back is not a substitute.
; Everything here is written for someone who wants Bridgic Agent, not for someone
; maintaining it. The earlier draft listed the install folder, the PATH entry,
; the sign-in autostart and "no administrator rights are required" — none of
; which the reader can act on, and two of which (folder, PATH) are shown or
; implied by the very next page anyway. What a person actually needs to know
; before clicking Next is: what is being installed, how long it takes, and
; whether they have to babysit it.
LangString AM_WELCOME_TITLE ${LANG_ENGLISH} "Welcome to Bridgic Agent"
LangString AM_WELCOME_TITLE ${LANG_SIMPCHINESE} "欢迎使用 Bridgic Agent"

LangString AM_WELCOME_SUBTITLE ${LANG_ENGLISH} "Setup will install Bridgic Agent ${VERSION} on this computer"
LangString AM_WELCOME_SUBTITLE ${LANG_SIMPCHINESE} "即将在此电脑上安装 Bridgic Agent ${VERSION}"

LangString AM_WELCOME_BODY ${LANG_ENGLISH} "This wizard will guide you through the installation. It takes about 1–2 minutes.$\r$\n$\r$\nPlease don't close this window while it runs."
LangString AM_WELCOME_BODY ${LANG_SIMPCHINESE} "安装向导会引导你完成安装，大约需要 1–2 分钟。$\r$\n$\r$\n安装期间请不要关闭此窗口。"

; ─── First page: an installation already exists ─────────────────────────────
; The primary action is NOT fixed. This package carries exactly one version of
; the program files, so "repair" is only meaningful when that version is the one
; already installed — otherwise the only thing the package can do is replace it.
LangString AM_MAINT_TITLE ${LANG_ENGLISH} "Bridgic Agent is already installed"
LangString AM_MAINT_TITLE ${LANG_SIMPCHINESE} "Bridgic Agent 已安装"

LangString AM_MAINT_SUBTITLE ${LANG_ENGLISH} "Choose what you'd like to do"
LangString AM_MAINT_SUBTITLE ${LANG_SIMPCHINESE} "请选择你要做什么"

; The install folder is deliberately not shown. It was there to explain why the
; folder-picker page is skipped, but that is the installer's problem, not the
; reader's — and this page is where they decide whether to keep or remove the
; app, a decision the path does not inform.
LangString AM_MAINT_BODY ${LANG_ENGLISH} "Bridgic Agent $amOldVersion is already installed on this computer."
LangString AM_MAINT_BODY ${LANG_SIMPCHINESE} "此电脑上已经安装了 Bridgic Agent $amOldVersion。"

; DisplayVersion is missing or unreadable. Saying "Bridgic Agent  is already installed"
; with the version elided leaves a double space in English and a stray space
; before the Chinese full stop, so the version leaves the sentence entirely.
LangString AM_MAINT_BODY_NOVER ${LANG_ENGLISH} "Bridgic Agent is already installed on this computer."
LangString AM_MAINT_BODY_NOVER ${LANG_SIMPCHINESE} "此电脑上已经安装了 Bridgic Agent。"

LangString AM_MAINT_UPGRADE ${LANG_ENGLISH} "Upgrade to ${VERSION}"
LangString AM_MAINT_UPGRADE ${LANG_SIMPCHINESE} "升级到 ${VERSION}"

; Deliberately NOT "Repair this installation". Every artifact this project ships
; carries VERSION 0.1.0 — desktop/package.json has never been bumped and
; .github/workflows/package.yml:114 mints the release tag as `nightly-<UTC>`
; without touching the version — so VersionCompare returns "equal" for a genuine
; update from one nightly to the next, and this is the branch it lands on.
; Telling someone who is updating that they are repairing is worse than saying
; the one thing that is true either way: the program files get rewritten.
LangString AM_MAINT_REPAIR ${LANG_ENGLISH} "Reinstall Bridgic Agent ${VERSION}"
LangString AM_MAINT_REPAIR ${LANG_SIMPCHINESE} "重新安装 Bridgic Agent ${VERSION}"

; "Downgrade" names a mechanism. What the reader is choosing is an older
; version, and that is what the label says.
LangString AM_MAINT_DOWNGRADE ${LANG_ENGLISH} "Install the older version ${VERSION} (not recommended)"
LangString AM_MAINT_DOWNGRADE ${LANG_SIMPCHINESE} "改装旧版本 ${VERSION}（不推荐）"

; Named in the reader's own terms — sessions, skills, settings — rather than as
; a filesystem path. The same vocabulary is used by the checkbox below and by
; AM_UNINSTALL_DATA_RETAINED, so "my data" means one consistent thing
; everywhere the installer mentions it.
LangString AM_MAINT_PRIMARY_HINT ${LANG_ENGLISH} "Your sessions, skills and settings are kept."
LangString AM_MAINT_PRIMARY_HINT ${LANG_SIMPCHINESE} "你的会话、技能和设置都会保留。"

LangString AM_MAINT_DOWNGRADE_HINT ${LANG_ENGLISH} "The older version may not be able to read content saved by the newer one."
LangString AM_MAINT_DOWNGRADE_HINT ${LANG_SIMPCHINESE} "旧版本可能读不出新版本保存的内容。"

LangString AM_MAINT_UNINSTALL ${LANG_ENGLISH} "Uninstall Bridgic Agent"
LangString AM_MAINT_UNINSTALL ${LANG_SIMPCHINESE} "卸载 Bridgic Agent"

LangString AM_MAINT_UNINSTALL_HINT ${LANG_ENGLISH} "Remove Bridgic Agent from this computer."
LangString AM_MAINT_UNINSTALL_HINT ${LANG_SIMPCHINESE} "从此电脑上移除 Bridgic Agent。"

; Enabled only while "Uninstall" is selected — installing never deletes
; anything, so an enabled checkbox there would imply a risk that does not
; exist. Checked by default: losing this data is unrecoverable, so the safe
; state has to be the one the user gets by not reading carefully.
LangString AM_MAINT_KEEP_DATA ${LANG_ENGLISH} "Keep my data (sessions, skills, workflows and settings)"
LangString AM_MAINT_KEEP_DATA ${LANG_SIMPCHINESE} "保留我的数据（会话、技能、工作流和设置）"

; Shown only when the box has been unchecked, i.e. the user has actively asked
; for deletion. It is the last point at which that is reversible, and the
; deletion happens before the uninstaller runs, so "now" is literal.
LangString AM_MAINT_CONFIRM_DELETE ${LANG_ENGLISH} "Your Bridgic Agent sessions, skills, workflows and settings will be deleted now, before the uninstaller starts. This cannot be undone.$\r$\n$\r$\nDelete them?"
LangString AM_MAINT_CONFIRM_DELETE ${LANG_SIMPCHINESE} "你的 Bridgic Agent 会话、技能、工作流和设置将在卸载程序启动前被立即删除，且无法恢复。$\r$\n$\r$\n确定删除吗？"

LangString AM_MAINT_UNINSTALL_FAILED ${LANG_ENGLISH} "Setup could not start the uninstaller. Uninstall Bridgic Agent from Windows Settings › Apps › Installed apps instead."
LangString AM_MAINT_UNINSTALL_FAILED ${LANG_SIMPCHINESE} "安装向导无法启动卸载程序。请改从 Windows 设置 › 应用 › 已安装的应用 中卸载 Bridgic Agent。"

!endif ; BUILD_UNINSTALLER

; ─── Progress stages ────────────────────────────────────────────────────────
; Printed to the status line above the progress bar (see the amStage macro).
;
; The step counter is not decoration. Nsis7z::Extract takes the progress bar
; over during stage 2 and restarts it from zero, so the bar visibly jumps back
; after having climbed to ~90%. Without a step label that changes at the same
; moment, that reads as a crash-and-retry.
LangString AM_STAGE_CHECK ${LANG_ENGLISH} "[1/3] Checking whether Bridgic Agent is running…"
LangString AM_STAGE_CHECK ${LANG_SIMPCHINESE} "[1/3] 正在检查 Bridgic Agent 是否正在运行…"

LangString AM_STAGE_FILES ${LANG_ENGLISH} "[2/3] Installing Bridgic Agent — this is the slowest step, please wait…"
LangString AM_STAGE_FILES ${LANG_SIMPCHINESE} "[2/3] 正在安装 Bridgic Agent，这一步最慢，请稍候…"

; Not "Configuring the amphi command and sign-in startup". This step lasts about
; two seconds and names two things the reader cannot act on and did not ask for.
LangString AM_STAGE_CONFIG ${LANG_ENGLISH} "[3/3] Finishing up…"
LangString AM_STAGE_CONFIG ${LANG_SIMPCHINESE} "[3/3] 正在完成设置…"

LangString AM_STAGE_DONE ${LANG_ENGLISH} "Installation complete."
LangString AM_STAGE_DONE ${LANG_SIMPCHINESE} "安装完成。"

; ─── Lifecycle ──────────────────────────────────────────────────────────────
LangString AM_STOPPING_GATEWAY ${LANG_ENGLISH} "Stopping the Bridgic Agent gateway…"
LangString AM_STOPPING_GATEWAY ${LANG_SIMPCHINESE} "正在停止 Bridgic Agent 网关…"

LangString AM_UPDATE_IN_PLACE ${LANG_ENGLISH} "An existing installation was found. Bridgic Agent will be updated in place; the installation folder cannot be changed."
LangString AM_UPDATE_IN_PLACE ${LANG_SIMPCHINESE} "检测到已有安装。Bridgic Agent 将在原目录就地更新，安装目录不可更改。"

; ─── Install directory ──────────────────────────────────────────────────────
LangString AM_PATH_TOO_LONG ${LANG_ENGLISH} "This folder path is too long.$\r$\n$\r$\nWindows limits a full file path to 260 characters, and Bridgic Agent ships deeply nested runtime files. Installing here would leave parts of the app unable to load, with errors that do not mention the path.$\r$\n$\r$\nChoose a shorter folder."
LangString AM_PATH_TOO_LONG ${LANG_SIMPCHINESE} "该目录路径过长。$\r$\n$\r$\nWindows 的完整文件路径上限为 260 个字符，而 Bridgic Agent 内置的运行时文件层级较深。装在这里会导致部分组件无法加载，且报错信息不会提到路径问题。$\r$\n$\r$\n请选择更短的目录。"

LangString AM_PATH_LONG_WARN ${LANG_ENGLISH} "This folder path is long. Some bundled runtime files may fail to load because Windows limits a full file path to 260 characters.$\r$\n$\r$\nContinue anyway?"
LangString AM_PATH_LONG_WARN ${LANG_SIMPCHINESE} "该目录路径较长。由于 Windows 的完整路径上限为 260 个字符，部分内置运行时文件可能无法加载。$\r$\n$\r$\n仍要继续吗？"

; ─── PATH / autostart ───────────────────────────────────────────────────────
LangString AM_PATH_FAILED ${LANG_ENGLISH} "Bridgic Agent could not add its folder to your PATH, so the `amphi` command will not work in a terminal. Add this folder manually:$\r$\n$\r$\n$INSTDIR\resources\bin"
LangString AM_PATH_FAILED ${LANG_SIMPCHINESE} "Bridgic Agent 未能把自身目录写入 PATH，终端里将无法使用 `amphi` 命令。请手动添加此目录：$\r$\n$\r$\n$INSTDIR\resources\bin"

LangString AM_AUTOSTART_FAILED ${LANG_ENGLISH} "Bridgic Agent could not register the gateway to start when you sign in. Scheduled tasks will not run while Bridgic Agent is closed. You can retry from Bridgic Agent's settings. Log:$\r$\n$\r$\n$LOCALAPPDATA\Amphi\install.log"
LangString AM_AUTOSTART_FAILED ${LANG_SIMPCHINESE} "Bridgic Agent 未能注册开机自启网关。Bridgic Agent 未打开时，定时任务将不会运行。可在 Bridgic Agent 设置中重试。日志：$\r$\n$\r$\n$LOCALAPPDATA\Amphi\install.log"

; ─── Uninstall ──────────────────────────────────────────────────────────────
LangString AM_UNINSTALL_DATA_RETAINED ${LANG_ENGLISH} "Your Bridgic Agent data in %USERPROFILE%\.bridgic (sessions, skills, workflows) will be kept."
LangString AM_UNINSTALL_DATA_RETAINED ${LANG_SIMPCHINESE} "将保留 %USERPROFILE%\.bridgic 中的 Bridgic Agent 用户数据（会话、技能、工作流）。"
