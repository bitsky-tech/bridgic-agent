"""Typed failures raised while preparing the app-owned runtime bases."""

from pathlib import Path
from typing import Optional


class EnvNotReady(RuntimeError):
    """A base could not be read, so whether it is usable stays unknown.

    Raised instead of reporting the base as broken, because answering "broken"
    is what makes the caller destroy a copy nobody could read well enough to
    judge. Note that an open file does not cause this: what does is a directory
    that denies reads outright, which on Windows means its DACL stopped
    granting the running user.

    Parameters
    ----------
    path : Path
        Base whose probe could not reach a verdict.
    cause : OSError, optional
        Last error the probe raised.
    """

    def __init__(self, path: Path, cause: Optional[OSError] = None) -> None:
        detail = f": {cause}" if cause is not None else ""
        super().__init__(f"Cannot read the runtime environment at {path}{detail}")
        self.path = path
        self.cause = cause


class BundledRuntimeUnavailable(RuntimeError):
    """The packaged runtime resources are missing, incomplete, or unusable.

    Separate from every transient failure on purpose: no amount of retrying
    conjures a binary the installer never wrote, so a caller that retries on
    its own stops here instead of spinning until the daemon exits.
    """
