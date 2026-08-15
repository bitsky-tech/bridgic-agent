"""Isolated coverage for the Windows user environment adapter."""

from __future__ import annotations

import ctypes
import sys
import uuid
from collections.abc import Iterable, Iterator
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from src.amphi_agent.runtime._windows_env import (
    WindowsUserEnvironment,
    WindowsUserEnvironmentError,
    _WindowsEnvironmentBlockReader,
)


def test_capture_parses_normalizes_and_filters_environment_records() -> None:
    """Names are case-insensitive, values may contain equals, and drive cwd is private."""
    records = [
        r"Path=C:\Windows\System32;C:\Users\测试\bin",
        "AMPHI_COMPLEX=first=second=third",
        "MiXeD=old",
        "MIXED=updated",
        "UNICODE=环境正常🙂",
        "EMPTY=",
        r"=C:=C:\workspace",
    ]

    result = WindowsUserEnvironment(block_reader=lambda: records).capture()

    assert result == {
        "PATH": r"C:\Windows\System32;C:\Users\测试\bin",
        "AMPHI_COMPLEX": "first=second=third",
        "MIXED": "updated",
        "UNICODE": "环境正常🙂",
        "EMPTY": "",
    }


def test_native_reader_copies_a_unicode_double_nul_environment_block() -> None:
    """The Win32 block parser preserves UTF-16, emoji, and equals in values."""
    payload = (
        "Path=C:\\Windows\\System32\0"
        "UNICODE=环境正常🙂\0"
        "AMPHI_COMPLEX=first=second=third\0"
        "\0"
    ).encode("utf-16-le")
    buffer = ctypes.create_string_buffer(payload)
    block = ctypes.cast(buffer, ctypes.c_void_p)

    entries = _WindowsEnvironmentBlockReader._copy_entries(block)

    assert entries == [
        r"Path=C:\Windows\System32",
        "UNICODE=环境正常🙂",
        "AMPHI_COMPLEX=first=second=third",
    ]


def test_native_reader_uses_current_token_and_releases_native_resources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The FFI path requests a clean block and closes both native resources."""
    payload = "Path=C:\\Windows\0USERPROFILE=C:\\Users\\测试\0\0".encode(
        "utf-16-le"
    )
    buffer = ctypes.create_string_buffer(payload)
    access_masks: list[int] = []
    inheritance: list[bool] = []

    def open_process_token(_process, access, token_pointer) -> bool:
        access_masks.append(access)
        token_pointer._obj.value = 73
        return True

    def create_environment_block(block_pointer, token, inherit) -> bool:
        assert token.value == 73
        inheritance.append(bool(inherit))
        block_pointer._obj.value = ctypes.addressof(buffer)
        return True

    advapi32 = SimpleNamespace(OpenProcessToken=Mock(side_effect=open_process_token))
    kernel32 = SimpleNamespace(
        GetCurrentProcess=Mock(return_value=101),
        CloseHandle=Mock(return_value=True),
    )
    userenv = SimpleNamespace(
        CreateEnvironmentBlock=Mock(side_effect=create_environment_block),
        DestroyEnvironmentBlock=Mock(return_value=True),
    )
    wintypes = SimpleNamespace(HANDLE=ctypes.c_void_p)
    monkeypatch.setattr(
        _WindowsEnvironmentBlockReader,
        "_libraries",
        classmethod(lambda _cls: (advapi32, kernel32, userenv, wintypes)),
    )

    entries = _WindowsEnvironmentBlockReader.read()

    assert entries == [r"Path=C:\Windows", r"USERPROFILE=C:\Users\测试"]
    assert access_masks == [
        _WindowsEnvironmentBlockReader.TOKEN_QUERY
        | _WindowsEnvironmentBlockReader.TOKEN_DUPLICATE
    ]
    assert inheritance == [False]
    userenv.DestroyEnvironmentBlock.assert_called_once()
    assert userenv.DestroyEnvironmentBlock.call_args.args[0].value == ctypes.addressof(
        buffer
    )
    kernel32.CloseHandle.assert_called_once()
    assert kernel32.CloseHandle.call_args.args[0].value == 73


def test_native_reader_releases_token_when_block_creation_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CreateEnvironmentBlock failure closes the token without destroying NULL."""
    def open_process_token(_process, _access, token_pointer) -> bool:
        token_pointer._obj.value = 91
        return True

    advapi32 = SimpleNamespace(OpenProcessToken=Mock(side_effect=open_process_token))
    kernel32 = SimpleNamespace(
        GetCurrentProcess=Mock(return_value=101),
        CloseHandle=Mock(return_value=True),
    )
    userenv = SimpleNamespace(
        CreateEnvironmentBlock=Mock(return_value=False),
        DestroyEnvironmentBlock=Mock(return_value=True),
    )
    wintypes = SimpleNamespace(HANDLE=ctypes.c_void_p)
    monkeypatch.setattr(
        _WindowsEnvironmentBlockReader,
        "_libraries",
        classmethod(lambda _cls: (advapi32, kernel32, userenv, wintypes)),
    )
    monkeypatch.setattr(
        _WindowsEnvironmentBlockReader,
        "_native_error",
        staticmethod(lambda operation: WindowsUserEnvironmentError(operation)),
    )

    with pytest.raises(WindowsUserEnvironmentError, match="CreateEnvironmentBlock"):
        _WindowsEnvironmentBlockReader.read()

    userenv.DestroyEnvironmentBlock.assert_not_called()
    kernel32.CloseHandle.assert_called_once()
    assert kernel32.CloseHandle.call_args.args[0].value == 91


def test_capture_reads_a_new_environment_block_on_every_call() -> None:
    """A changed or deleted user variable is visible without restarting the App."""
    blocks: Iterator[list[str]] = iter([
        [r"Path=C:\first", "AMPHI_CHANGED=v1", "AMPHI_REMOVED=present"],
        [r"Path=C:\second", "AMPHI_CHANGED=v2", "AMPHI_ADDED=fresh"],
    ])
    calls = 0

    def read_block() -> Iterable[str]:
        nonlocal calls
        calls += 1
        return next(blocks)

    environment = WindowsUserEnvironment(block_reader=read_block)

    first = environment.capture()
    second = environment.capture()

    assert calls == 2
    assert first == {
        "PATH": r"C:\first",
        "AMPHI_CHANGED": "v1",
        "AMPHI_REMOVED": "present",
    }
    assert second == {
        "PATH": r"C:\second",
        "AMPHI_CHANGED": "v2",
        "AMPHI_ADDED": "fresh",
    }


@pytest.mark.parametrize("record", ["BROKEN", "BAD\0NAME=value"])
def test_capture_rejects_malformed_environment_records(record: str) -> None:
    """A corrupt native block is discarded rather than partially imported."""
    with pytest.raises(WindowsUserEnvironmentError):
        WindowsUserEnvironment(block_reader=lambda: [record]).capture()


def test_capture_wraps_native_reader_failures() -> None:
    """Callers receive one controlled adapter error for Win32 API failures."""
    def fail() -> Iterable[str]:
        raise OSError(5, "Access is denied")

    with pytest.raises(WindowsUserEnvironmentError):
        WindowsUserEnvironment(block_reader=fail).capture()


@pytest.mark.skipif(sys.platform != "win32", reason="requires Windows Userenv")
def test_native_capture_excludes_process_only_state_and_has_user_basics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The real API returns a clean user block, not the gateway process block."""
    marker = f"AMPHI_WINDOWS_PROCESS_ONLY_{uuid.uuid4().hex}".upper()
    monkeypatch.setenv(marker, "must-not-leak")

    result = WindowsUserEnvironment().capture()

    assert marker not in result
    assert result["USERPROFILE"]
    assert result["SYSTEMROOT"]
    assert result["PATH"]


@pytest.mark.skipif(sys.platform != "win32", reason="requires Windows Userenv")
def test_native_capture_refreshes_persistent_user_environment() -> None:
    """Registry-backed user edits are rebuilt on each capture without broadcast."""
    import winreg

    name = f"AMPHI_WINDOWS_REFRESH_{uuid.uuid4().hex}".upper()
    environment = WindowsUserEnvironment()
    with winreg.CreateKeyEx(
        winreg.HKEY_CURRENT_USER,
        "Environment",
        0,
        winreg.KEY_QUERY_VALUE | winreg.KEY_SET_VALUE,
    ) as key:
        try:
            previous_value, previous_kind = winreg.QueryValueEx(key, name)
            existed = True
        except FileNotFoundError:
            previous_value = previous_kind = None
            existed = False

        try:
            winreg.SetValueEx(key, name, 0, winreg.REG_SZ, "first")
            winreg.FlushKey(key)
            assert environment.capture()[name] == "first"

            winreg.SetValueEx(key, name, 0, winreg.REG_SZ, "second")
            winreg.FlushKey(key)
            assert environment.capture()[name] == "second"

            winreg.SetValueEx(
                key,
                name,
                0,
                winreg.REG_EXPAND_SZ,
                r"%SystemRoot%\amphi-environment-test",
            )
            winreg.FlushKey(key)
            expanded = environment.capture()
            assert expanded[name] == (
                expanded["SYSTEMROOT"] + r"\amphi-environment-test"
            )

            winreg.DeleteValue(key, name)
            winreg.FlushKey(key)
            assert name not in environment.capture()
        finally:
            if existed:
                winreg.SetValueEx(key, name, 0, previous_kind, previous_value)
            else:
                try:
                    winreg.DeleteValue(key, name)
                except FileNotFoundError:
                    pass
            winreg.FlushKey(key)
