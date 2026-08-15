"""删除安全判据单测。

覆盖:
- 确定删系统盘 → ``hard_deny``(rm -r / find -delete 目标 ∈ 系统关键目录集合、$HOME/~)。
- 不确定删除 → ``uncertain_destruction``(变量 / 命令替换 / cwd 未知)。
- cd 跟踪:单条命令内 ``cd`` 改变后续删除的 cwd。
- 不误伤:工作区内、越界具体路径、非递归、非删除。

工作区 = ``/workspace``,无挂载。只断言判据(是什么),动作由规则层另测。
"""

from __future__ import annotations

import pytest
from bridgic.amphibious import StepToolCall, ToolArgument

from src.amphi_agent.security._classify import classify
from src.amphi_agent.security._types import Boundary, Capability

WS = "/workspace"


def _bash(cmd: str):
    return classify(
        StepToolCall(tool="bash", tool_arguments=[
            ToolArgument(name="command", value=cmd),
            ToolArgument(name="cwd", value=WS),
        ]),
        WS,
        [],
    )


# --- 确定删系统盘 → hard_deny ---
@pytest.mark.parametrize(
    "cmd",
    [
        "rm -rf /",
        "rm -rf /usr",
        "rm -rf /etc",
        "rm -rf /System",
        "rm -rf ~",
        "rm -rf $HOME",
        "sudo rm -rf /",
        "rm -fr /",
        "rm --recursive --force /",
        "find / -delete",
        "rm -rf /usr/*",
        "cd /usr && rm -rf *",  # cd 跟踪:cwd 变 /usr
    ],
)
def test_confirmed_system_wipe_is_hard_deny(cmd):
    assert _bash(cmd).hard_deny is True


# --- 不误伤:不该 hard_deny ---
@pytest.mark.parametrize(
    "cmd",
    [
        "rm -rf ./build",  # 工作区内
        "rm -rf /tmp/x",  # 越界具体路径
        "rm -rf /Users/me/proj",  # 系统目录的子目录,非目录本身
        "rm -rf /usr/local/myapp",
        "rm file.txt",  # 非递归
        "ls /",  # 非删除
        "cat /etc/hosts",  # 只读
        "rm -rf *",  # cwd=工作区,裸通配
    ],
)
def test_not_system_wipe(cmd):
    assert _bash(cmd).hard_deny is False


# --- 不确定删除 → uncertain_destruction ---
@pytest.mark.parametrize(
    "cmd",
    [
        "rm -rf $VAR",
        "rm -rf ${DIR}",
        "rm -rf $(cat targets)",
        "rm -rf `echo x`",
        "cd $VAR && rm -rf *",  # cd 到未知 → cwd 未知
    ],
)
def test_uncertain_deletion_is_flagged(cmd):
    assert _bash(cmd).uncertain_destruction is True


# --- 确定的删除不标记 uncertain ---
@pytest.mark.parametrize(
    "cmd",
    [
        "rm -rf ./build",
        "rm -rf /",
        "rm -rf /tmp/x",
        "ls /",
    ],
)
def test_certain_deletion_not_uncertain(cmd):
    assert _bash(cmd).uncertain_destruction is False

# --- cd -/pushd/popd 改变 cwd 但无法精确跟踪 → cwd 未知 → uncertain ---
@pytest.mark.parametrize(
    "cmd",
    [
        "cd - && rm -rf *",
        "pushd /usr && rm -rf *",
        "popd && rm -rf *",
    ],
)
def test_untracked_cwd_change_is_uncertain(cmd):
    assert _bash(cmd).uncertain_destruction is True


# --- 非递归单文件删除:工作区内 → EDIT(→ allow),对齐 rm -rf ./dir ---
@pytest.mark.parametrize(
    "cmd",
    [
        "rm file.txt",
        "rm a.txt b.txt",
        "rm -f note.md",
    ],
)
def test_nonrecursive_delete_in_workspace_is_edit(cmd):
    j = _bash(cmd)
    assert j.capability is Capability.EDIT
    assert j.hard_deny is False


# --- 非递归删系统关键文件:不 deny,落越界(维持粒度,守护) ---
@pytest.mark.parametrize(
    "cmd",
    [
        "rm /etc/passwd",
        "rm /boot/vmlinuz",
    ],
)
def test_nonrecursive_system_file_not_deny(cmd):
    j = _bash(cmd)
    assert j.hard_deny is False
    assert j.boundary is Boundary.OUT_OF_BOUNDS

# --- 删除判据携带 running cwd(供分类器提示词"当前目录") ---
@pytest.mark.parametrize(
    "cmd, expected_cwd",
    [
        ("rm -rf $VAR", "/workspace"),
        ("cd /data && rm -rf $VAR", "/data"),
        ("cd $X && rm -rf $VAR", None),
    ],
)
def test_deletion_judgement_carries_cwd(cmd, expected_cwd):
    assert _bash(cmd).cwd == expected_cwd
