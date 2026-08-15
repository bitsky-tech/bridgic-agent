"""判据矩阵端到端测试:``classify`` → ``decide`` 的最终裁决。

只走公开入口(不断言中间枚举),覆盖本轮新增的放行格与收紧格:

* 受信目录(挂载 / 应用目录 ``~/.bridgic``):写入放行、可再生删除放行、其它删除仍过审批;
* 临时目录(``tempfile.gettempdir()`` / ``/tmp``):读写删全放;
* 可再生产物(缓存 / 依赖)删除:任意边界放行;
* 敏感路径删除:三模式一律 ASK(收紧,``full`` 也不豁免)。

工作区 = ``/workspace``,挂载 = ``/data``,越界 = ``/elsewhere``(刻意不用 ``/tmp``,
因为它现在是临时目录边界)。
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from bridgic.amphibious import StepToolCall, ToolArgument

from src.amphi_agent.security._classify import classify
from src.amphi_agent.security._mode_policy import decide
from src.amphi_agent.security._types import Action, ExecutionMode

WS = "/workspace"
MOUNT = "/data"
OOB = "/elsewhere"
TEMP = os.path.realpath(tempfile.gettempdir())
APP_HOME = str(Path.home() / ".bridgic" / "AmphiAgent")


def _call(tool: str, **args: str) -> StepToolCall:
    return StepToolCall(
        tool=tool,
        tool_arguments=[ToolArgument(name=name, value=value) for name, value in args.items()],
    )


def _decide(tool: str, mode: ExecutionMode, **args: str) -> Action:
    if tool == "bash":
        args.setdefault("cwd", WS)
    return decide(classify(_call(tool, **args), WS, [MOUNT]), mode)


REQUEST, AUTO, FULL = ExecutionMode.REQUEST, ExecutionMode.AUTO, ExecutionMode.FULL

# (label, tool, kwargs, (request, auto, full))
_MATRIX = [
    # ── Python 共享 base:依赖准备直通 ──
    ("app-level Python base 安装依赖 → 放行", "bash",
     {"command": "uv pip install httpx"},
     (Action.ASK, Action.ALLOW, Action.ALLOW)),
    ("显式 app-level Python base 安装依赖 → 放行", "bash",
     {"command": "uv pip install --python ~/.bridgic/AmphiAgent/python/base/bin/python httpx"},
     (Action.ASK, Action.ALLOW, Action.ALLOW)),
    ("显式外部 Python 环境安装依赖 → 仍过审批", "bash",
     {"command": "uv pip install --python /opt/external/bin/python httpx"},
     (Action.ASK, Action.CLASSIFY, Action.ALLOW)),

    # ── 受信目录:挂载 ──
    ("挂载内写入 → 放行", "write_file", {"file_path": f"{MOUNT}/proj/a.py", "content": "x"},
     (Action.ALLOW, Action.ALLOW, Action.ALLOW)),
    ("挂载内删可再生(依赖) → 放行", "bash", {"command": f"rm -rf {MOUNT}/proj/node_modules"},
     (Action.ALLOW, Action.ALLOW, Action.ALLOW)),
    ("挂载内删可再生(缓存) → 放行", "bash", {"command": f"rm -rf {MOUNT}/proj/__pycache__"},
     (Action.ALLOW, Action.ALLOW, Action.ALLOW)),
    ("挂载内删真实源码 → 仍过审批", "bash", {"command": f"rm -rf {MOUNT}/proj/src"},
     (Action.ASK, Action.CLASSIFY, Action.ALLOW)),

    # ── 受信目录:应用目录 ~/.bridgic ──
    ("应用目录内写入 → 放行", "write_file", {"file_path": f"{APP_HOME}/skills/local/x.md", "content": "x"},
     (Action.ALLOW, Action.ALLOW, Action.ALLOW)),
    ("应用目录内删真实数据 → 仍过审批", "bash", {"command": f"rm -rf {APP_HOME}/sessions"},
     (Action.ASK, Action.CLASSIFY, Action.ALLOW)),
    ("删除 Workflow 内部资源 → request 确认", "remove_workflow", {"workflow_id": "wf_report"},
     (Action.ASK, Action.ALLOW, Action.ALLOW)),

    # ── 临时目录:全放 ──
    ("临时目录写入 → 放行", "write_file", {"file_path": f"{TEMP}/scratch/a.txt", "content": "x"},
     (Action.ALLOW, Action.ALLOW, Action.ALLOW)),
    ("临时目录删任意 → 放行", "bash", {"command": f"rm -rf {TEMP}/scratch"},
     (Action.ALLOW, Action.ALLOW, Action.ALLOW)),

    # ── 可再生产物:越界也放行 ──
    ("越界删可再生 → 放行", "bash", {"command": f"rm -rf {OOB}/proj/node_modules"},
     (Action.ALLOW, Action.ALLOW, Action.ALLOW)),
    ("越界删真实文件 → 仍过审批", "bash", {"command": f"rm -rf {OOB}/proj/src"},
     (Action.ASK, Action.CLASSIFY, Action.ALLOW)),
    ("越界写入 → 仍过审批", "write_file", {"file_path": f"{OOB}/a.py", "content": "x"},
     (Action.ASK, Action.CLASSIFY, Action.ALLOW)),

    # ── 构建产物:仅末段命中(护栏)──
    ("删 dist 目录本身 → 放行", "bash", {"command": f"rm -rf {MOUNT}/proj/dist"},
     (Action.ALLOW, Action.ALLOW, Action.ALLOW)),
    ("删 build 内的源码文件 → 不算可再生,仍过审批", "bash", {"command": f"rm -rf {MOUNT}/proj/build/src/main.c"},
     (Action.ASK, Action.CLASSIFY, Action.ALLOW)),

    # ── 收紧:敏感删除三模式一律确认(full 也不豁免)──
    ("删 ~/.ssh → 三模式全 ASK", "bash", {"command": "rm -rf ~/.ssh"},
     (Action.ASK, Action.ASK, Action.ASK)),

    # ── 自我修改防线:policy.json 仍受敏感保护(即使在应用目录内)──
    ("写 policy.json → 不被应用目录放行", "write_file",
     {"file_path": f"{APP_HOME}/policy.json", "content": "{}"},
     (Action.ASK, Action.CLASSIFY, Action.ALLOW)),

    # ── 既有防线不被放宽误伤 ──
    ("复合命令含不可再生删除 → 整条仍过审批", "bash",
     {"command": f"rm -rf {MOUNT}/p/__pycache__ && rm -rf {MOUNT}/p/src/x.py"},
     (Action.ASK, Action.CLASSIFY, Action.ALLOW)),
    ("目标含变量的删除 → 仍不确定", "bash", {"command": "rm -rf $BUILD_DIR"},
     (Action.ASK, Action.CLASSIFY, Action.CLASSIFY)),
]


@pytest.mark.parametrize("label, tool, kwargs, expected", _MATRIX, ids=[r[0] for r in _MATRIX])
def test_permission_matrix(label: str, tool: str, kwargs: dict, expected) -> None:
    req, auto, full = expected
    assert _decide(tool, REQUEST, **kwargs) is req, f"{label} @request"
    assert _decide(tool, AUTO, **kwargs) is auto, f"{label} @auto"
    assert _decide(tool, FULL, **kwargs) is full, f"{label} @full"


def test_deleting_app_home_root_is_hard_denied() -> None:
    """精确删整个应用目录 = 抹掉全部 skill / 会话 / 定时任务 → 任何模式恒拒。"""
    for mode in (REQUEST, AUTO, FULL):
        assert _decide("bash", mode, command="rm -rf ~/.bridgic") is Action.DENY
