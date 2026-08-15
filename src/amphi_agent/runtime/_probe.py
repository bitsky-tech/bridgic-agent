"""Tri-state readiness probing for the app-owned runtime bases.

A boolean probe cannot tell "this base is broken" from "this base cannot be
read right now", and collapsing the two destroys healthy environments: a base
whose directory denies reads -- a DACL that no longer grants the running user
is the one seen in the field -- fails every ``stat`` inside it with
``PermissionError``, which reads exactly like a missing environment.

Which reads a held handle does and does not block is worth being exact about,
because this module first claimed it blocked all of them. ``os.lstat`` falls
back to listing the parent directory when ``CreateFileW`` is refused, and no
file handle blocks that, so a path the inspectors only ``lstat`` still probes
as usable while it is held -- measured on the Windows runner by
``test_an_exclusive_handle_does_not_even_make_the_base_unreadable``. A path
they ``open`` is a different matter: the manifest is read, not stat-ed, and a
reader honours the share mode the holder set. So an exclusively held manifest
does read as unreadable, which is exactly why the verdict has to survive
several rounds before anything acts on it.
"""

import logging
import os
import stat
import tempfile
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable, Optional

from ._errors import EnvNotReady

logger = logging.getLogger(__name__)

# A handle held by an installer or a scanner usually clears within a few
# hundred milliseconds, so the whole probe is repeated before the verdict is
# downgraded to "unknown".
PROBE_ATTEMPTS = 3
PROBE_BACKOFF_SEC = 0.1

# Rounds, not seconds. A wall clock cannot tell one unreadable base from two
# unrelated blips an hour apart, and the daemon's retry ladder widens to five
# minutes, so elapsed time stops describing anything real. Counting whole
# preparation rounds does: three consecutive ones spans the 1s/5s/15s head of
# that ladder, so the app heals about twenty seconds in, and no burst of
# unrelated failures reaches it.
QUARANTINE_AFTER_ROUNDS = 3

# Quarantined bases join the backups on purpose. Every recovery path already
# globs this prefix, so the move stays reversible: once whatever denied the
# reads is gone, the next round finds the base readable and puts it back, with
# the packages in it. A private prefix would have made it one-way.
QUARANTINE_PREFIX = ".base.backup."


class ProbeResult(Enum):
    """Verdict of one base-readiness probe."""

    VALID = "valid"
    INVALID = "invalid"
    UNREADABLE = "unreadable"


@dataclass(frozen=True)
class BaseProbe:
    """One immutable readiness verdict for a runtime base."""

    result: ProbeResult
    path: Path
    error: Optional[OSError] = None

    @property
    def usable(self) -> bool:
        """Return whether the base can be used exactly as it is."""
        return self.result is ProbeResult.VALID

    @property
    def unreadable(self) -> bool:
        """Return whether the probe failed to reach a verdict."""
        return self.result is ProbeResult.UNREADABLE


def probe_base(path: Path, inspect: Callable[[], bool]) -> BaseProbe:
    """Classify ``inspect`` into VALID, INVALID, or UNREADABLE.

    Parameters
    ----------
    path : Path
        Base being inspected, carried into the verdict for error reporting.
    inspect : callable
        Returns whether the base is usable. It must let ``OSError`` escape:
        that is the only signal the base could not be read at all. Damaged
        manifest content raises ``ValueError``/``TypeError`` instead and is
        reported as ``INVALID``, because a rebuild does fix that.

    Returns
    -------
    BaseProbe
        Verdict, plus the last error when the base stayed unreadable.
    """
    error: Optional[OSError] = None
    for attempt in range(1, PROBE_ATTEMPTS + 1):
        try:
            usable = inspect()
        except OSError as exc:
            error = exc
            if attempt < PROBE_ATTEMPTS:
                time.sleep(PROBE_BACKOFF_SEC)
            continue
        except (ValueError, TypeError):
            return BaseProbe(ProbeResult.INVALID, path)
        return BaseProbe(ProbeResult.VALID if usable else ProbeResult.INVALID, path)
    return BaseProbe(ProbeResult.UNREADABLE, path, error)


class UnreadableBaseGuard:
    """End the wait on a base that is never going to become readable.

    Callers answer ``INVALID`` with a rebuild, so ``UNREADABLE`` must never
    reach that branch on the strength of one reading -- destroying a base
    nobody could read is destroying one nobody could judge. But answering "not
    yet" forever is worse for the case that does not clear: a base left behind
    by a run under another security context denies every read for good, and the
    daemon retried that verdict on a widening backoff while telling the user
    the environment was still being prepared.

    This keeps both answers, separated by how many consecutive preparation
    rounds the base has read unreadable. One instance tracks one base across
    every probe a round makes of it: a round that reads the manifest fine and
    the support files not at all is an unreadable round, and counting it any
    other way is what let a base go unreadable forever without ever ageing.
    """

    def __init__(self) -> None:
        self._rounds = 0
        self._unreadable_this_round = False

    def settle(self, probe: BaseProbe) -> BaseProbe:
        """Return a verdict a caller can act on.

        Returns
        -------
        BaseProbe
            ``probe`` itself while it is readable, or ``INVALID`` once the base
            has been moved aside and a rebuild is the honest answer.

        Raises
        ------
        EnvNotReady
            While the base has not been unreadable for enough rounds to judge,
            and again when it could not be moved aside -- a refused move is
            itself the signal that something still holds the base open.
        """
        if not probe.unreadable:
            return probe
        self._unreadable_this_round = True
        if self._rounds < QUARANTINE_AFTER_ROUNDS:
            raise EnvNotReady(probe.path, probe.error)
        _quarantine(probe)
        self.forget()
        return BaseProbe(ProbeResult.INVALID, probe.path)

    def close_round(self) -> None:
        """Age the streak by the round that just ended.

        Called from a ``finally``, because the round that matters most is the
        one :meth:`settle` ended by raising. A single readable round resets the
        streak outright: whatever the trouble was, the base came back.
        """
        self._rounds = self._rounds + 1 if self._unreadable_this_round else 0
        self._unreadable_this_round = False

    def forget(self) -> None:
        """Drop the streak, for a caller discarding its own readiness."""
        self._rounds = 0
        self._unreadable_this_round = False


def _quarantine(probe: BaseProbe) -> Path:
    """Move an unreadable base aside so a readable one can take its place.

    Renaming needs delete access on the parent directory rather than on the
    base itself, so this succeeds exactly where it matters: the parent is the
    directory the app just created its lock file in. It is a move, never a
    delete -- nobody could read the base, so nobody knows what it was worth,
    and its ACL travels with it as the only surviving evidence of what went
    wrong. It lands among the backups, so a later round restores it outright if
    whatever denied the reads goes away.

    Raises
    ------
    EnvNotReady
        If the move is refused. Windows denies a rename while any handle inside
        the directory is open, which is the transient case a rebuild must not
        answer, so the caller keeps waiting instead.
    """
    try:
        target = Path(tempfile.mkdtemp(prefix=QUARANTINE_PREFIX, dir=probe.path.parent))
        target.rmdir()
        os.replace(probe.path, target)
    except OSError as exc:
        # Silence here would hide the self-heal failing, which looks from the
        # outside exactly like the hang this whole path exists to end.
        logger.warning(
            "Could not move the unreadable runtime base at %s aside (%s); "
            "still waiting on it.",
            probe.path,
            exc,
        )
        raise EnvNotReady(probe.path, exc) from exc
    logger.warning(
        "The runtime base at %s stayed unreadable (%s); moved it aside to %s "
        "and rebuilding.",
        probe.path,
        probe.error,
        target,
    )
    return target


def is_directory(path: Path) -> bool:
    """Return whether ``path`` is a directory and not a symlink.

    ``Path.is_dir`` swallows every ``OSError`` into ``False``, which is the
    behaviour a probe must not have. ``lstat`` also settles the symlink check
    in the same call: a link reports its own mode, never the target's.
    """
    return stat.S_ISDIR(_mode(path, follow=False))


def is_regular_file(path: Path) -> bool:
    """Return whether ``path`` is a file and not a symlink."""
    return stat.S_ISREG(_mode(path, follow=False))


def resolves_to_file(path: Path) -> bool:
    """Return whether ``path`` reaches a file, following symlinks.

    A relocatable venv points its interpreter at the packaged runtime, so the
    interpreter check has to follow the link the way ``Path.is_file`` does.
    """
    return stat.S_ISREG(_mode(path, follow=True))


def _mode(path: Path, *, follow: bool) -> int:
    """Return ``path``'s st_mode, or 0 when the path simply is not there.

    Only "not there" is absorbed. Every other ``OSError`` escapes to
    :func:`probe_base`, which is what makes an unreadable path distinguishable
    from a missing one.
    """
    try:
        return (path.stat() if follow else path.lstat()).st_mode
    except (FileNotFoundError, NotADirectoryError):
        return 0
