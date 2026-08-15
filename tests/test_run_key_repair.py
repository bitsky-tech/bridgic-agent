"""``RunKeySupervisor.repair`` —— Windows 登录自启项的「单一 writer」语义。

背景（这是本文件真正要钉住的东西）：HKCU Run 值一度有**两个** writer。

* NSIS 的 ``customInstall`` 写死 ``"…\\amphi-autostart.exe" server start``；
* ``RunKeySupervisor.enable`` 写完整 argv，含 ``--host/--port/--log-level``。

而 electron-builder 的覆盖安装会先静默跑**旧版卸载器**（删掉该值），再跑新版
``customInstall``（重新写）。于是每次更新都会：

1. 把用户用 ``server autostart enable --port 9000`` 配的端口悄悄重置成默认；
2. 把用户在 GUI 里**关掉**的自启悄悄重新打开。

两者都不报错、不留痕，只有下次开机才体现出来。``repair`` 让 NSIS 退出写注册表的
角色，只负责"指到新目录"，参数与 opt-out 都由 CLI 这一个 writer 说了算。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from src.amphi_service.server.supervisor._base import ServerLaunchSpec
from src.amphi_service.server.supervisor._run_key import (
    RunKeySupervisor,
    SupervisorError,
)


@pytest.fixture()
def launcher(tmp_path: Path) -> Path:
    """A real file —— repair 要求 launcher 存在，否则会写出一条开机必失败的命令。"""
    path = tmp_path / "new" / "amphi-autostart.exe"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"")
    return path


def _spec(executable: Path) -> ServerLaunchSpec:
    return ServerLaunchSpec(
        executable=executable,
        arguments=(
            "server",
            "start",
            "--host",
            "127.0.0.1",
            "--port",
            "7421",
            "--log-level",
            "info",
        ),
        working_directory=executable.parent,
        environment={},
    )


def _supervisor(
    current: str | None,
    written: list[str],
    deleted: list[bool],
) -> RunKeySupervisor:
    return RunKeySupervisor(
        platform="win32",
        read_value=lambda: current,
        write_value=written.append,
        delete_value=lambda: deleted.append(True),
        read_approval=lambda: None,
        enable_approval=lambda: (_ for _ in ()).throw(
            AssertionError("installer repair must not change StartupApproved")
        ),
    )


def test_writes_the_canonical_command_when_absent(launcher: Path) -> None:
    """全新安装：没有旧值 → 写 CLI 的规范 argv（而不是 NSIS 的简化版）。"""
    written: list[str] = []
    spec = _spec(launcher)
    _supervisor(None, written, []).repair(spec)
    assert written == [subprocess.list2cmdline(spec.argv)]


def test_absent_value_gets_the_canonical_command(launcher: Path) -> None:
    """值不存在就写规范命令。

    「用户是否想要自启」不是 repair 的判断范围 —— 那由安装器根据 customInit 里的
    快照决定。曾经有过一个 `--only-if-present` 模式想在这里判断，但它恰好在它要
    服务的那条升级路径上是错的：等 customInstall 跑到时，旧版卸载器已经把值删了。
    """
    written: list[str] = []
    spec = _spec(launcher)
    _supervisor(None, written, []).repair(spec)
    assert written == [subprocess.list2cmdline(spec.argv)]


def test_preserves_user_arguments_and_repoints_the_executable(launcher: Path) -> None:
    """核心防回归：只换可执行文件路径，用户配的 --port 9000 必须原样保留。"""
    old = (
        r'"C:\Users\me\AppData\Local\Programs\Amphi\resources\bin\amphi-autostart.exe"'
        " server start --host 0.0.0.0 --port 9000 --log-level debug"
    )
    written: list[str] = []
    _supervisor(old, written, []).repair(_spec(launcher))

    assert len(written) == 1
    assert written[0].startswith(subprocess.list2cmdline([str(launcher)]))
    assert written[0].endswith(
        " server start --host 0.0.0.0 --port 9000 --log-level debug"
    )


def test_is_a_no_op_when_the_path_already_matches(launcher: Path) -> None:
    """修复安装（目录没变）不该产生一次多余的注册表写入。"""
    spec = _spec(launcher)
    current = subprocess.list2cmdline(spec.argv)
    written: list[str] = []
    _supervisor(current, written, []).repair(spec)
    assert written == []


def test_handles_an_unquoted_legacy_value(launcher: Path) -> None:
    """历史上手工写入的无引号值也要能重指，且不吞掉参数。"""
    old = r"C:\Amphi\amphi-autostart.exe server start --port 9000"
    written: list[str] = []
    _supervisor(old, written, []).repair(_spec(launcher))
    assert written[0].endswith(" server start --port 9000")


def test_unquoted_path_with_a_space_falls_back_to_canonical(launcher: Path) -> None:
    """用户名带空格 + 无引号 = 无法区分路径与参数，必须退回规范命令。

    这是最容易写错也最容易漏测的一条：按第一个空格切分看起来"能跑"，实际会把
    路径后半段顶成 argv[1]。下次开机 argparse 拒绝该参数、
    自启静默失效，而 ``status()`` 仍然报 ``enabled=True`` —— 界面上永远看不出来。
    """
    old = (
        r"C:\Users\John Smith\AppData\Local\Programs\Amphi"
        r"\resources\bin\amphi-autostart.exe server start --port 9000"
    )
    written: list[str] = []
    spec = _spec(launcher)
    _supervisor(old, written, []).repair(spec)
    assert written == [subprocess.list2cmdline(spec.argv)]
    assert "Smith" not in written[0]


@pytest.mark.parametrize(
    "old",
    [
        pytest.param("", id="empty"),
        pytest.param(r'"C:\Amphi\amphi-autostart.exe server start', id="unterminated-quote"),
        pytest.param(r"C:\Amphi\launcher server start", id="no-exe-suffix"),
    ],
)
def test_unparseable_values_are_replaced_with_the_canonical_command(
    launcher: Path, old: str
) -> None:
    """解析不了的旧值退回规范命令，而不是写出一条没有参数的命令。

    早期实现在这几种输入下会写出 ``"<exe>"`` —— 一条不带 ``server start`` 的命令，
    开机拉起 shim 后什么都不做，但 ``enabled`` 依然为真。
    """
    written: list[str] = []
    spec = _spec(launcher)
    _supervisor(old, written, []).repair(spec)
    assert written == [subprocess.list2cmdline(spec.argv)]


def test_existing_value_arguments_are_always_preserved(launcher: Path) -> None:
    """有旧值就保留其参数，与调用来源无关。

    卸载不干净留下的旧值也照此处理：保留参数比重置成默认更接近用户的最后一次意图。
    """
    old = r'"C:\old\amphi-autostart.exe" server start --port 9000'
    written: list[str] = []
    _supervisor(old, written, []).repair(_spec(launcher))
    assert written[0].endswith(" server start --port 9000")


def test_never_deletes(launcher: Path) -> None:
    """repair 只写不删 —— 删除是真卸载的语义，属于 disable / customUnInstall。"""
    deleted: list[bool] = []
    _supervisor(None, [], deleted).repair(_spec(launcher))
    assert deleted == []


def test_repair_preserves_a_windows_startup_apps_opt_out(launcher: Path) -> None:
    """Installer repair may repoint the Run value but must not approve it."""
    old = r'"C:\old\amphi-autostart.exe" server start --port 9000'
    written: list[str] = []
    approval_resets: list[bool] = []
    supervisor = RunKeySupervisor(
        platform="win32",
        read_value=lambda: old,
        write_value=written.append,
        delete_value=lambda: None,
        read_approval=lambda: bytes((3, 0, 0, 0)),
        enable_approval=lambda: approval_resets.append(True),
    )

    status = supervisor.repair(_spec(launcher))

    assert len(written) == 1
    assert status.enabled is False
    assert "disabled in Windows Startup Apps" in (status.detail or "")
    assert approval_resets == []


def test_rejects_a_missing_launcher(tmp_path: Path) -> None:
    """launcher 不存在时必须报错，而不是写出一条开机静默失败的命令。"""
    missing = tmp_path / "nope" / "amphi-autostart.exe"
    with pytest.raises(SupervisorError, match="launcher is missing"):
        _supervisor(None, [], []).repair(_spec(missing))


def test_unsupported_platform_raises(launcher: Path) -> None:
    """非 Windows 上直接调用是编程错误。

    CLI 不会走到这里：`repair_autostart` 在 manager 层就用 `getattr(supervisor,
    "repair", None)` 判掉了非 Windows 的 supervisor（launchd 没有这个方法），
    直接返回 status。
    """
    supervisor = RunKeySupervisor(platform="darwin", read_value=lambda: None)
    with pytest.raises(SupervisorError):
        supervisor.repair(_spec(launcher))
