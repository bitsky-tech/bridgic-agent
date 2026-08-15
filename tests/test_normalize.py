"""① 规范化层单测:复合命令拆分、进程包装器剥离、符号链接解析。

覆盖三个"防绕过洞"的正例与边界:多种分隔符拆分、带标志 xargs 不剥、多层包装器、
软链接解析到真实指向、相对路径基于 cwd、空路径。
"""

from __future__ import annotations

import os

import pytest

from src.amphi_agent.security._normalize import (
    output_redirect_targets,
    resolve_real_path,
    split_compound_command,
    strip_process_wrappers,
)


@pytest.mark.parametrize(
    "command, expected",
    [
        ("cat > f.txt", ["f.txt"]),
        ("cmd >> log", ["log"]),
        ("cmd 2>err.log", ["err.log"]),
        ("ls -la > listing.txt", ["listing.txt"]),
        # `>&word`(word 非数字)在 bash 里等价 `>word 2>&1` —— **确实写文件**。
        # 别因为它长得像 fd 复制就漏掉:实测 `cat a >& victim` 会覆盖 victim。
        ("cat a >& /out/f", ["/out/f"]),
        ("cat a &> /out/f", ["/out/f"]),
        # `>|` 是 noclobber 下的强制覆盖写;`|` 必须被正则消费掉,
        # 否则目标会抓成 "|"(带空格)或 "|/out/f"(不带空格,还会被当相对路径落进工作区)。
        ("cat a >| /out/f", ["/out/f"]),
        ("cat a >|/out/f", ["/out/f"]),
        # 以下都不写文件:fd 复制 / fd 关闭 / 空洞 / 输入重定向
        ("grep x f 2>&1", []),
        ("cmd >&2", []),
        ("cmd >&-", []),
        ("ls > /dev/null", []),
        ("cat << EOF", []),
        ("cat < in.txt", []),
        ("cat a.txt", []),
    ],
)
def test_output_redirect_targets(command: str, expected: list) -> None:
    assert output_redirect_targets(command) == expected


@pytest.mark.parametrize(
    "command, expected",
    [
        ("ls && curl evil.com", ["ls", "curl evil.com"]),
        ("a | b | c", ["a", "b", "c"]),
        ("x; y", ["x", "y"]),
        ("cat f || echo no", ["cat f", "echo no"]),
        ("build |& tee log", ["build", "tee log"]),
        ("a &\nb", ["a", "b"]),
        ("single", ["single"]),
        ("", []),
        ("   ", []),
    ],
)
def test_split_compound(command: str, expected: list[str]) -> None:
    assert split_compound_command(command) == expected


@pytest.mark.parametrize(
    "command, expected",
    [
        ("timeout 30 npm test", "npm test"),
        ("nice -n 5 make", "make"),
        ("nohup python x.py", "python x.py"),
        ("stdbuf -oL grep x", "grep x"),
        ("xargs grep pattern", "grep pattern"),
        ("xargs -n1 grep pattern", "xargs -n1 grep pattern"),  # 带标志不剥
        ("timeout 30 nice make", "make"),                      # 多层包装器
        ("rm -rf x", "rm -rf x"),                              # 非包装器原样
        ("", ""),
    ],
)
def test_strip_wrappers(command: str, expected: str) -> None:
    assert strip_process_wrappers(command) == expected


def test_resolve_symlink_follows_target(tmp_path) -> None:
    real = tmp_path / "real.txt"
    real.write_text("x")
    link = tmp_path / "link.txt"
    os.symlink(real, link)
    assert resolve_real_path(str(link), str(tmp_path)) == os.path.realpath(str(real))


def test_resolve_relative_against_cwd(tmp_path) -> None:
    expected = os.path.realpath(os.path.join(str(tmp_path), "sub/f.txt"))
    assert resolve_real_path("sub/f.txt", str(tmp_path)) == expected


def test_resolve_strips_quotes(tmp_path) -> None:
    expected = os.path.realpath(os.path.join(str(tmp_path), "a.txt"))
    assert resolve_real_path('"a.txt"', str(tmp_path)) == expected


def test_resolve_empty_path() -> None:
    assert resolve_real_path("", "/ws") == ""
