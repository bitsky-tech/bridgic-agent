"""② The rules layer: reduce one tool call to an objective :class:`Judgement`
(capability + boundary + whether it is sensitive + whether it crosses a system red
line) and **produce no action at all**.

Every piece of "data" a decision needs (which commands are red lines, which capability
a tool counts as, which paths are sensitive) comes from :mod:`_registry`; this module
holds only the "mechanism". Key points:

* A bash command first goes through :mod:`_normalize` to strip process wrappers and
  split on separators, then **each sub-command is judged and the strictest result is
  taken** (``ls && rm -rf x`` is judged as the rm -rf).
* Path boundaries are judged after :func:`resolve_real_path` resolves symlinks (to stop
  symlink escapes).
* Unrecognised tools / bash commands fall to ``EXECUTE`` (the grey area), which is the
  conservative side.
"""

from __future__ import annotations

import ntpath
import os
import re
import shlex
from typing import Dict, List, Optional

import logging

from src.amphi_service.i18n import Locale, backend_i18n

_logger = logging.getLogger(__name__)

from . import _registry as reg
from ._normalize import (
    output_redirect_targets,
    resolve_real_path,
    running_cwds,
    split_compound_command_tagged,
    strip_delete_wrappers,
    strip_process_wrappers,
)
from ._types import Boundary, Capability, Judgement

# This agent runs shell through the ``bash`` tool; the command line arrives in the ``command`` argument.
CLI_TOOL_NAME = "bash"
CLI_COMMAND_ARG = "command"
CLI_CWD_ARG = "cwd"
_IS_WINDOWS = os.name == "nt"

# Severity order when a compound command takes the strictest result (higher = stricter).
_CAP_SEVERITY: Dict[Capability, int] = {
    Capability.CONTROL: 0,
    Capability.READ: 1,
    Capability.MANAGE: 2,
    Capability.MANAGE_WRITE: 3,  # produced by tool-name rules only, never part of the bash strictest-of merge; listed to keep the mapping total
    Capability.EDIT: 4,
    Capability.NETWORK: 5,
    Capability.MCP: 6,
    Capability.EXECUTE: 7,
}
# Order used when a compound command / multiple paths take the "strictest boundary": trusted
# directories (temp/app_home) rank before out-of-bounds, so ``rm /tmp/x /elsewhere/y`` is judged
# OUT_OF_BOUNDS (the strictest segment) and the temp segment cannot mask the out-of-bounds one.
_BOUNDARY_SEVERITY: Dict[Boundary, int] = {
    Boundary.NONE: 0,
    Boundary.IN_WORKSPACE: 1,
    Boundary.IN_TEMP: 2,
    Boundary.IN_MOUNT: 3,
    Boundary.IN_APP_HOME: 4,
    # The bundled-skills root ranks after app_home: it is more permissive for reads/execution and
    # stricter for writes/deletes (see _mode_policy), so in a compound command it must outrank
    # app_home / temp — otherwise ``cp ~/.bridgic/a <builtin>/b`` gets swallowed by app_home's
    # "writes are allowed".
    Boundary.IN_APP_BUILTIN: 5,
    Boundary.OUT_OF_BOUNDS: 6,
}

# Pre-compiled (patterns are validated at construction time, so a bad regex fails fast).
# The re-check of the whole raw command uses fullmatch, and ``.`` does not span ``\n`` by default —
# a single leading newline would defeat it (and that check is the only capture point for the
# pipeline shape ``curl … | sh``, since the split sub-commands contain no ``|``). Hence DOTALL.
_HARD_DENY_RE = [re.compile(p, re.DOTALL) for p in reg.HARD_DENY_COMMANDS]
_DANGEROUS_RE = [re.compile(p) for p in reg.DANGEROUS_COMMANDS]
_READ_CMD_RE = [re.compile(p) for p in reg.READ_COMMANDS]
_EDIT_CMD_RE = [re.compile(p) for p in reg.EDIT_COMMANDS]
_SENSITIVE_RE = [re.compile(p) for p in reg.SENSITIVE_PATHS]
_TOOL_CAP_RE = [(re.compile(p), cap) for p, cap in reg.TOOL_CAPABILITY]
_REGEN_SEG_PAT_RE = [re.compile(p) for p in reg.REGENERABLE_SEGMENT_PATTERNS]
_RISK_CMD_RE = [re.compile(p, re.DOTALL) for p in reg.RISK_SURFACE_COMMANDS]
_MCP_READONLY_RE = [re.compile(p) for p in reg.MCP_READONLY_TOOLS]
_NETWORK_RISK_RE = [re.compile(p) for p in reg.NETWORK_RISK_TOOLS]

_PATH_OPERAND_COMMANDS = frozenset({
    "ag", "bat", "cat", "cp", "du", "egrep", "fgrep", "file", "find",
    "grep", "head", "less", "ll", "ls", "md5sum", "mkdir", "more", "mv",
    "nl", "readlink", "realpath", "rg", "rmdir", "rsync", "sha1sum",
    "sha256sum", "shasum", "stat", "tac", "tail", "touch", "tree", "wc",
})
_IMPLICIT_CWD_COMMANDS = frozenset({"du", "find", "ll", "ls", "tree"})


def classify(
    call: object,
    workspace_root: str,
    mount_roots: object = None,
    writable_roots: object = None,
    gated_roots: object = None,
) -> Judgement:
    """Reduce one tool call to a :class:`Judgement`.

    ``call`` is the framework's ``StepToolCall`` (``tool`` + ``tool_arguments`` name/value
    pairs); ``workspace_root`` is the session's ``.work``, ``writable_roots`` are extra
    managed writable roots, ``mount_roots`` are zero or more mount roots, and
    ``gated_roots`` are controlled subtree roots — a non-writable path beneath one is
    forced to OOB even if its prefix matches temp/app_home (see :func:`_path_boundary`).
    """
    mounts = list(mount_roots or [])
    writable = list(writable_roots or [])
    gated = list(gated_roots or [])
    tool = getattr(call, "tool", "") or ""
    args = {a.name: a.value for a in (getattr(call, "tool_arguments", None) or [])}
    if tool == CLI_TOOL_NAME:
        raw_cwd = str(args.get(CLI_CWD_ARG, "") or "").strip()
        execution_cwd = os.path.realpath(raw_cwd) if os.path.isabs(raw_cwd) else None
        classifier = _classify_powershell if _IS_WINDOWS else _classify_bash
        return classifier(
            str(args.get(CLI_COMMAND_ARG, "") or ""),
            execution_cwd,
            workspace_root,
            mounts,
            writable,
            gated,
        )
    return _classify_tool(tool, args, workspace_root, mounts, writable, gated)


# ---------------------------------------------------------------------------
# Non-bash tools
# ---------------------------------------------------------------------------
def _classify_tool(
    tool: str,
    args: Dict[str, str],
    ws: str,
    mounts: List[str],
    writable: List[str],
    gated: List[str],
) -> Judgement:
    cap = _tool_capability(tool)
    boundary = Boundary.NONE
    sensitive = False
    # File tools: derive the boundary and sensitivity from file_path / path.
    if cap in (Capability.READ, Capability.EDIT):
        raw = str(args.get("file_path") or args.get("path") or "")
        if raw:
            real = resolve_real_path(raw, ws)
            boundary = _path_boundary(real, ws, mounts, writable, gated)
            sensitive = _is_sensitive(real)
    else:
        local_path_arg = reg.LOCAL_FILE_ARGUMENTS.get(tool)
        raw = str(args.get(local_path_arg) or "") if local_path_arg else ""
        if raw:
            real = resolve_real_path(raw, ws)
            boundary = _path_boundary(real, ws, mounts, writable, gated)
            sensitive = _is_sensitive(real)
    return Judgement(
        capability=cap,
        boundary=boundary,
        sensitive=sensitive,
        touches_risk_surface=_tool_risk_surface(tool, cap, args),
        label=_label(cap, boundary, sensitive, False),
    )


def _tool_capability(tool: str) -> Capability:
    for rx, cap in _TOOL_CAP_RE:
        if rx.fullmatch(tool):
            return cap
    # Unknown tool → execution class. Note: once the rule flipped, the grey area is allowed by
    # default, so this classification alone is **no longer conservative** — the conservatism comes
    # from "unregistered means review" in _tool_risk_surface.
    return Capability.EXECUTE


def _tool_name_segments(tool: str) -> List[str]:
    """Split a tool name into lowercase tokens, handling ``snake_case`` / ``kebab-case`` /
    ``camelCase``."""
    return [s.lower() for s in re.findall(r"[A-Za-z][a-z]*", tool)]


def _is_readonly_mcp(tool: str) -> bool:
    """Whether an MCP tool is read-only: it starts with a read verb **and** its name
    contains no write verb.

    Looking only at the prefix would wrongly allow ``get_or_create_page`` /
    ``search_and_replace`` / ``fetch_and_upload`` — tools that start with a read verb but
    actually write — which is letting the reviewed party decide whether to be reviewed.
    """
    if not _matches_full(_MCP_READONLY_RE, tool):
        return False
    return not (set(_tool_name_segments(tool)) & reg.MCP_WRITE_VERBS)


def _tool_risk_surface(tool: str, cap: Capability, args: Dict[str, str]) -> bool:
    """Whether a network / MCP tool touches the risk surface (the auto iron rule:
    everything else passes by default).

    * MCP — what it can do depends on which server the user installed, so the direction is
      "allow-list the readers, stay conservative about the rest";
    * Network — only **write-type** operations (upload / download / cookies / injecting
      scripts) count as risk surface, while navigation / screenshots / snapshots / search
      are read-only observation and are allowed, otherwise every step of a browser task
      would wait on the classifier. A plain GET fetching data is not exfiltration: to
      exfiltrate sensitive data you must first read it, and a sensitive read is already
      inside the risk surface (see ``_mode_policy``).

    The risk surface of the other capabilities (EXECUTE / EDIT …) is decided elsewhere —
    command patterns in ``_classify_single_bash``, and structural boundary / sensitivity
    risks derived directly from the decision fields by ``_mode_policy``.
    """
    if cap is Capability.MCP:
        return not _is_readonly_mcp(tool)
    if cap is Capability.NETWORK:
        upload_arg = reg.NETWORK_UPLOAD_FILE_ARGUMENTS.get(tool)
        uploads_local_file = bool(str(args.get(upload_arg) or "").strip()) if upload_arg else False
        return _matches_full(_NETWORK_RISK_RE, tool) or uploads_local_file
    # Unregistered tools fall through to EXECUTE (no entry in ``TOOL_CAPABILITY`` maps to EXECUTE,
    # so EXECUTE ⟺ unregistered here) — unknown means review. Otherwise adding a tool and
    # forgetting to register it would silently grant it a full pass under auto, a hole that only
    # gets worse as the tool surface grows.
    if cap is Capability.EXECUTE:
        return True
    return False


# ---------------------------------------------------------------------------
# Platform shell commands
# ---------------------------------------------------------------------------
def _classify_powershell(
    command: str,
    execution_cwd: Optional[str],
    ws: str,
    mounts: List[str],
    writable: List[str],
    gated: List[str],
) -> Judgement:
    """Conservatively classify common Windows PowerShell commands."""
    parts = [
        _classify_single_powershell(
            segment,
            execution_cwd,
            ws,
            mounts,
            writable,
            gated,
        )
        for segment in _split_powershell_command(command)
    ]
    return _most_severe(parts)


def _split_powershell_command(command: str) -> List[str]:
    """Split common compound syntax while preserving quoted separators."""
    parts: List[str] = []
    start = 0
    quote = ""
    escaped = False
    index = 0
    while index < len(command):
        char = command[index]
        if escaped:
            escaped = False
            index += 1
            continue
        if char == "`":
            escaped = True
            index += 1
            continue
        if quote:
            if char == quote:
                quote = ""
            index += 1
            continue
        if char in {"'", '"'}:
            quote = char
            index += 1
            continue
        separator_width = 0
        if char in {";", "\n", "\r"}:
            separator_width = 1
        elif char in {"|", "&"}:
            separator_width = 2 if index + 1 < len(command) and command[index + 1] == char else 1
        if separator_width:
            part = command[start:index].strip()
            if part:
                parts.append(part)
            index += separator_width
            start = index
            continue
        index += 1
    tail = command[start:].strip()
    if tail:
        parts.append(tail)
    return parts or [command]


def _classify_single_powershell(
    command: str,
    cwd: Optional[str],
    ws: str,
    mounts: List[str],
    writable: List[str],
    gated: List[str],
) -> Judgement:
    try:
        tokens = shlex.split(command, posix=False)
    except ValueError:
        tokens = command.split()
    tokens = [token.strip("\"'") for token in tokens]
    if tokens and tokens[0] in {"&", "."}:
        tokens = tokens[1:]
    if not tokens:
        return Judgement(
            capability=Capability.EXECUTE,
            cwd=cwd,
            label=_label(Capability.EXECUTE, Boundary.NONE, False, False),
        )

    command_name = ntpath.basename(os.path.basename(tokens[0])).casefold()
    if command_name in reg.POWERSHELL_HARD_DENY_COMMANDS:
        return Judgement(
            hard_deny=True,
            capability=Capability.EXECUTE,
            touches_risk_surface=True,
            cwd=cwd,
            label=_label(Capability.EXECUTE, Boundary.NONE, False, True),
        )

    operands = [
        token.rstrip(",")
        for token in tokens[1:]
        if token and not token.startswith("-") and token not in {">", ">>", "2>", "2>>"}
    ]
    if command_name in reg.POWERSHELL_DELETE_COMMANDS:
        result = _judge_deletion(operands, cwd, ws, mounts, writable, gated)
        provider_target = any(
            re.match(r"^[A-Za-z][\w.-]*:", target)
            and not re.match(r"^[A-Za-z]:[\\/]", target)
            for target in operands
        )
        if provider_target:
            result = result.model_copy(update={
                "boundary": Boundary.OUT_OF_BOUNDS,
                "uncertain_destruction": True,
                "label": _label(Capability.EDIT, Boundary.OUT_OF_BOUNDS, False, False),
            })
        return result

    if command_name in reg.POWERSHELL_READ_COMMANDS | reg.POWERSHELL_EDIT_COMMANDS:
        if not operands and command_name in {"dir", "gci", "get-childitem", "ls"}:
            operands = ["."]
        reals = [
            resolve_real_path(path, cwd)
            for path in operands
            if cwd is not None and not _target_dynamic(path)
        ]
        boundary = _paths_boundary(reals, ws, mounts, writable, gated)
        sensitive = any(_is_sensitive(path) for path in [*operands, *reals])
        redirects = output_redirect_targets(command)
        cap = (
            Capability.EDIT
            if command_name in reg.POWERSHELL_EDIT_COMMANDS or redirects
            else Capability.READ
        )
        return Judgement(
            capability=cap,
            boundary=boundary,
            sensitive=sensitive,
            cwd=cwd,
            label=_label(cap, boundary, sensitive, False),
        )

    result = _classify_single_bash(command, cwd, ws, mounts, writable, gated)
    registry_delete = (
        command_name in {"reg", "reg.exe"}
        and len(tokens) > 1
        and tokens[1].casefold() == "delete"
    )
    if (
        command_name in reg.POWERSHELL_DANGEROUS_COMMANDS
        or "-" in command_name
        or registry_delete
    ):
        result = result.model_copy(update={
            "capability": Capability.EXECUTE,
            "touches_risk_surface": True,
            "label": _label(
                Capability.EXECUTE,
                result.boundary,
                result.sensitive,
                False,
            ),
        })
    return result


def _classify_bash(
    command: str,
    execution_cwd: Optional[str],
    ws: str,
    mounts: List[str],
    writable: List[str],
    gated: List[str],
) -> Judgement:
    tagged = split_compound_command_tagged(command) or [(command, False)]
    subs = [sub for sub, _ in tagged]
    cwds = running_cwds(subs, execution_cwd)  # track cd in order, giving each segment a runtime cwd (None when unknown)
    parts: List[Judgement] = []
    for (sub, in_heredoc), cwd in zip(tagged, cwds):
        targets = _deletion_targets(sub)
        if targets is not None:  # a deletion command → go through the deletion rules (system disk / uncertain / in-workspace)
            parts.append(_judge_deletion(targets, cwd, ws, mounts, writable, gated))
        else:
            parts.append(_classify_single_bash(
                strip_process_wrappers(sub), cwd, ws, mounts, writable, gated, in_heredoc,
            ))
    result = _most_severe(parts)
    # The risk surface is checked once more against **the whole raw command**: the pipeline shape
    # (curl … | sh) has no ``|`` left in its split sub-commands, so only the whole-command match
    # catches it.
    if not result.touches_risk_surface and _matches_full(_RISK_CMD_RE, command):
        result = result.model_copy(update={"touches_risk_surface": True})
    if not result.hard_deny and _matches_full(_HARD_DENY_RE, command):
        result = result.model_copy(
            update={
                "hard_deny": True,
                "capability": Capability.EXECUTE,
                "label": _label(Capability.EXECUTE, result.boundary, result.sensitive, True),
            }
        )
    return result


# ---------------------------------------------------------------------------
# Deletion rules: target extraction + system-disk / uncertain / boundary ruling
# ---------------------------------------------------------------------------
def _deletion_targets(cmd: str) -> Optional[List[str]]:
    """Recognise a command as a deletion and extract **all** of its delete targets;
    returns ``None`` for a non-deletion command.

    Covers ``rm`` (recursive and not) and deleting forms of ``find`` (``-delete`` /
    ``-exec rm``); wrappers such as ``sudo``/``env``/``command`` are stripped first (see
    :func:`~_normalize.strip_delete_wrappers`) and extraction then keys off argv0. For
    ``rm`` it handles the ``--`` end-of-options marker, skips flags and keeps plain names.
    """
    tokens = strip_delete_wrappers(cmd).split()
    if not tokens:
        return None
    # Take the basename and strip the shell-escape prefix so ``/bin/rm`` / ``\rm`` are judged the
    # same as ``rm`` (_extract_path_operands in this file already uses basename; not doing it here
    # would mean two different standards).
    argv0 = os.path.basename(tokens[0].lstrip("\\"))
    if argv0 == "rm":
        return _rm_targets(tokens[1:])
    if argv0 == "find":
        return _find_targets(tokens[1:])
    return None


def _rm_targets(rest: List[str]) -> List[str]:
    targets: List[str] = []
    end_of_opts = False
    for tok in rest:
        if not end_of_opts and tok == "--":
            end_of_opts = True
            continue
        if not end_of_opts and tok.startswith("-"):
            continue  # an option flag
        targets.append(tok.strip("\"'"))
    return targets


def _find_targets(rest: List[str]) -> Optional[List[str]]:
    """A deleting find (``-delete`` / ``-exec rm``) → its starting paths (everything
    before the first ``-predicate``); a non-deleting find → ``None`` (it does not go
    through the deletion rules and is handled by the read-only allow-list)."""
    if "-delete" not in rest and not _find_has_exec_rm(rest):
        return None
    paths: List[str] = []
    for tok in rest:
        if tok.startswith("-"):
            break
        paths.append(tok.strip("\"'"))
    return paths


def _find_has_exec_rm(rest: List[str]) -> bool:
    return any(
        tok in ("-exec", "-execdir") and i + 1 < len(rest) and rest[i + 1] == "rm"
        for i, tok in enumerate(rest)
    )


def _judge_deletion(
    targets: List[str],
    cwd: Optional[str],
    ws: str,
    mounts: List[str],
    writable: List[str],
    gated: List[str],
) -> Judgement:
    """Judge a set of delete targets: the capability is always EDIT; hitting a
    system-critical directory → hard_deny; containing a variable / command substitution,
    or an unknown cwd → uncertain_destruction; deleting a sensitive path → sensitive;
    every target being a regenerable artifact → regenerable; and the boundary is computed
    from the resolvable targets.

    ``sensitive`` used to be missed by the deletion rules, which made ``rm -rf ~/.ssh``
    out-of-bounds but not sensitive and silently allowed in full mode; adding it here,
    combined with the rule layer's "deleting something sensitive is confirmed in all three
    modes", closes that hole.
    ``regenerable`` is true only when **every target resolves and every one is a
    regenerable artifact** (conservative): if any target is real source or data, or
    contains a variable that cannot be confirmed, it is false."""
    uncertain = cwd is None or any(_target_dynamic(t) for t in targets)
    hard = cwd is not None and any(_target_hits_system(t, cwd) for t in targets)
    reals = [r for t in targets if cwd is not None and (r := _resolve_target(t, cwd))]
    boundary = _paths_boundary(reals, ws, mounts, writable, gated)
    sensitive = any(_is_sensitive(r) for r in reals)
    regenerable = (
        not uncertain
        and bool(targets)
        and all(_target_regenerable(t, cwd) for t in targets)
    )
    return Judgement(
        hard_deny=hard,
        capability=Capability.EDIT,
        boundary=boundary,
        sensitive=sensitive,
        uncertain_destruction=uncertain,
        deletion=True,
        regenerable=regenerable,
        cwd=cwd,
        label=_label(Capability.EDIT, boundary, sensitive, hard),
    )


def _target_regenerable(target: str, cwd: Optional[str]) -> bool:
    """Whether a delete target is a regenerable artifact (cache / dependency / build
    output).

    * Caches / dependencies (``REGENERABLE_SEGMENTS`` + ``*.egg-info``) — a hit on **any
      segment** of the real path;
    * Build output (``dist`` / ``build`` / ``target``) — only a hit on the **last segment
      of the delete target**, so ``rm build/src/main.c`` is not misjudged as regenerable
      (see the trade-off note in _registry).

    A target containing a variable or otherwise unresolvable (``_resolve_target`` returns
    empty) → False (it cannot be confirmed, so stay conservative)."""
    if cwd is None:
        return False
    real = _resolve_target(target, cwd)
    if not real:
        return False
    segments = [s for s in real.replace("\\", "/").split("/") if s]
    if any(s in reg.REGENERABLE_SEGMENTS for s in segments):
        return True
    if any(rx.fullmatch(s) for s in segments for rx in _REGEN_SEG_PAT_RE):
        return True
    return bool(segments) and segments[-1] in reg.REGENERABLE_LEAF_ONLY


def _is_home_target(t: str) -> bool:
    """Whether the target is an unambiguous home directory (``~`` / ``$HOME``, including
    paths beneath it)."""
    return (
        t in ("~", "$HOME", "${HOME}")
        or t.startswith("~/")
        or t.startswith("$HOME/")
        or t.startswith("${HOME}/")
    )


def _target_dynamic(t: str) -> bool:
    """Whether the target contains runtime expansion (a variable / command substitution /
    backticks) — excluding ``~``/``$HOME``, whose meaning is unambiguous."""
    t = t.strip("\"'")
    if _is_home_target(t):
        return False
    return "$" in t or "`" in t


def _resolve_target(t: str, cwd: str) -> str:
    """Resolve a delete target into a real path (for the system-disk and boundary
    checks). A target that is a variable cannot be resolved → ``""``.

    A bare ``*`` means the contents of the current directory (so cwd itself is used), and
    ``<base>/*`` means the contents of base (so base is used); ``~`` / ``$HOME`` expand to
    the home directory.
    """
    t = t.strip("\"'")
    if t == "*":
        base = cwd
    elif t.endswith("/*"):
        base = t[:-2]
    else:
        base = t
    if _is_home_target(base):
        home = os.path.realpath(os.path.expanduser("~"))
        for prefix in ("~/", "$HOME/", "${HOME}/"):
            if base.startswith(prefix):
                return os.path.realpath(os.path.join(home, base[len(prefix):]))
        return home
    if "$" in base or "`" in base:
        return ""  # a variable — not statically resolvable
    return resolve_real_path(base, cwd)


def _target_hits_system(t: str, cwd: str) -> bool:
    real = _resolve_target(t, cwd)
    return bool(real) and real in reg.SYSTEM_CRITICAL_DIRS


def _classify_single_bash(
    cmd: str,
    cwd: Optional[str],
    ws: str,
    mounts: List[str],
    writable: List[str],
    gated: List[str],
    in_heredoc_body: bool = False,
) -> Judgement:
    hard = _matches_full(_HARD_DENY_RE, cmd)
    dangerous = _matches_full(_DANGEROUS_RE, cmd)
    redirects = output_redirect_targets(cmd)
    # A heredoc body is **data** fed to stdin, and its tokens are not shell path operands: the
    # ``/`` in an inlined Python ``Path.home() / 'x'`` would be lifted out as a path, and a bare
    # ``/`` = the filesystem root → the whole command gets dragged to out-of-bounds (observed
    # slipping past the classifier once). The dangerous-command matching above and the deletion
    # rules outside **still apply to the body** — ``bash <<'EOF' … rm -rf / … EOF`` still hits the
    # hard red line; only path extraction is disabled here.
    operands = [] if in_heredoc_body else (_extract_path_operands(cmd) if cwd is not None else [])
    # An absolute redirect target does not depend on cwd, so the boundary is determinable even
    # when cwd is unknown (restoring the out-of-bounds signal).
    reals = [resolve_real_path(p, cwd) for p in operands]
    reals += [resolve_real_path(p, cwd) for p in redirects if cwd is not None or os.path.isabs(p)]
    boundary = _paths_boundary(reals, ws, mounts, writable, gated)
    sensitive = any(_is_sensitive(r) for r in reals)

    if hard or dangerous:
        cap = Capability.EXECUTE
    elif _matches_full(_READ_CMD_RE, cmd):
        # Read-only command + write redirect = writing a file (``cat > /outside/f``). This only
        # prevents a READ verdict; it does **not** downgrade EXECUTE to EDIT — otherwise
        # ``curl … > f`` would become EDIT + in-workspace and be allowed outright by ③.
        cap = Capability.EDIT if redirects else Capability.READ
    elif _matches_full(_EDIT_CMD_RE, cmd):
        cap = Capability.EDIT
    else:
        cap = Capability.EXECUTE
    return Judgement(
        hard_deny=hard,
        capability=cap,
        boundary=boundary,
        sensitive=sensitive,
        # Dangerous execution (sudo / chmod 777 / chown -R / killall / find -exec …) is inherently
        # part of the risk surface. Without setting this, DANGEROUS_COMMANDS is a no-op — it only
        # sets cap to EXECUTE, and EXECUTE is already the fallback, so after the rule flipped a hit
        # and a miss produce identical results.
        touches_risk_surface=dangerous or _matches_full(_RISK_CMD_RE, cmd),
        cwd=cwd,
        label=_label(cap, boundary, sensitive, hard),
    )


# Tokens that look like paths but are not: URLs / ``pkg@1.2.3`` / ``requests==2.31.0``.
# Without excluding them the ``"." in tok`` heuristic would treat version numbers, package names
# and domains as paths — the consequence is not just a noisy boundary (``npm i lodash`` judged
# NONE, ``npm i pkg@1.2.3`` judged IN_WORKSPACE); worse, a URL gets resolved into a relative path
# under cwd, handing the classifier a **false "inside the workspace" signal**.
# Note: a token containing ``/`` matches none of the three branches → out-of-bounds paths and
# sensitive paths (which always contain ``/``) are never hit by mistake.
_NON_PATH_TOKEN_RE = re.compile(
    r"[\w.+-]+://.*"                   # URL:https:// git+ssh:// file://
    r"|[\w.+-]+@[\w.*+-]+"             # pkg@1.2.3 (bare @; ``@scope/pkg`` contains / and does not match)
    r"|[\w.+-]+[=<>!~]{1,2}[\w.*+-]+"  # requests==2.31.0 / pkg>=1.0
)


def _is_path_like(tok: str) -> bool:
    """Whether a token looks like a path. Anything containing ``/`` is always true
    (out-of-bounds and sensitive paths necessarily contain ``/``)."""
    return "://" not in tok and not _NON_PATH_TOKEN_RE.fullmatch(tok)


def _extract_path_operands(cmd: str) -> List[str]:
    """Extract the path operands of file-type commands from a command."""
    try:
        tokens = shlex.split(cmd)
    except ValueError:
        tokens = cmd.split()
    if not tokens:
        return []

    uv_pip_install = (
        len(tokens) >= 3
        and os.path.basename(tokens[0]) in {"uv", "uv.exe"}
        and tokens[1:3] == ["pip", "install"]
    )

    def is_shared_base_python(value: str) -> bool:
        if not uv_pip_install:
            return False
        expanded = os.path.expanduser(value.strip("\"'"))
        if not os.path.isabs(expanded):
            return False
        base = os.path.join(
            os.path.expanduser("~"),
            ".bridgic",
            "AmphiAgent",
            "python",
            "base",
        )
        try:
            return os.path.commonpath((os.path.abspath(expanded), base)) == base
        except ValueError:
            return False

    path_command = os.path.basename(tokens[0]) in _PATH_OPERAND_COMMANDS
    out: List[str] = []
    for index, tok in enumerate(tokens[1:], start=1):
        if (
            uv_pip_install
            and index > 0
            and tokens[index - 1] == "--python"
            and is_shared_base_python(tok)
        ):
            continue
        if uv_pip_install and tok.startswith("--python="):
            value = tok.split("=", 1)[1]
            if not is_shared_base_python(value):
                out.append(value)
            continue
        if tok.startswith("-"):
            continue
        # ``key=value`` (e.g. ``dd of=/dev/sda``): the value may also be a path — **both** the
        # original token and the value are candidates, each going through _is_path_like. Keeping
        # only the value would lose the sensitive signal in ``cat x=.env``; keeping only the
        # original token would lose the write target in ``dd of=out.img``.
        if "=" in tok and not tok.startswith("/"):
            value = tok.split("=", 1)[1]
            if value and _is_path_like(value) and (path_command or "/" in value or "." in value):
                out.append(value)
        if not _is_path_like(tok):
            continue
        if path_command or "/" in tok or "." in tok:
            out.append(tok)
    if not out and os.path.basename(tokens[0]) in _IMPLICIT_CWD_COMMANDS:
        out.append(".")
    return out


# ---------------------------------------------------------------------------
# Path boundary / sensitivity / severity / wording
# ---------------------------------------------------------------------------
def _path_boundary(
    real: str, ws: str, mounts: List[str], writable: List[str], gated: List[str],
) -> Boundary:
    if not real:
        return Boundary.NONE
    # More specific projections must win even when they live below ``.work``.
    # In particular, the active Workflow Run is ``.work/.run``: only its
    # result/work subtrees are writable, its source is a read-only mount, and
    # the remaining framework-owned files stay gated.
    for root in writable:
        if root and _is_within(real, os.path.realpath(root)):
            return Boundary.IN_WORKSPACE
    for m in mounts:
        if m and _is_within(real, os.path.realpath(m)):
            return Boundary.IN_MOUNT
    # Gated roots (e.g. the workflow-run space): a path under one of them that was not granted by
    # the writable list above → forced OOB, which **outranks** the app_home/temp prefix allowance
    # below. This preserves the precise isolation of "only result/work are writable, background is
    # protected" so it cannot be bypassed by the blanket ~/.bridgic or /tmp allowance.
    for g in gated:
        if g and _is_within(real, os.path.realpath(g)):
            return Boundary.OUT_OF_BOUNDS
    if ws and _is_within(real, os.path.realpath(ws)):
        return Boundary.IN_WORKSPACE
    # The bundled-skills directory: the product's own code, whose SKILL.md instructs the agent to
    # run the scripts inside it. It ranks **before** app_home / temp because it is stricter (writes
    # and deletes are not allowed): if the install directory happens to sit under /tmp or
    # ~/.bridgic (as it may in development), hitting those two first would silently allow writes.
    for root in reg.APP_BUILTIN_ROOTS:
        if _is_within(real, root):
            return Boundary.IN_APP_BUILTIN
    # Trusted directories: this app's data directory ~/.bridgic and the system temp directory.
    # Both root sets were already normalised to realpath in _registry, so no realpath here.
    # workspace / writable / mount are more specific and matched earlier above (the session
    # workspace lives under ~/.bridgic/.../sessions, so it always judges IN_WORKSPACE, never
    # app_home).
    for root in reg.APP_HOME_ROOTS:
        if _is_within(real, root):
            return Boundary.IN_APP_HOME
    for root in reg.TEMP_ROOTS:
        if _is_within(real, root):
            return Boundary.IN_TEMP
    return Boundary.OUT_OF_BOUNDS


def _paths_boundary(
    reals: List[str], ws: str, mounts: List[str], writable: List[str], gated: List[str],
) -> Boundary:
    resolved = [_path_boundary(r, ws, mounts, writable, gated) for r in reals if r]
    if not resolved:
        return Boundary.NONE
    return max(resolved, key=lambda b: _BOUNDARY_SEVERITY[b])


def _is_within(candidate: str, root: str) -> bool:
    """Whether ``candidate`` is ``root`` itself or beneath it (anchored on path segments,
    so a sibling directory does not count as inside)."""
    try:
        rel = os.path.relpath(candidate, root)
    except ValueError:
        return False
    return rel == os.curdir or not (rel == os.pardir or rel.startswith(os.pardir + os.sep))


def _is_sensitive(real: str) -> bool:
    """Whether a path hits the sensitive list (``SENSITIVE_PATHS``).

    ``\\`` is normalised to ``/`` before matching: every pattern in the list is written in
    ``/`` form (``/\\.ssh(?:/|$)`` and friends), while Windows's ``os.path.realpath``
    returns ``C:\\Users\\x\\.ssh\\id_rsa``. Without this step **the entire sensitive-path
    check silently stops working on Windows** — reads and writes of `.ssh` / `.aws`
    credentials / `.git-credentials` / browser cookie stores would no longer trigger
    approval, and those are the primary targets when prompt injection goes hunting for
    credentials. Found during the first Windows bare-metal investigation on 2026-07-28.
    """
    if not real:
        return False
    return any(rx.search(real.replace("\\", "/")) for rx in _SENSITIVE_RE)


def _matches_full(patterns: List["re.Pattern[str]"], text: str) -> bool:
    return any(rx.fullmatch(text) for rx in patterns)


def _most_severe(parts: List[Judgement]) -> Judgement:
    if not parts:
        return Judgement(capability=Capability.EXECUTE, label=_label(Capability.EXECUTE, Boundary.NONE, False, False))
    hard = any(p.hard_deny for p in parts)
    cap = max((p.capability for p in parts), key=lambda c: _CAP_SEVERITY[c])
    boundary = max((p.boundary for p in parts), key=lambda b: _BOUNDARY_SEVERITY[b])
    sensitive = any(p.sensitive for p in parts)
    uncertain = any(p.uncertain_destruction for p in parts)
    deletion = any(p.deletion for p in parts)
    # Conservative merge: the whole command counts as regenerable only if **every** delete segment
    # is regenerable — the real deletion in ``rm __pycache__ && rm src/x.py`` drags the whole thing
    # back to non-regenerable, so a compound command is not allowed wholesale just because it
    # carries one safe cleanup.
    regenerable = deletion and all(p.regenerable for p in parts if p.deletion)
    # The risk surface takes "any segment hits" — ``ls && sudo rm`` sends the whole command to
    # review as touching the risk surface.
    risk = any(p.touches_risk_surface for p in parts)
    cwd_part = max(parts, key=lambda p: (
        p.hard_deny,
        p.uncertain_destruction,
        p.sensitive,
        _CAP_SEVERITY[p.capability],
        _BOUNDARY_SEVERITY[p.boundary],
    ))
    return Judgement(
        hard_deny=hard,
        capability=cap,
        boundary=boundary,
        sensitive=sensitive,
        uncertain_destruction=uncertain,
        deletion=deletion,
        regenerable=regenerable,
        touches_risk_surface=risk,
        cwd=cwd_part.cwd,
        label=_label(cap, boundary, sensitive, hard),
    )


def label_text(label_id: str, *, locale: Locale | None = None) -> str:
    """Render a label id, defaulting to the active request locale.

    The judgement carries the id rather than the rendered text because the same label is
    consumed twice in **different** languages: the approval card wants the user's language,
    the classifier reads it inside an all-English system prompt. An empty id (a capability
    with no label) renders as an empty string instead of raising.

    An unknown id fails soft: the permission gate must degrade to showing the raw id,
    not crash the whole turn — a missing translation is a display defect, and the
    engine's fail-closed guarantees live in the verdicts, not here. The catalog-closure
    test pins the id domain so this branch never fires outside a genuine drift.
    """
    if not label_id:
        return ""
    try:
        return backend_i18n.text(label_id, locale=locale)
    except KeyError:
        _logger.error("Unknown security label id %r; rendering the id itself", label_id)
        return label_id


def _label(cap: Capability, boundary: Boundary, sensitive: bool, hard: bool) -> str:
    """The judgement's label **id** — never display text, see :func:`label_text`."""
    if hard:
        return "security.label.system_dangerous_operation"
    if sensitive:
        return "security.label.sensitive_file_access"
    if cap is Capability.EXECUTE:
        return "security.label.execute_command"
    if cap is Capability.NETWORK:
        return "security.label.network_access"
    if cap is Capability.MCP:
        return "security.label.external_tool_call"
    if cap is Capability.EDIT:
        # The bundled-skills directory is called out separately so that the fact "what is being
        # modified is the agent's own bundled skill definition" is explicit to the classifier and
        # the approval card (it is exactly what soft_deny's 'self-modification' targets) instead of
        # making the model guess it from the path.
        if boundary is Boundary.IN_APP_BUILTIN:
            return "security.label.modify_builtin_skill"
        return "security.label.edit_outside_workspace" if boundary is Boundary.OUT_OF_BOUNDS else "security.label.edit_file"
    if cap is Capability.READ:
        return "security.label.read_file"
    if cap is Capability.MANAGE_WRITE:
        return "security.label.in_app_write"
    if cap is Capability.MANAGE:
        return "security.label.management_operation"
    return ""
