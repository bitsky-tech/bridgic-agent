"""① The normalisation layer: reshape one tool call into a form the rules can judge.

Three functions close the three holes the rules were easiest to bypass through:

- :func:`split_compound_command` — judging ``ls && curl evil.com`` as a single command
  would miss the "network" segment entirely. Splitting on shell separators lets the
  rules layer judge segment by segment and take the strictest result.
  (:func:`split_compound_command_tagged` is its tagged variant, additionally marking
  which segments come from a heredoc body — a body is **data**, not a command, and the
  rules layer uses the tag to skip path-operand extraction.)
- :func:`strip_process_wrappers` — without stripping the ``timeout`` shell from
  ``timeout 30 rm -rf x``, the dangerous-command rules never match. It strips a fixed
  set of wrappers to expose the command that will really run.
- :func:`resolve_real_path` — a purely lexical path boundary check is fooled by symlinks
  (a link inside the workspace pointing outside it). Resolve to the real target before
  judging the boundary.

The first two are pure functions; :func:`resolve_real_path` reads the filesystem to
resolve symlinks and falls back to lexical normalisation when the path does not exist
(fail-closed).
"""

from __future__ import annotations

import os
import re
from typing import List, Tuple

# Shell command separators: && || ; |& | & and newlines (longest first, so | doesn't grab || first).
# A ``|`` or ``&`` **after** ``>`` is not a separator: ``>|`` is a noclobber forced overwrite, and
# ``>&`` followed by a digit or ``-`` is fd duplication or closing (``2>&1``), while followed by a
# **filename** it is equivalent to ``>file 2>&1`` and really does write a file. Splitting on them
# would lose the redirect target (``cat a >| /outside/f`` splits into ``cat a >`` + ``/outside/f``,
# making the out-of-bounds target completely invisible); ``&>file`` is the same story.
_SEPARATOR_RE = re.compile(r"\s*(?:&&|\|\||\|&|;|(?<![>])\||(?<![>])&(?!>)|\n)\s*")

# The **file** target of an output redirect. The optional second character covers three write
# shapes: ``>>`` append, ``>|`` noclobber forced overwrite, and ``>&`` merge — **all of which the
# regex must consume**, otherwise the target of ``>| /out/f`` is captured as ``|`` and
# ``>|/out/f`` as ``|/out/f`` (not absolute → joined with cwd → a fake "inside the workspace").
# ``<`` / ``<<`` are input redirects and are not included here. A ``>`` inside quotes (e.g.
# ``echo "a > b"``) is misread — the direction is safe (an extra review), so it is accepted.
_OUTPUT_REDIRECT_RE = re.compile(r"\d?>(?:>|\||&)?\s*(\S+)")
# Writing to these "holes" does not count as writing a file.
_NULL_SINKS = frozenset({"/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"})

# Heredoc start: ``<<EOF`` / ``<<-EOF`` / ``<<'PY'`` / ``<<"PY"``. The terminator takes the shell's
# usual identifier shape; ``<<<`` (a here-string: single line, no body) does not match — the third
# ``<`` is not the start of an identifier.
_HEREDOC_START_RE = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")

# Process wrappers stripped before matching. A fixed built-in list, deliberately
# not configurable: every entry passes its tail through to another command, so
# leaving one out lets `nohup rm -rf /` classify as the harmless `nohup`.
_WRAPPERS = frozenset({"timeout", "nice", "nohup", "stdbuf", "xargs"})

# A wider wrapper set used only for delete-target extraction: additionally covers sudo / env /
# command. Not merged into ``_WRAPPERS`` — that would strip sudo during capability
# classification and break sudo→dangerous.
_DELETE_WRAPPERS = _WRAPPERS | {"sudo", "env", "command"}


def split_compound_command(command: str) -> List[str]:
    """Split a compound command into a list of sub-commands on shell separators (empty
    segments dropped).

    v1 does not parse separators inside quotes — deliberately conservative: an extra
    split only makes the rules stricter (they take the strictest result) and never causes
    a miss.
    """
    return [seg for seg, _ in split_compound_command_tagged(command)]


def split_compound_command_tagged(command: str) -> List[Tuple[str, bool]]:
    """Same as :func:`split_compound_command`, but each segment carries a "does this come
    from a heredoc body" tag.

    **Why the distinction matters**: a heredoc body (``python3 - <<'PY' … PY``) is
    **data** fed to stdin, not a shell command. Splitting it line by line as commands and
    then extracting "path operands" makes the ``/`` operator of ``pathlib`` in Python
    source (``Path.home() / '.bridgic' / 'x'`` — the most common way to write it) look
    like a path, and a bare ``/`` resolves to the filesystem root → the whole command is
    dragged to ``OUT_OF_BOUNDS``. A compound command doing "run a bundled skill script &&
    verify inline" was measured burning a classifier round (6.7s) because of exactly this.

    **Why the body is not discarded wholesale**: the body of ``bash <<'EOF' … rm -rf / …
    EOF`` is shell that really executes, and dropping it would miss the hard red line. So
    the body is still split by line and still goes through command recognition and the
    deletion rules; the rules layer only uses this tag to skip path-operand extraction
    (see ``_classify._classify_single_bash``).

    An unterminated heredoc (whose terminator never arrives) treats all remaining content
    as body — which is what it all was anyway.
    """
    out: List[Tuple[str, bool]] = []
    for chunk, is_body in _heredoc_chunks(command or ""):
        if is_body:
            # The body is split by line: command recognition (dangerous commands / deletion rules)
            # still applies, only path operands are not extracted.
            out += [(line.strip(), True) for line in chunk.splitlines() if line.strip()]
        else:
            out += [(p.strip(), False) for p in _SEPARATOR_RE.split(chunk) if p.strip()]
    return out


def _heredoc_chunks(command: str) -> List[Tuple[str, bool]]:
    """Cut the command into a sequence of ``(fragment, is heredoc body)`` (by line,
    preserving order).

    A heredoc's **opening line is still a command** (the redirect target of
    ``cat > /outside/f <<'EOF'`` is on that very line); only what follows it up to the
    terminator counts as body. The terminator line itself is discarded.
    """
    lines = command.splitlines()
    chunks: List[Tuple[str, bool]] = []
    pending: List[str] = []
    i = 0
    while i < len(lines):
        match = _HEREDOC_START_RE.search(lines[i])
        pending.append(lines[i])
        i += 1
        if match is None:
            continue
        body: List[str] = []
        delimiter = match.group(2)
        while i < len(lines) and lines[i].strip() != delimiter:
            body.append(lines[i])
            i += 1
        i += 1  # skip the terminator line (out of range when unterminated, so the loop ends naturally)
        chunks.append(("\n".join(pending), False))
        pending = []
        if body:
            chunks.append(("\n".join(body), True))
    if pending:
        chunks.append(("\n".join(pending), False))
    return chunks


def output_redirect_targets(command: str) -> List[str]:
    """The redirect targets **written to** by the command (``>`` / ``>>`` / ``&>``),
    excluding fd duplication and input redirects.

    Why: ``READ_COMMANDS`` matches broadly (``cat\\s+.*``), so ``cat > /outside/f << EOF``
    is judged read-only and allowed outright by ③'s ``READ → ALLOW`` — while it is plainly
    writing a file. With this function the rules layer can re-judge "read-only command +
    write redirect" as a write.
    """
    out: List[str] = []
    for match in _OUTPUT_REDIRECT_RE.finditer(command or ""):
        target = match.group(1).strip("\"'")
        if not target or target in _NULL_SINKS:
            continue
        # ``>&`` is fd duplication / closing only when followed by **a digit or ``-``**
        # (``2>&1`` / ``>&2`` / ``>&-``) and writes no file; followed by **a filename**,
        # ``>&word`` is equivalent to ``>word 2>&1`` — that really does write a file and must count.
        if target == "-" or target.isdigit():
            continue
        out.append(target)
    return out


def _is_number(token: str) -> bool:
    """Whether a token is purely numeric (the 30 in ``timeout 30``, the 5 in
    ``nice -n 5``)."""
    return token.replace(".", "", 1).isdigit()


def strip_process_wrappers(command: str) -> str:
    """Strip the process wrappers at the start of a command to expose the command that
    will really execute.

    Recognises ``timeout`` / ``nice`` / ``nohup`` / ``stdbuf`` (along with their short
    flags and numeric arguments) and a **flagless** ``xargs``; a flagged ``xargs -n1 …``
    is not stripped (it is handled as the xargs command itself, since otherwise the inner
    command would be mistaken for the wrapped target and xargs' own semantics would be
    lost).
    """
    tokens = (command or "").split()
    i = 0
    while i < len(tokens) and tokens[i] in _WRAPPERS:
        if tokens[i] == "xargs":
            # Only a flagless xargs is stripped; xargs -flag … is kept.
            if i + 1 < len(tokens) and tokens[i + 1].startswith("-"):
                break
            i += 1
            continue
        # timeout/nice/nohup/stdbuf: skip the wrapper itself, then skip its short flags / numeric
        # arguments.
        i += 1
        while i < len(tokens) and (tokens[i].startswith("-") or _is_number(tokens[i])):
            i += 1
    return " ".join(tokens[i:])


def strip_delete_wrappers(command: str) -> str:
    """The unwrapping used only for delete-target extraction: beyond the process wrappers
    it **additionally strips ``sudo`` / ``env`` / ``command``**.

    ``VAR=val`` assignments following ``env`` are skipped too (``env FOO=1 rm -rf /`` →
    ``rm -rf /``). Structurally identical to :func:`strip_process_wrappers`, only with a
    wider wrapper set — used solely to expose the inner delete command for
    :func:`~_classify._deletion_targets`, never for capability classification.
    """
    tokens = (command or "").split()
    i = 0
    while i < len(tokens) and tokens[i] in _DELETE_WRAPPERS:
        if tokens[i] == "xargs":
            if i + 1 < len(tokens) and tokens[i + 1].startswith("-"):
                break
            i += 1
            continue
        # Skip the wrapper itself, then its short flags / numeric arguments / ``VAR=val``
        # assignments (env).
        i += 1
        while i < len(tokens) and (
            tokens[i].startswith("-")
            or _is_number(tokens[i])
            or ("=" in tokens[i] and not tokens[i].startswith("/"))
        ):
            i += 1
    return " ".join(tokens[i:])


def _has_dynamic(token: str) -> bool:
    """Whether a token contains runtime expansion (a variable / command substitution /
    backticks) — something static analysis cannot see through."""
    return "$" in token or "`" in token


def running_cwds(subs: List[str], initial_cwd: "str | None") -> List["str | None"]:
    """Track the ``cd``s through a compound command in order and return a list of "the
    runtime cwd of each segment", the same length as ``subs``.

    The initial cwd comes from Bash's explicit absolute ``cwd``; each segment first records
    the cwd it runs in, then updates it if the segment is a ``cd``:

    * ``cd <definite path>`` (absolute / relative / ``~``) → the resolved real path;
    * ``cd -`` / ``cd <containing $ or backticks>`` / ``pushd`` / ``popd`` → **None
      (unknown)** — it cannot be tracked precisely from static text, so the rules mark it
      uncertain;
    * a non-cd segment → the cwd is unchanged.

    Once the cwd is None a relative cd stays None, but an absolute cd recovers it (an
    absolute path does not depend on the previous value).
    """
    cwd = resolve_real_path(initial_cwd, initial_cwd) if initial_cwd else None
    out: List["str | None"] = []
    for sub in subs:
        out.append(cwd)
        cwd = _apply_cd(sub, cwd)
    return out


def _apply_cd(sub: str, cwd: "str | None") -> "str | None":
    tokens = (sub or "").split()
    if not tokens:
        return cwd
    head = tokens[0]
    if head in ("pushd", "popd"):
        return None  # a directory stack cannot be tracked precisely from static text → unknown
    if head != "cd":
        return cwd
    if len(tokens) < 2 or tokens[1] == "-":
        return None  # a bare cd (to anywhere other than home) / cd - → conservatively unknown
    arg = tokens[1]
    if _has_dynamic(arg):
        return None
    if arg == "~" or arg.startswith("~/"):
        return os.path.realpath(os.path.expanduser(arg))
    if os.path.isabs(arg):
        return os.path.realpath(arg)
    if cwd is None:
        return None  # unknown cwd + a relative path → still unknown
    return resolve_real_path(arg, cwd)


def resolve_real_path(path: str, cwd: str) -> str:
    """Resolve ``path`` into an absolute real path with symlinks followed.

    Relative paths are based on ``cwd``; symlinks are resolved to their real target by
    ``os.path.realpath``, preventing a link inside the workspace from pointing outside it
    to escape the boundary. If the path does not exist or resolution fails, it falls back
    to the lexical normalisation of ``os.path.abspath`` (fail-closed). An empty path
    returns an empty string.
    """
    raw = (path or "").strip().strip("\"'")
    if not raw:
        return ""
    # The rules must see the same path the executor does: the POSIX branch runs through an
    # explicit ``/bin/bash -c`` and expands ``~`` and ``$HOME``. Without expanding, ``cp x ~/leak``
    # parses as ``<cwd>/~/leak`` and is misjudged as inside the workspace while the executor really
    # writes into the home directory. This stays consistent with
    # :func:`~_classify._resolve_target` / :func:`_apply_cd`.
    for prefix in ("$HOME", "${HOME}"):
        if raw.startswith(prefix):
            raw = os.path.expanduser("~") + raw[len(prefix):]
            break
    if raw.startswith("~"):
        raw = os.path.expanduser(raw)  # handles the ``~user/`` form
    if "$" in raw or "`" in raw:
        return ""  # other variables / command substitution are not statically resolvable — return empty rather than inventing an "inside the workspace" answer
    candidate = raw if os.path.isabs(raw) else os.path.join(cwd, raw)
    try:
        return os.path.realpath(candidate)
    except OSError:
        return os.path.abspath(candidate)
