"""Capture a fresh Windows system-and-user environment block."""

from __future__ import annotations

import ctypes
import os
from collections.abc import Callable, Iterable
from functools import lru_cache
from typing import Any, Optional


class WindowsUserEnvironmentError(RuntimeError):
    """The current Windows user's environment block could not be captured."""


class _WindowsEnvironmentBlockReader:
    """Read one native Unicode environment block for the current user."""

    TOKEN_DUPLICATE = 0x0002
    TOKEN_QUERY = 0x0008
    MAX_BLOCK_CODE_UNITS = 16_777_216

    @classmethod
    def read(cls) -> list[str]:
        """Create, copy, and release the current user's native environment block."""
        advapi32, kernel32, userenv, wintypes = cls._libraries()
        token = wintypes.HANDLE()
        opened = advapi32.OpenProcessToken(
            kernel32.GetCurrentProcess(),
            cls.TOKEN_QUERY | cls.TOKEN_DUPLICATE,
            ctypes.byref(token),
        )
        if not opened:
            raise cls._native_error("OpenProcessToken")

        block = ctypes.c_void_p()
        try:
            created = userenv.CreateEnvironmentBlock(
                ctypes.byref(block), token, False,
            )
            if not created:
                raise cls._native_error("CreateEnvironmentBlock")
            try:
                return cls._copy_entries(block)
            finally:
                userenv.DestroyEnvironmentBlock(block)
        finally:
            kernel32.CloseHandle(token)

    @classmethod
    def _copy_entries(cls, block: ctypes.c_void_p) -> list[str]:
        if not block.value:
            raise WindowsUserEnvironmentError(
                "CreateEnvironmentBlock returned an empty pointer"
            )

        pointer = ctypes.cast(block, ctypes.POINTER(ctypes.c_uint16))
        entries: list[str] = []
        encoded = bytearray()
        for index in range(cls.MAX_BLOCK_CODE_UNITS):
            code_unit = pointer[index]
            if code_unit:
                encoded.extend(int(code_unit).to_bytes(2, "little"))
                continue
            if not encoded:
                return entries
            try:
                entries.append(encoded.decode("utf-16-le", errors="strict"))
            except UnicodeDecodeError as exc:
                raise WindowsUserEnvironmentError(
                    "The Windows user environment block contains invalid UTF-16"
                ) from exc
            encoded.clear()
        raise WindowsUserEnvironmentError(
            "The Windows user environment block exceeded the safety limit"
        )

    @staticmethod
    def _native_error(operation: str) -> WindowsUserEnvironmentError:
        error = ctypes.get_last_error()
        return WindowsUserEnvironmentError(
            f"{operation} failed with Windows error {error}"
        )

    @staticmethod
    @lru_cache(maxsize=1)
    def _libraries() -> tuple[Any, Any, Any, Any]:
        if os.name != "nt":
            raise WindowsUserEnvironmentError(
                "Windows user environment capture is available only on Windows"
            )
        from ctypes import wintypes

        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        userenv = ctypes.WinDLL("userenv", use_last_error=True)

        kernel32.GetCurrentProcess.argtypes = ()
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        advapi32.OpenProcessToken.argtypes = (
            wintypes.HANDLE,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.HANDLE),
        )
        advapi32.OpenProcessToken.restype = wintypes.BOOL
        userenv.CreateEnvironmentBlock.argtypes = (
            ctypes.POINTER(ctypes.c_void_p),
            wintypes.HANDLE,
            wintypes.BOOL,
        )
        userenv.CreateEnvironmentBlock.restype = wintypes.BOOL
        userenv.DestroyEnvironmentBlock.argtypes = (ctypes.c_void_p,)
        userenv.DestroyEnvironmentBlock.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel32.CloseHandle.restype = wintypes.BOOL
        return advapi32, kernel32, userenv, wintypes


class WindowsUserEnvironment:
    """Capture the current Windows user's fresh system-and-user environment.

    Windows constructs this block from the loaded user profile and machine
    environment. It deliberately does not inherit the gateway process, so
    terminal-local variables and stale gateway values cannot leak into a new
    Agent command.

    Parameters
    ----------
    block_reader : Callable[[], Iterable[str]], optional
        Raw ``NAME=value`` entry provider used by isolated tests. Production
        calls the native Windows environment-block API.
    """

    def __init__(
        self, *, block_reader: Optional[Callable[[], Iterable[str]]] = None,
    ) -> None:
        self._block_reader = block_reader

    def capture(self) -> dict[str, str]:
        """Return one newly constructed Windows user environment."""
        try:
            entries = (
                self._block_reader()
                if self._block_reader is not None
                else _WindowsEnvironmentBlockReader.read()
            )
            return self._parse_entries(entries)
        except WindowsUserEnvironmentError:
            raise
        except Exception as exc:
            raise WindowsUserEnvironmentError(
                "Could not read the Windows user environment block"
            ) from exc

    @staticmethod
    def _parse_entries(entries: Iterable[str]) -> dict[str, str]:
        result: dict[str, str] = {}
        for entry in entries:
            if not isinstance(entry, str) or "\0" in entry:
                raise WindowsUserEnvironmentError(
                    "The Windows user environment contains an invalid record"
                )
            if entry.startswith("="):
                continue
            name, separator, value = entry.partition("=")
            if not separator or not name:
                raise WindowsUserEnvironmentError(
                    "The Windows user environment contains a malformed record"
                )
            result[name.upper()] = value
        if not result:
            raise WindowsUserEnvironmentError(
                "The Windows user environment block contained no variables"
            )
        return result


__all__ = [
    "WindowsUserEnvironment",
    "WindowsUserEnvironmentError",
]
