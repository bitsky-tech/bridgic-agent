"""True Windows PowerShell execution smoke for the platform shell tool."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from bridgic.amphibious.builtin_tools import current_agent

from src.amphi_agent._workspace import Workspace
from src.amphi_agent.tools._bash import bash


pytestmark = pytest.mark.skipif(
    sys.platform != "win32",
    reason="requires native Windows PowerShell and taskkill",
)


async def test_windows_shell_output_cwd_env_failure_and_timeout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AMPHI_WINDOWS_DAEMON_ONLY", "must-not-leak")
    workspace = Workspace(
        "session-windows-smoke",
        session_root=tmp_path / "含 空格的会话",
    )
    # Workspace 构造只绑定路径,落盘归 prepare_workspace 管(见其类文档)。本用例
    # 只烟测 shell,不需要整套 Session 初始化 —— 建出 .work 并绑定运行时环境即可
    # (bash 经 environment.bash_env() 刷新并合成环境,未 prepare 会直接抛)。
    # 与 test_tools_bash.py::test_bash_windows_timeout_terminates_process_tree 同形。
    workspace.work_dir.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(workspace.environment.prepare)
    token = current_agent.set(SimpleNamespace(
        ctx=SimpleNamespace(
            workspace=workspace,
            session=SimpleNamespace(id="session-windows-smoke"),
        )
    ))
    cwd = str(workspace.work_dir)
    try:
        utf8_file = workspace.work_dir / "无 BOM 中文.txt"
        utf8_contents = "UTF-8 文件内容：你好 🙂"
        utf8_file.write_text(utf8_contents, encoding="utf-8")
        escaped_utf8_file = str(utf8_file).replace("'", "''")
        assert await bash(
            "[Console]::Out.Write((Get-Content "
            f"-LiteralPath '{escaped_utf8_file}' -Raw))",
            cwd,
        ) == utf8_contents

        output = await bash(
            '[Console]::Out.Write("中文输出|" + (Get-Location).Path + "|" '
            '+ [string]$env:AMPHI_WINDOWS_DAEMON_ONLY + "|" '
            '+ $env:USERPROFILE + "|" + $env:SystemRoot + "|" + $env:Path)',
            cwd,
        )
        (
            label,
            observed_cwd,
            daemon_only,
            user_profile,
            system_root,
            user_path,
        ) = output.split("|", 5)
        assert label == "中文输出"
        assert Path(observed_cwd).resolve() == workspace.work_dir.resolve()
        assert daemon_only == ""
        assert user_profile
        assert system_root
        assert user_path

        with pytest.raises(RuntimeError, match="exit code 7.*boom"):
            await bash("[Console]::Error.Write('boom'); exit 7", cwd)

        marker = workspace.work_dir / "timeout-marker.txt"
        escaped_marker = str(marker).replace("'", "''")
        with pytest.raises(TimeoutError, match="timed out"):
            await bash(
                "Start-Sleep -Milliseconds 800; "
                f"Set-Content -LiteralPath '{escaped_marker}' -Value born",
                cwd,
                timeout=100,
            )
        await asyncio.sleep(1)
        assert not marker.exists()
    finally:
        current_agent.reset(token)
