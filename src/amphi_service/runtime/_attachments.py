from __future__ import annotations

import os
import secrets
import shutil
import tempfile
from pathlib import Path
from typing import Iterable, Optional

ATTACHMENTS_ROOT_ENV_VAR = "BRIDGIC_AGENT_ATTACHMENTS_ROOT"


class SessionAttachmentStore:
    """Own uploaded files independently from Agent workspaces.

    Parameters
    ----------
    root : Path, optional
        Application-owned attachment root. Production defaults to
        ``~/.bridgic/AmphiAgent/attachments``.
    """

    def __init__(self, root: Optional[Path] = None) -> None:
        configured = os.getenv(ATTACHMENTS_ROOT_ENV_VAR)
        self.root = (
            Path(root).expanduser().resolve()
            if root is not None
            else (
                Path(configured).expanduser().resolve()
                if configured
                else (Path.home() / ".bridgic" / "AmphiAgent" / "attachments").resolve()
            )
        )

    def write(self, session_id: str, filename: str, data: bytes) -> Path:
        """Atomically write one Session-owned upload and return its path."""
        directory = self._session_dir(session_id, create=True)
        safe_name = self._safe_filename(filename)
        target = directory / f"{secrets.token_hex(8)}-{safe_name[-48:]}"
        descriptor, temporary_name = tempfile.mkstemp(prefix=".upload-", dir=directory)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
            os.replace(temporary, target)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
        return target.resolve()

    def clone(
        self,
        source_session_id: str,
        dest_session_id: str,
        path: Path,
        filename: str,
    ) -> Path:
        """Copy one managed upload into another Session's attachment directory."""
        source = Path(path)
        source_directory = self._session_dir(source_session_id, create=False)
        if (
            source_directory is None
            or source.is_symlink()
            or not source.is_file()
            or source.parent.resolve() != source_directory.resolve()
        ):
            raise ValueError("Attachment path is not owned by the source Session")
        destination = self._session_dir(dest_session_id, create=True)
        assert destination is not None
        safe_name = self._safe_filename(filename)
        target = destination / f"{secrets.token_hex(8)}-{safe_name[-48:]}"
        descriptor, temporary_name = tempfile.mkstemp(prefix=".upload-", dir=destination)
        temporary = Path(temporary_name)
        try:
            with (
                os.fdopen(descriptor, "wb") as output_stream,
                source.open("rb") as input_stream,
            ):
                shutil.copyfileobj(input_stream, output_stream)
            os.replace(temporary, target)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
        return target.resolve()

    def owns(self, session_id: str, path: Path) -> bool:
        """Whether a regular non-symlink file belongs to one Session."""
        directory = self._session_dir(session_id, create=False)
        candidate = Path(path)
        if directory is None or candidate.is_symlink() or not candidate.is_file():
            return False
        try:
            return candidate.parent.resolve() == directory.resolve()
        except OSError:
            return False

    def delete(self, session_id: str, path: Path) -> bool:
        """Delete one managed upload without touching external mount targets."""
        directory = self._session_dir(session_id, create=False)
        if directory is None:
            return False
        candidate = Path(path)
        try:
            if candidate.parent.resolve() != directory.resolve():
                return False
        except OSError:
            return False
        if not candidate.exists() and not candidate.is_symlink():
            return False
        try:
            candidate.unlink()
            return True
        except OSError:
            return False

    def clear(self, session_id: str) -> None:
        """Delete all application-owned uploads for one Session."""
        directory = self._session_dir(session_id, create=False)
        if directory is not None and directory.is_dir():
            shutil.rmtree(directory)

    def clear_many(self, session_ids: Iterable[str]) -> None:
        """Delete application-owned uploads for the supplied Sessions."""
        for session_id in session_ids:
            self.clear(session_id)

    def _session_dir(self, session_id: str, *, create: bool) -> Optional[Path]:
        safe_id = self._safe_session_id(session_id)
        if self.root.is_symlink():
            if create:
                raise RuntimeError("Attachment root cannot be a symlink")
            return None
        if create:
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        elif not self.root.is_dir():
            return None
        directory = self.root / safe_id
        if directory.is_symlink():
            if create:
                raise RuntimeError("Session attachment directory cannot be a symlink")
            return None
        if create:
            directory.mkdir(exist_ok=True, mode=0o700)
        elif not directory.is_dir():
            return None
        try:
            directory.resolve().relative_to(self.root.resolve())
        except (OSError, ValueError) as exc:
            raise RuntimeError("Session attachment directory escaped the application root") from exc
        return directory

    @staticmethod
    def _safe_session_id(session_id: str) -> str:
        value = str(session_id or "")
        if (
            not value
            or value in {".", ".."}
            or Path(value).name != value
            or "/" in value
            or "\\" in value
            or "\x00" in value
        ):
            raise ValueError("session_id must be a safe path component")
        return value

    @staticmethod
    def _safe_filename(filename: str) -> str:
        value = Path(
            (filename or "").replace("\\", "/").replace("\x00", "")
        ).name
        return "attachment.bin" if value in {"", ".", ".."} else value


__all__ = ["ATTACHMENTS_ROOT_ENV_VAR", "SessionAttachmentStore"]
