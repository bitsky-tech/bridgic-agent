"""``_deletion_targets`` 单测 —— 删除命令的目标提取。

覆盖删除命令目标提取契约:

- 非删除命令、或非递归的 ``rm`` → ``None``(不走删除判据)。
- 删除命令 → 返回**所有**删除目标的 list —— 含简单名字(``usr``)、处理
  ``--`` end-of-options、剥掉 ``sudo``/``env`` 前缀。
- ``find`` → 起始路径(谓词 ``-delete``/``-exec`` 之前的路径操作数)。

只测"目标是什么",系统盘 / 边界 / uncertain 的裁决在别处测。
"""

from __future__ import annotations

import pytest

from src.amphi_agent.security._classify import _deletion_targets


@pytest.mark.parametrize(
    "cmd, expected",
    [
        # rm:简单名字不能漏(这是旧启发式的致命盲区)
        ("rm -rf usr bin", ["usr", "bin"]),
        ("rm file.txt", ["file.txt"]),  # 非递归单文件也纳入删除判据
        ("rm -rf a b c d", ["a", "b", "c", "d"]),
        # `--` end-of-options:之后即使是选项形态也算目标
        ("rm -rf -- /etc", ["/etc"]),
        # 正常多目标:全工作区内,简单名一个都不能漏
        ("rm -rf node_modules dist build", ["node_modules", "dist", "build"]),
        # 手误混进系统盘:必须提取到 /(后续判据据此 hard_deny)
        ("rm -rf build /", ["build", "/"]),
        # 递归标志的各种写法
        ("rm -R /var", ["/var"]),
        ("rm -fr /opt", ["/opt"]),
        ("rm --recursive /srv", ["/srv"]),
        # find:起始路径
        ("find / -delete", ["/"]),
        ("find /tmp -exec rm {} +", ["/tmp"]),
        # wrapper 剥离
        ("sudo rm -rf /", ["/"]),
        ("env FOO=1 rm -rf /", ["/"]),
    ],
)
def test_deletion_targets_extract(cmd, expected):
    assert _deletion_targets(cmd) == expected


@pytest.mark.parametrize(
    "cmd",
    [
        "ls -la",
        "cat x.txt",
        "echo rm -rf /",  # argv0=echo,不是删除
        "grep -r foo .",  # 有 -r 但不是 rm
    ],
)
def test_non_deletion_returns_none(cmd):
    assert _deletion_targets(cmd) is None
