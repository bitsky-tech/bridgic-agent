"""Locate the read-only runtime resources shipped with or developed beside the app."""

import os
import sys
from functools import cache
from pathlib import Path
from typing import Optional


class BundledRuntimeResources:
    """Resolve the common Resources root for every bundled runtime.

    Resolution is deterministic: an explicit operator override wins, a frozen
    executable resolves its adjacent Resources directory, and an editable
    source checkout resolves the repository's Electron resources. Runtime
    consumers validate their own contents; this class only owns location.
    """

    ENVIRONMENT_VARIABLE = "AMPHI_BUNDLED_RESOURCES_DIR"

    def __init__(self, *, source_root: Optional[Path] = None) -> None:
        self._source_root = (
            Path(source_root).expanduser().resolve()
            if source_root is not None
            else Path(__file__).resolve().parents[3]
        )

    @cache
    def directory(self) -> Optional[Path]:
        override = os.environ.get(self.ENVIRONMENT_VARIABLE)
        if override:
            return Path(override).expanduser().resolve()

        bundled_bin = os.environ.get("AMPHI_BUNDLED_BIN_DIR")
        if bundled_bin:
            return Path(bundled_bin).expanduser().resolve().parent

        if getattr(sys, "frozen", False):
            return Path(sys.executable).expanduser().resolve().parent.parent

        if not (self._source_root / "pyproject.toml").is_file():
            return None
        candidate = self._source_root / "desktop" / "apps" / "electron" / "resources"
        return candidate.resolve() if candidate.is_dir() else None

    def reset_cache(self) -> None:
        """Discard stable discovery, primarily for tests."""
        self.directory.cache_clear()


__all__ = ["BundledRuntimeResources"]
