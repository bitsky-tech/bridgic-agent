"""★ Declarative data for the permission rules — the main place you edit.

There is **only data here, no logic**: the decision layer (``_classify``) reads
these lists to answer "what capability is this tool, is this command dangerous,
is this path sensitive". To add a hard-denied command, add a sensitive path, or
change a tool's capability, edit the matching list here — you never need to
touch the decision logic.

The lists come in two regex flavours:

* **Command lists** (``HARD_DENY_COMMANDS`` / ``DANGEROUS_COMMANDS`` /
  ``READ_COMMANDS`` / ``EDIT_COMMANDS``): full-matched against a **whole
  sub-command** (sub-commands have already been unwrapped and split by
  ``_normalize``). The patterns carry their own ``.*`` wrappers so they match
  anywhere on the command line.
* **Path lists** (``SENSITIVE_PATHS``): searched (match anywhere) against the
  **resolved real path**.

``TOOL_CAPABILITY`` is an ordered "tool name -> capability" mapping; the first
full match wins.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Dict, FrozenSet, Iterable, List, Tuple

from ._types import Capability

# ── ③ System-critical directories (the standard set + the current home) ──
# A delete target that resolves to **exactly** one of these (or its direct glob
# ``<dir>/*``) means "definitely wiping the system disk" → hard_deny.
# Normalised with ``realpath`` at import time to absorb macOS symlinks
# (``/etc→/private/etc`` / ``/var→/private/var`` / ``/home→/System/Volumes/Data/home``).
# This file holds data only; the exact-equality check lives in ``_classify``.
_SYSTEM_CRITICAL_RAW: List[str] = [
    "/",
    os.path.expanduser("~"),  # current user's home directory
    "/usr", "/etc", "/bin", "/sbin", "/var", "/lib", "/lib64",
    "/boot", "/opt", "/root", "/System", "/Library", "/home", "/Users",
    # This app's data directory: deleting it exactly wipes every skill, session,
    # schedule and permission policy in one go — always denied. **Only exact
    # equality is blocked**; paths beneath it still follow the normal "trusted
    # directory" rules (see Boundary.IN_APP_HOME).
    os.path.join(os.path.expanduser("~"), ".bridgic"),
    os.path.join(os.path.expanduser("~"), ".bridgic", "AmphiAgent"),
]
if os.name == "nt":
    _SYSTEM_CRITICAL_RAW.extend(
        value
        for value in (
            os.environ.get("SystemDrive"),
            os.environ.get("SystemRoot"),
            os.environ.get("ProgramFiles"),
            os.environ.get("ProgramFiles(x86)"),
            os.environ.get("ProgramData"),
        )
        if value
    )
SYSTEM_CRITICAL_DIRS: FrozenSet[str] = frozenset(
    os.path.realpath(p) for p in _SYSTEM_CRITICAL_RAW
)

# ── ③ Hard red lines: system-level destruction, denied in every mode (running
# one wrecks the machine and there is no legitimate reason to) ──
# Adding or removing a hard-denied command = editing this list.
HARD_DENY_COMMANDS: List[str] = [
    r".*:\(\)\s*\{.*",                                              # fork bomb :(){ :|:& };:
    r".*\b(?:mkfs(?:\.\w+)?|fdisk|parted|mke2fs)\b.*",              # format a disk
    r".*\bdd\b.*\bof=/dev/.*",                                      # write to a raw device
    r".*>\s*/dev/(?:sd|nvme|disk|hd).*",                           # redirect into a raw device
    r".*>\s*/(?:etc|bin|sbin|usr|boot|lib|var|System|Library)\b.*",  # overwrite a system path
    r".*\b(?:shutdown|reboot|halt|poweroff)\b.*",                  # shut down / reboot
    r".*\binit\s+[06]\b.*",
    r".*\bkill\s+-9\s+-1\b.*",                                     # kill every process
    r".*>\s*/etc/sudoers\b.*",                                     # tamper with privilege config
]

# ── Dangerous execution: not a hard red line but high impact; delegated to the
# mode layer (request asks / auto runs the classifier / full allows) ──
# Note: ``rm`` deletions (recursive and not) are handled by the deletion rules in
# ``_classify._deletion_targets`` (capability EDIT, system disk → hard_deny,
# unclear → uncertain) and no longer go through these patterns.
DANGEROUS_COMMANDS: List[str] = [
    r".*\bsudo\b.*",                                               # privilege escalation
    r".*\bchmod\s+(?:-R\s+)?0?777\b.*",
    r".*\bchown\s+-R\b.*\s/.*",
    r".*\|\s*(?:sudo\s+)?(?:ba|z|k|c)?sh\b.*",                     # pipe into a shell (curl ... | sh)
    r".*\bkillall\b.*",
    r".*\bfind\b.*\s-delete\b.*",
    r".*\bfind\b.*\s-exec(?:dir)?\b.*",
    r".*\bgit\s+push\b.*\s(?:-f|--force(?:-with-lease)?)\b.*",
]

# ── ④ Risk surface for the auto-mode rule (command-shaped) ───────────────────
# In auto mode everything passes by default except [obvious risk] and [possible
# risk]; matching this list = touching the risk surface → send to the classifier
# for review (not a block, just a review). There is exactly one criterion:
# **could this command affect anything outside the session workspace?**
# Execution confined to the workspace or a temp directory (installing deps,
# building, testing, running scripts, starting a local server) is **not** listed.
#
# Boundary-shaped risks (out-of-bounds writes, sensitive paths, deletions we
# can't see clearly) are structural and are derived directly from the decision
# fields by ``_mode_policy``; they are not duplicated here. This list is
# deliberately **broad** — a miss is fail-open, while an extra review is merely
# slower. It is matched against **the whole raw command** and **each
# sub-command** separately: a pipeline (curl … | sh) has no ``|`` left in its
# split sub-commands, so only the whole-command match catches it.
RISK_SURFACE_COMMANDS: List[str] = [
    # ── System level: effects spill outside the session ──
    r".*\bsudo\b.*",
    r".*\b(?:apt|apt-get|yum|dnf|apk|pacman|brew|port|choco|winget)\s+\w*\s*(?:install|remove|uninstall|upgrade)\b.*",
    r".*\b(?:npm|pnpm|yarn|bun)\s+\w+\b.*\s(?:-g|--global|--location=global)\b.*",
    r".*\bpip3?\s+install\b.*\s--user\b.*",
    r".*\b(?:cargo|go|gem)\s+install\b.*",
    r".*\b(?:crontab|systemctl|launchctl|schtasks)\b.*",
    r".*>>?\s*\S*\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\b.*",
    r".*\bssh-(?:keygen|copy-id|add)\b.*",
    # ── Fetching code from an uncontrolled source and executing it ──
    r".*\|\s*(?:sudo\s+)?(?:ba|z|k|c)?sh\b.*",
    r".*\bpip3?\s+install\b.*(?:git\+|https?://|\s-e\s).*",
    r".*\buv\s+pip\s+install\b.*(?:git\+|https?://|\s-e\s).*",
    r".*\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\s+(?:https?://|git\+|github:|file:).*",
    # ── Outbound network to a destination the agent picks (same criterion as
    # NETWORK_RISK_TOOLS) ──
    # GET and POST are not distinguished: the URL and its query string can carry
    # data by themselves (``?leak=<content>``), and the exfiltrated private data
    # need not come from a sensitive path — reading private code inside the
    # workspace is allowed, so "sensitive reads are already reviewed" cannot be
    # relied on as a backstop. Package managers also reach the network, but
    # installing from a package index is covered by the ALLOW exceptions: it does
    # not match this group and stays allowed.
    r".*\b(?:curl|wget|nc|ncat|netcat|telnet|ftp|sftp)\b.*",
    r".*\bssh\b\s+\S+.*",
    r".*\bscp\b.*\s\S+:.*",
    r".*\brsync\b.*\s\S+@\S+:.*",
    # ── Pushing to a remote / publishing ──
    r".*\bgit\s+push\b.*",
    r".*\b(?:npm|pnpm|yarn)\s+publish\b.*",
    r".*\b(?:twine\s+upload|cargo\s+publish|docker\s+push)\b.*",
    r".*\bgh\s+(?:release\s+create|repo\s+create|gist\s+create)\b.*",
    r".*\bgh\s+(?:pr\s+create|repo\s+edit)\b.*",
    r".*\b(?:vercel|netlify|firebase|wrangler|fly|heroku)\s+\w*deploy\w*\b.*",
    r".*\b(?:poetry|mvn|gradle|gem)\s+\w*(?:publish|deploy|push)\b.*",
    r".*\bdotnet\s+nuget\s+push\b.*",
    # ── Fetch-and-execute (continued): the channels today's agents use most ──
    r".*\bgit\s+clone\b.*",
    r".*\b(?:npx|bunx|uvx|pipx)\b.*",
    r".*\b(?:pnpm|yarn)\s+dlx\b.*",
    r".*\b(?:ba|z|k|c)?sh\s+\S+\.(?:sh|bash|zsh)\b.*",
    r".*\./\S+\.(?:sh|bash|zsh|py|rb|pl)\b.*",
    r".*\bmake\s+install\b.*",
    r".*\bpython3?\s+setup\.py\s+install\b.*",
    # ── System level (continued) ──
    r".*\bosascript\b.*",                      # arbitrary execution on macOS (can run as admin)
    r".*\bsecurity\s+(?:find-|dump-|export)\S*\b.*",  # export macOS keychain credentials
    r".*\bdiskutil\b.*",                       # wipe a disk (HARD_DENY only covers mkfs/fdisk/parted)
    r".*\bmount\b.*",
    r".*\bchmod\s+[ugoa]*[+=]\S*s\b.*",        # setuid / setgid escalation
    r".*\bgit\s+config\s+--global\b.*",        # global config injection (core.pager can hook any command)
    r".*\b(?:npm|pnpm|yarn)\s+config\s+set\b.*",
    r".*\bdefaults\s+write\b.*",
    r".*\bsystemsetup\b.*",
    # ── Materialising credentials ──
    # These three shapes originally worked by being excluded from READ_COMMANDS,
    # so they fell into the grey area and got reviewed (see the READ_COMMANDS
    # comment and the 2026-07-06 revision note). Once the rule flipped the grey
    # area to "allow", that hardening netted out to zero, so they must be listed
    # explicitly.
    r"\s*(?:env|printenv)\s*",
    r".*\b(?:echo|printf)\b.*[$\x60].*",
    # ── Destructive git: the policy names "irreversible local destruction"
    # verbatim, yet these never reach the classifier because no boundary can be
    # determined for them ──
    r".*\bgit\s+checkout\s+--\s.*",
    r".*\bgit\s+reset\s+--hard\b.*",
    r".*\bgit\s+clean\s+-\S*[fd]\S*\b.*",
    r".*\bgit\s+stash\s+drop\b.*",
]

# ── ④ Read-only MCP tool names (every other MCP tool counts as a write → risk
# surface) ──
# What MCP can do depends entirely on which server the user installed, so the
# direction is "allow-list the readers, stay conservative about the rest".
# Server and tool names must tolerate **uppercase letters and hyphens** — real
# connectors look exactly like that
# (``mcp__claude_ai_Gmail__get_message`` / ``mcp__claude_ai_Canva__list-folder-items``);
# accepting only ``[a-z0-9_]`` would let most real read-only tools slip through
# and send them all to review.
MCP_READONLY_TOOLS: List[str] = [
    r"mcp__[\w-]+__(?i:get|list|search|read|fetch|query|describe|resolve|view|find"
    r"|ls|cat|show|inspect|status|count|preview|head)(?:[_-][\w-]*|[A-Z][\w-]*)?",
]

# After a hit above, this table is consulted: if the tokenised tool name contains
# any **write verb**, it is not read-only.
# Looking only at the verb prefix would classify ``get_or_create_page`` /
# ``search_and_replace`` / ``fetch_and_upload`` as read-only and allow them
# outright — which is letting the reviewed party decide whether to be reviewed.
MCP_WRITE_VERBS: FrozenSet[str] = frozenset({
    "create", "write", "update", "delete", "remove", "replace", "upload", "send",
    "post", "put", "patch", "exec", "run", "kill", "set", "add", "move", "copy",
    "rename", "publish", "archive", "restore", "revoke", "approve", "merge",
    "close", "cancel", "drop", "truncate",
})

# ── ④ Network / browser tools that touch the risk surface (the remaining
# browser_* tools are in-page observation and interaction → allowed by default) ──
# The dividing line is **who chooses the destination**: reaching the network at a
# URL the agent picked means the URL itself can carry data (``?leak=<content>``),
# a direct channel for private data to cross the trust boundary — and it does not
# require touching a sensitive path first (reading private code inside the
# workspace is allowed), so it must be reviewed. By contrast screenshots,
# snapshots, reads, clicks, typing, waiting and closing are in-page operations
# **within an already-reviewed origin** and are allowed; otherwise every single
# step of a browser task would wait on the classifier. ``web_search`` only hands
# keywords to a fixed search engine and lets the agent choose no destination, so
# it is not listed.
NETWORK_RISK_TOOLS: List[str] = [
    r"web_fetch",
    r"browser_(?:navigate|goto|open|visit)[a-z0-9_]*",
    (
        r"browser_(?:upload|download|set_cookie|get_cookies?|clear_cookies|evaluate|"
        r"execute_script|run_script|get_network_requests|save_storage_state|"
        r"restore_storage_state)[a-z0-9_]*"
    ),
]

# Network-capability tools can also read or write local files. Resolve these
# arguments like ordinary file tools so out-of-workspace and sensitive paths
# cannot bypass the structural backstop.
LOCAL_FILE_ARGUMENTS: Dict[str, str] = {
    "browser_screenshot": "filename",
    "browser_upload_file": "file_path",
    "browser_save_pdf": "filename",
    "browser_save_storage_state": "filename",
    "browser_restore_storage_state": "filename",
    "browser_stop_tracing": "filename",
    "browser_stop_video": "filename",
    "generate_image": "reference_image_path",
}

# ── Read-only shell commands (capability READ) ──
READ_COMMANDS: List[str] = [
    r"\s*pwd\s*",
    r"\s*(?:date|cal|uname)\b[^>|]*",
    r"\s*echo\s+[^>|$\x60]*",     # excludes $ and backticks: echo $TOKEN / echo `cmd` fall into the grey area and go to the classifier (prevents credential leaks)
    r"\s*printf\s+[^>|$\x60]*",   # same as above: printf with variable expansion is not read-only
    r"\s*which\s+\S+\s*",
    r"\s*type\s+\S+\s*",
    r"\s*command\s+-v\s+\S+\s*",
    # Note: env / printenv (with no arguments they dump every environment
    # variable, tokens included) are not read-only. Once the rule flipped,
    # "falling into the grey area" means "allowed", so together with the
    # variable-expanding echo/printf they are listed explicitly in
    # RISK_SURFACE_COMMANDS to force a review.
    r"\s*(?:ps|top|htop|df|free|lscpu|vmstat|iostat|lsof)\b[^>|]*",
    r"\s*sleep\s+[\d.]+\s*",
    r"\s*(?:true|false|clear)\s*",
    # Global options (``-C <path>`` / ``-c k=v`` / ``--git-dir=`` / ``--no-pager``)
    # may appear before the sub-command; not allowing them would make
    # ``git -C /other status`` miss and fall into EXECUTE, then get sent to
    # review by the out-of-bounds backstop.
    r"\s*git\s+(?:(?:-C|-c|--git-dir|--work-tree)[=\s]\S+\s+|--no-pager\s+|--paginate\s+)*"
    r"(?:status|log|diff|show|branch|remote|rev-parse|describe|blame|tag|shortlog|ls-files|stash\s+list)\b[^>|]*",
    r"(?:cat|bat|less|more|head|tail|nl|tac|wc|file|stat|readlink|realpath|md5sum|shasum|sha1sum|sha256sum)\s+.*",
    r"(?:grep|egrep|fgrep|rg|ag)\s+.*",
    r"(?:ls|ll|tree|du)\s+.*",
    r"find\s+\S+.*",
    # cd only changes the working directory of later commands and modifies no
    # files — treated as read-only (cwd changes are tracked by running_cwds);
    # otherwise `cd X && <read-only>` would be dragged up to EDIT by the cd
    # segment, adding approval and classifier noise for nothing.
    r"cd\s+.*",
]

# ── Shell commands with side effects (capability EDIT; take path operands) ──
EDIT_COMMANDS: List[str] = [
    r"(?:cp|mv)\s+.*",
    r"rsync\s+.*",
    r"(?:mkdir|rmdir|touch)\s+.*",
]

# ── Common Windows PowerShell commands ──────────────────────────────────────
# The permission layer only does conservative recognition of common commands; it
# does not attempt to implement a PowerShell AST. Command names are matched after
# casefolding, and the common built-in aliases of Windows PowerShell are covered
# as well.
POWERSHELL_READ_COMMANDS: FrozenSet[str] = frozenset({
    "cat", "dir", "gc", "gci", "gi", "gl", "get-childitem", "get-command",
    "get-content", "get-item", "get-location", "get-process", "ls",
    "measure-object", "pwd", "select-string", "test-path", "type",
})
POWERSHELL_EDIT_COMMANDS: FrozenSet[str] = frozenset({
    "ac", "add-content", "clear-content", "clc", "copy", "copy-item", "cp",
    "cpi", "mi", "move", "move-item", "mv", "new-item", "ni", "out-file",
    "rename-item", "rni", "sc", "set-content", "tee-object",
})
POWERSHELL_DELETE_COMMANDS: FrozenSet[str] = frozenset({
    "del", "erase", "rd", "remove-item", "ri", "rm", "rmdir",
})
POWERSHELL_HARD_DENY_COMMANDS: FrozenSet[str] = frozenset({
    "clear-disk", "format-volume", "initialize-disk", "remove-partition",
    "restart-computer", "stop-computer",
})
POWERSHELL_DANGEROUS_COMMANDS: FrozenSet[str] = frozenset({
    "iex", "invoke-expression", "invoke-restmethod", "invoke-webrequest", "irm",
    "iwr", "register-scheduledtask", "set-acl", "set-executionpolicy",
    "set-service", "start-process", "stop-process", "stop-service",
    "unregister-scheduledtask",
})

# ── ③ Sensitive paths: both reads and writes need approval (delegated to the
# mode layer, not a hard red line) ──
# Searched (match anywhere) against the resolved real path.
SENSITIVE_PATHS: List[str] = [
    r"/\.env(?:\.[\w.-]+)?$",         # .env / .env.local ...
    r"/\.ssh(?:/|$)",                  # ~/.ssh and ~/.ssh/**
    r"/\.aws/credentials$",
    r"/id_(?:rsa|ed25519|ecdsa)(?:\.pub)?$",
    r"/etc/(?:passwd|shadow)$",
    r"/\.netrc$",
    r"/\.npmrc$",
    r"/\.pypirc$",
    # ── Common token caches (high-frequency targets when prompt injection goes
    # hunting for credentials) ──
    r"/\.config/gh/hosts\.yml$",      # GitHub CLI OAuth token
    r"/\.git-credentials$",           # git http credentials
    r"/\.kube/config$",               # kubeconfig token
    r"/\.docker/config\.json$",       # docker registry auth
    r"/\.config/gcloud/",             # gcloud credentials / access token
    r"/\.cargo/credentials(?:\.toml)?$",
    r"/\.pgpass$",                     # postgres password
    r"/(?:Cookies|cookies\.sqlite)$", # browser cookie stores (Chrome / Firefox)
    r"/Library/Cookies/",             # macOS binary cookies
    # ── Windows credential stores ──
    # Paths have already had `\` normalised to `/` before matching (see
    # ``_classify._is_sensitive``), so these are written in `/` form too. The
    # list previously covered only POSIX / macOS locations, leaving these
    # high-value Windows targets completely unprotected.
    r"/AppData/(?:Roaming|Local)/Microsoft/Credentials/",  # Credential Manager
    r"/AppData/(?:Roaming|Local)/Microsoft/Protect/",      # DPAPI master keys
    r"/Login Data$",                  # Chrome / Edge password store
    r"/logins\.json$",                # Firefox password store
    # The permission policy file itself: the agent editing it = editing its own
    # permissions (self-modification / privilege escalation by another name).
    # Listing it as sensitive makes the rule layer's sensitive check take
    # precedence over the boundary allowance, so it is **not** exempted by
    # "writes inside the app directory are allowed".
    # Note: this does not cover ``AMPHI_POLICY_FILE`` pointing elsewhere — that
    # is the user explicitly changing configuration.
    r"/\.bridgic/(?:.*/)?policy\.json$",
    # ── This product's own credentials ──
    # Same reasoning as policy.json: the list covered other people's credentials
    # (.ssh / .aws / browser password stores) but missed our own. The mode layer
    # allows READ liberally and also allows non-delete writes inside
    # ``~/.bridgic``, so after the agent reads an injected instruction,
    # `read_file(state.db)` or `bash("sqlite3 ... select api_key ...")` could
    # walk off with the credentials without triggering any approval at all.
    # state.db holds provider API keys; runtime.json holds the daemon's bearer
    # token (which is equivalent to every local HTTP endpoint). SQLite's -wal /
    # -shm files contain the same data.
    r"/\.bridgic/(?:.*/)?state\.db(?:-wal|-shm)?$",
    r"/\.bridgic/(?:.*/)?runtime\.json$",
    r"/\.codex/auth\.json$",           # Codex CLI credentials (this product reads and reuses them)
]

# ── ③ Regenerable artifacts: deleting them cleans up "derivatives rebuildable
# from a manifest or a build", which does not count as irreversible destruction ──
# The mechanism lives in ``_classify._targets_regenerable``; this is data only.
# There are two match strengths:
#
# * ``REGENERABLE_SEGMENTS`` — a hit on **any segment** of the real path counts.
#   For semantically unambiguous cache / dependency directories: deleting
#   ``node_modules`` is as safe as deleting ``node_modules/foo``.
# * ``REGENERABLE_LEAF_ONLY`` — only a hit on the **last segment of the delete
#   target itself** counts. ``dist`` / ``build`` / ``target`` are usually build
#   output, but **some projects really do use them as source directories**;
#   restricting this to "deleting the directory itself" blocks misjudgements like
#   ``rm -rf build/src/main.c`` while keeping the very common ``rm -rf dist``.
#   Residual risk: a project that treats all of ``dist/`` as a source directory
#   and runs ``rm -rf dist`` is still allowed through.
REGENERABLE_SEGMENTS: FrozenSet[str] = frozenset({
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox",
    ".next", ".turbo", ".parcel-cache", ".gradle", "htmlcov", "coverage",
    "node_modules", ".venv", "venv", "vendor", "site-packages",
})
REGENERABLE_SEGMENT_PATTERNS: List[str] = [r"[^/\\]+\.egg-info"]
REGENERABLE_LEAF_ONLY: FrozenSet[str] = frozenset({"dist", "build", "target"})


def _existing_roots(candidates: Iterable[str]) -> FrozenSet[str]:
    """Normalise candidate directories into a set of **existing** realpaths;
    silently skip the ones that don't exist or can't be resolved.

    Used for temp directories: ``/tmp`` does not exist on Windows, so filtering
    it out is enough and no per-platform branching is needed.
    """
    roots = set()
    for candidate in candidates:
        if not candidate:
            continue
        try:
            if os.path.isdir(candidate):
                roots.add(os.path.realpath(candidate))
        except OSError:
            continue
    return frozenset(roots)


def _app_home_roots() -> FrozenSet[str]:
    """Realpath of this app's data directory ``~/.bridgic``.

    **Deliberately does not check for existence** — on first run it may not have
    been created yet, and boundary checks are prefix comparisons, so registering
    it early is what makes it take effect the moment it appears. ``Path.home()``
    is cross-platform (on Windows it yields ``C:\\Users\\<n>``); if the home
    directory can't be resolved (a daemon with no HOME) it degrades to an empty
    set rather than raising.
    """
    try:
        return frozenset({os.path.realpath(Path.home() / ".bridgic")})
    except (RuntimeError, OSError):
        return frozenset()


def _app_builtin_roots() -> FrozenSet[str]:
    """Realpath of the product's bundled skills directory,
    ``<amphi_agent package>/builtin_skills``.

    Derived from ``__file__``, so it **always points at the code actually
    running** (a source checkout and a packaged application resource directory
    are both correct automatically) with no per-deployment branching. The scope
    deliberately covers only the ``builtin_skills`` subtree rather than the whole
    install directory — in development the install directory *is* the git
    repository, and scoping that wide would mark the entire source tree trusted.
    Degrades to an empty set if the path can't be resolved (boundary checks fall
    back to their previous behaviour) rather than raising.
    """
    try:
        return frozenset({os.path.realpath(Path(__file__).resolve().parent.parent / "builtin_skills")})
    except (RuntimeError, OSError):
        return frozenset()


# ── ③ Temp directory roots (scratch): the contents are disposable by nature, so
# reads, writes and deletes are all allowed ──
# ``gettempdir()`` is cross-platform and respects TMPDIR / TEMP / TMP (on Windows
# it yields AppData\Local\Temp); the POSIX conventions /tmp and /var/tmp are
# unioned in. Normalised with realpath at import time (absorbing macOS
# /tmp→/private/tmp).
TEMP_ROOTS: FrozenSet[str] = _existing_roots([tempfile.gettempdir(), "/tmp", "/var/tmp"])

# ── ③ This app's data directory: skills / sessions / workflows / logs — the
# agent's normal working surface ──
APP_HOME_ROOTS: FrozenSet[str] = _app_home_roots()

# ── ③ The product's bundled skills directory: a skill's SKILL.md instructs the
# agent to run the scripts in here, and that is our own code ──
APP_BUILTIN_ROOTS: FrozenSet[str] = _app_builtin_roots()

# ── ② Tool name -> capability (ordered; the first full match wins) ──
# Adding, removing or changing a tool's capability = editing this table. Tools
# that match nothing fall through to EXECUTE (the grey area).
TOOL_CAPABILITY: List[Tuple[str, Capability]] = [
    (r"read_file|read_image", Capability.READ),
    (r"glob|grep", Capability.READ),
    (r"write_file|edit_file", Capability.EDIT),
    (r"workspace_restore|workspace_restore_file", Capability.EDIT),   # rollback = modifying files
    (r"web_search|web_fetch|generate_image", Capability.NETWORK),
    (r"browser_[a-z0-9_]+|load_browser_tools", Capability.NETWORK),
    (r"mcp__.+", Capability.MCP),
    (
        r"switch|request_build|request_run_workflow|request_accept_rule|request_human_choice|request_human_task_confirm"
        r"|request_human_workflow_confirm|edit_workflow|report_workflow_step"
        r"|run_subagent|start_subagent",
        Capability.CONTROL,
    ),
    # Read-only management: querying skills / workspace / schedules / workflow
    # results = read-only access to internal resources → always allowed.
    (
        r"workspace_status|workspace_diff|workspace_history|workspace_checkpoint"
        r"|load_workspace_tools|view_skill|manage_skills|list_skills"
        r"|get_schedule|help|list_schedules|list_workflow_runs|read_workflow_run",
        Capability.MANAGE,
    ),
    # In-app writes: creating/updating/deleting schedules, workflows, and skills — these only
    # write the daemon's own state and are not system level (nothing lands in the
    # shell's cron).
    # → MANAGE_WRITE: confirmed only in request mode; in auto/full they are
    # allowed as trusted built-in tools (see _mode_policy.decide) without going
    # through the LLM classifier.
    (
        r"create_schedule|update_schedule|delete_schedule|remove_workflow"
        r"|import_skills|uninstall_skill|set_skill_enabled",
        Capability.MANAGE_WRITE,
    ),
]
