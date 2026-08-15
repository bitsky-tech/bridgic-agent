import os
import re
from pathlib import Path
from typing import Dict, List, Tuple

from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec


FILE_SYSTEM_TOOL_NAMES = frozenset({
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "grep",
})

# read_file caps — conventional model-friendly sizes that prevent one oversized
# read from crowding out the rest of the context.
DEFAULT_MAX_LINES: int = 2000
MAX_LINE_LENGTH: int = 2000
MAX_FILE_BYTES: int = 5 * 1024 * 1024  # 5 MB
# Search-tool caps — bound output so a sloppy pattern can't flood the prompt.
GLOB_MAX_RESULTS: int = 100
GREP_MAX_FILES_SCANNED: int = 5_000
GREP_MAX_RESULTS: int = 200


################################################################################################################
# Workspace anchoring — the one behavior we own over the framework's tools
################################################################################################################


def workspace_root() -> str:
    """The active Agent Workspace's work directory, or a clear failure."""
    agent = current_agent.get(None)
    context = getattr(agent, "ctx", None)
    workspace = getattr(context, "workspace", None) if context is not None else None
    root = str(getattr(workspace, "work_dir", "")) if workspace is not None else ""
    if not root:
        raise RuntimeError("filesystem tools require an active Agent Workspace")
    if not os.path.isdir(root):
        raise FileNotFoundError(f"Agent Workspace directory is unavailable: {root}")
    return root


def display_path(path: str) -> str:
    """Render an absolute path relative to the Workspace when it is inside it."""
    if not os.path.isabs(path):
        return path
    try:
        relative = os.path.relpath(path, workspace_root())
    except ValueError:
        return path
    return path if relative.startswith("..") else relative



def _resolve_file(file_path: str) -> str:
    """A required file-path argument → absolute, anchored to the workspace.

    A relative path resolves against the Session work directory; an absolute
    path is used as-is. Empty is rejected.
    """
    raw = (file_path or "").strip()
    if not raw:
        raise ValueError("file_path is required")
    if os.path.isabs(raw):
        return os.path.abspath(raw)
    return os.path.abspath(os.path.join(workspace_root(), raw))


def _resolve_dir(path: str) -> str:
    """A directory argument → absolute, anchored to the workspace.

    Empty means the Session work directory; relative resolves against it;
    absolute is used as-is.
    """
    raw = (path or "").strip()
    if not raw:
        return workspace_root()
    if os.path.isabs(raw):
        return os.path.abspath(raw)
    return os.path.abspath(os.path.join(workspace_root(), raw))


################################################################################################################
# Read-before-modify invariant — reuses the running agent's per-turn tracker
################################################################################################################


def _track_read(abs_path: str) -> None:
    """Record ``abs_path``'s mtime on the agent's per-turn read tracker."""
    agent = current_agent.get(None)
    if agent is None:
        return
    try:
        agent._read_tracker[abs_path] = os.stat(abs_path).st_mtime
    except OSError:
        pass


def _check_read_before_modify(abs_path: str) -> None:
    """Refuse to modify a file not read first, or changed since the read.

    No-op outside an agent run (keeps the tools usable in isolation).

    The invariant this protects: an edit is expressed against the content the
    model has actually seen, so a blind write cannot clobber a file that changed
    underneath it.
    """
    agent = current_agent.get(None)
    if agent is None:
        return
    tracker = agent._read_tracker
    if abs_path not in tracker:
        raise RuntimeError(
            f"You must use read_file to read {display_path(abs_path)} at least "
            "once before modifying it."
        )
    if os.stat(abs_path).st_mtime > tracker[abs_path]:
        raise RuntimeError(
            f"File changed on disk since your last read_file: "
            f"{display_path(abs_path)}. Re-read it before modifying."
        )


################################################################################################################
# The tools
################################################################################################################


async def read_file(file_path: str, offset: int = 0, limit: int = 0) -> str:
    """Read a file from the workspace and return its content with line numbers.

    Output is ``cat -n`` style (line numbers) so a later edit_file can quote a
    uniquely-locatable ``old_string``. Reading a file also marks it safe to
    modify (write_file / edit_file require a prior read).

    Args:
        file_path: Path relative to the Session work directory shown in
            ``<Workspace>``, or an absolute path.
        offset: 1-based line to start at; 0 starts at the first line.
        limit: Max lines to return; 0 uses the default cap of 2000.

    Returns:
        The numbered content (with a marker when truncated), or a notice for an
        empty file / out-of-range offset.
    """
    abs_path = _resolve_file(file_path)
    if not os.path.exists(abs_path):
        raise FileNotFoundError(f"File does not exist: {display_path(abs_path)}")
    if not os.path.isfile(abs_path):
        raise ValueError(f"Not a regular file: {display_path(abs_path)}")
    size = os.path.getsize(abs_path)
    if size > MAX_FILE_BYTES:
        raise ValueError(
            f"File is too large ({size} bytes); maximum is {MAX_FILE_BYTES} bytes."
        )

    with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    _track_read(abs_path)

    if not lines:
        return "(File exists but is empty.)"
    start = max(offset - 1, 0) if offset > 0 else 0
    if start >= len(lines):
        return f"(Offset {offset} is past the end of the file [{len(lines)} lines].)"
    end = min(start + (limit if limit > 0 else DEFAULT_MAX_LINES), len(lines))

    rendered: List[str] = []
    for idx, line in enumerate(lines[start:end], start=start + 1):
        if line.endswith("\n"):
            line = line[:-1]
        if len(line) > MAX_LINE_LENGTH:
            line = line[:MAX_LINE_LENGTH] + "...[line truncated]"
        rendered.append(f"{idx:6d}\t{line}")
    if end < len(lines):
        rendered.append(
            f"... [{len(lines) - end} more lines; pass offset/limit to read further]"
        )
    return "\n".join(rendered)


async def write_file(file_path: str, content: str) -> str:
    """Write ``content`` to a file, creating it (with parents) or overwriting.

    A full overwrite — ``content`` becomes the entire file — so NO prior
    read_file is required (unlike ``edit_file``, which patches existing text and
    must see it first). Missing parent directories are created automatically.

    Args:
        file_path: Path relative to the Session work directory shown in
            ``<Workspace>``, or an absolute path.
        content: The full content to write; existing content is replaced.

    Returns:
        A short confirmation with the byte count.
    """
    abs_path = _resolve_file(file_path)
    exists = os.path.exists(abs_path)
    if exists and not os.path.isfile(abs_path):
        raise ValueError(f"Not a regular file: {display_path(abs_path)}")

    parent = os.path.dirname(abs_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(content)
    _track_read(abs_path)

    action = "Overwrote" if exists else "Created"
    return f"{action} {display_path(abs_path)} ({len(content.encode('utf-8'))} bytes)."


async def edit_file(
    file_path: str, old_string: str, new_string: str, replace_all: bool = False,
) -> str:
    """Replace ``old_string`` with ``new_string`` in a file (exact match).

    ``old_string`` must occur exactly once unless ``replace_all`` is set, so the
    edit lands where you intend. Requires a prior read_file on the file (and
    that it has not changed since).

    Args:
        file_path: Path relative to the Session work directory shown in
            ``<Workspace>``, or an absolute path.
        old_string: Exact substring to replace; must be unique unless
            ``replace_all``. Do NOT include read_file's line-number prefixes.
        new_string: Replacement; may be empty to delete ``old_string``.
        replace_all: Replace every occurrence instead of requiring uniqueness.

    Returns:
        A short confirmation with the number of replacements.
    """
    abs_path = _resolve_file(file_path)
    if not os.path.exists(abs_path):
        raise FileNotFoundError(f"File does not exist: {display_path(abs_path)}")
    if not os.path.isfile(abs_path):
        raise ValueError(f"Not a regular file: {display_path(abs_path)}")
    if not old_string:
        raise ValueError("old_string must not be empty.")
    if old_string == new_string:
        raise ValueError("old_string and new_string are identical — nothing to do.")
    _check_read_before_modify(abs_path)

    with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    occurrences = content.count(old_string)
    if occurrences == 0:
        raise ValueError(
            f"old_string not found in {display_path(abs_path)}. Note read_file's "
            "line-number prefixes must NOT be part of old_string."
        )
    if occurrences > 1 and not replace_all:
        raise ValueError(
            f"old_string occurs {occurrences} times in {display_path(abs_path)}. "
            "Provide a more uniquely-identifying snippet, or set replace_all=True."
        )

    replaced = occurrences if replace_all else 1
    new_content = content.replace(old_string, new_string, -1 if replace_all else 1)
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(new_content)
    _track_read(abs_path)
    return (
        f"Edited {display_path(abs_path)}: replaced {replaced} "
        f"occurrence{'s' if replaced != 1 else ''}."
    )


async def glob(pattern: str, path: str = "") -> str:
    """Find files matching a glob pattern, newest first.

    Supports recursive globs (``**/*.py``) and standard wildcards. Results are
    sorted by modification time, most recent first.

    Args:
        pattern: Glob pattern relative to ``path`` (e.g. ``"**/*.py"``).
        path: Directory relative to the Session work directory shown in
            ``<Workspace>``, or an absolute path; empty means the Session work
            directory itself.

    Returns:
        Matching paths (workspace-relative), one per line, or a "no matches"
        notice.
    """
    if not pattern or not pattern.strip():
        raise ValueError("pattern is required")
    search_root = _resolve_dir(path)
    if not os.path.isdir(search_root):
        raise NotADirectoryError(f"Search path is not a directory: {display_path(search_root)}")

    files = [m for m in Path(search_root).glob(pattern) if m.is_file()]
    if not files:
        return "(No files matched.)"
    files.sort(key=_safe_mtime, reverse=True)
    rendered = [display_path(str(f)) for f in files[:GLOB_MAX_RESULTS]]
    if len(files) > GLOB_MAX_RESULTS:
        rendered.append(
            f"... [{len(files) - GLOB_MAX_RESULTS} more matches truncated; "
            "narrow the pattern]"
        )
    return "\n".join(rendered)


async def grep(
    pattern: str,
    path: str = "",
    glob: str = "",
    output_mode: str = "files_with_matches",
    case_insensitive: bool = False,
    head_limit: int = 0,
) -> str:
    """Search file contents with a regular expression (Python ``re`` flavour).

    Args:
        pattern: Regex to search for.
        path: Directory relative to the Session work directory shown in
            ``<Workspace>``, or an absolute path; empty means the Session work
            directory.
        glob: Optional path filter (e.g. ``"**/*.py"``); empty scans all files.
        output_mode: ``"files_with_matches"`` (default, one path per line),
            ``"count"`` (``path:N``), or ``"content"`` (``path:lineno:line``).
        case_insensitive: Match case-insensitively.
        head_limit: Max result lines; 0 uses the default cap of 200.

    Returns:
        Results per ``output_mode`` (paths workspace-relative), or a "no
        matches" notice.
    """
    if not pattern or not pattern.strip():
        raise ValueError("pattern is required")
    search_root = _resolve_dir(path)
    if not os.path.isdir(search_root):
        raise NotADirectoryError(f"Search path is not a directory: {display_path(search_root)}")
    if output_mode not in ("files_with_matches", "count", "content"):
        raise ValueError(
            f"Unknown output_mode: {output_mode!r}. Use 'files_with_matches', "
            "'count' or 'content'."
        )

    flags = re.MULTILINE | (re.IGNORECASE if case_insensitive else 0)
    regex = re.compile(pattern, flags)  # raises re.error on a bad pattern
    matches_per_file: Dict[str, List[Tuple[int, str]]] = {}
    for file_path in _iter_files(Path(search_root), glob):
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                for lineno, line in enumerate(f, start=1):
                    if regex.search(line):
                        matches_per_file.setdefault(str(file_path), []).append(
                            (lineno, line.rstrip("\n"))
                        )
        except OSError:
            continue
    if not matches_per_file:
        return "(No matches found.)"
    cap = head_limit if head_limit > 0 else GREP_MAX_RESULTS
    return _render_grep(matches_per_file, output_mode, cap)


################################################################################################################
# Module helpers
################################################################################################################


def _safe_mtime(p: Path) -> float:
    """``p``'s mtime, or ``-inf`` when stat fails (so it sorts last)."""
    try:
        return p.stat().st_mtime
    except OSError:
        return float("-inf")


def _iter_files(root: Path, glob_filter: str):
    """Yield up to ``GREP_MAX_FILES_SCANNED`` regular files under ``root``.

    Skips entries inside hidden directories (``.git``, ``.venv``, …) so a
    sloppy regex doesn't drown in metadata.
    """
    count = 0
    for entry in root.glob(glob_filter or "**/*"):
        if not entry.is_file():
            continue
        try:
            rel = entry.relative_to(root)
        except ValueError:
            continue
        if any(part.startswith(".") for part in rel.parts):
            continue
        yield entry
        count += 1
        if count >= GREP_MAX_FILES_SCANNED:
            break


def _render_grep(
    matches_per_file: Dict[str, List[Tuple[int, str]]], output_mode: str, cap: int,
) -> str:
    """Format the match map per ``output_mode``, truncating to ``cap`` lines."""
    if output_mode == "files_with_matches":
        rows = [display_path(p) for p in matches_per_file]
    elif output_mode == "count":
        rows = [f"{display_path(p)}:{len(m)}" for p, m in matches_per_file.items()]
    else:  # "content"
        rows = [
            f"{display_path(p)}:{lineno}:{line}"
            for p, hits in matches_per_file.items()
            for lineno, line in hits
        ]
    truncated = rows[:cap]
    if len(rows) > cap:
        truncated.append(
            f"... [{len(rows) - cap} more results truncated; narrow the pattern "
            "or raise head_limit]"
        )
    return "\n".join(truncated)


read_file_tool: FunctionToolSpec = FunctionToolSpec.from_raw(read_file)
write_file_tool: FunctionToolSpec = FunctionToolSpec.from_raw(write_file)
edit_file_tool: FunctionToolSpec = FunctionToolSpec.from_raw(edit_file)
glob_tool: FunctionToolSpec = FunctionToolSpec.from_raw(glob)
grep_tool: FunctionToolSpec = FunctionToolSpec.from_raw(grep)

__all__ = [
    "FILE_SYSTEM_TOOL_NAMES",
    "read_file_tool",
    "write_file_tool",
    "edit_file_tool",
    "glob_tool",
    "grep_tool",
]
