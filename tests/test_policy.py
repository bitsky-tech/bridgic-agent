"""安全政策数据层单测(_policy)。

覆盖:路径解析(env 覆盖)、缺失/非法/坏 schema/未知键/无阻断规则一律退内置默认
(fail-safe)、合法解析、缺省段归空、重载读到最新(不缓存)。
"""

from __future__ import annotations

import json
from pathlib import Path

from src.amphi_agent.security._default_policy import DEFAULT_POLICY
from src.amphi_agent.security._policy import (
    Policy,
    _DEFAULT_PATH,
    load_policy,
    resolve_policy_path,
)


def test_resolve_path_env_override(monkeypatch) -> None:
    monkeypatch.delenv("AMPHI_POLICY_FILE", raising=False)
    assert resolve_policy_path() == _DEFAULT_PATH
    monkeypatch.setenv("AMPHI_POLICY_FILE", "/tmp/custom-policy.json")
    assert resolve_policy_path() == Path("/tmp/custom-policy.json")


def test_missing_file_returns_default(tmp_path) -> None:
    assert load_policy(tmp_path / "nope.json") is DEFAULT_POLICY


def test_valid_file_parsed(tmp_path) -> None:
    p = tmp_path / "policy.json"
    p.write_text(json.dumps({
        "allow": ["a1"],
        "soft_deny": ["s1", "s2"],
        "hard_deny": ["h1"],
        "environment": ["e1"],
    }), encoding="utf-8")
    pol = load_policy(p)
    assert pol == Policy(allow=("a1",), soft_deny=("s1", "s2"), hard_deny=("h1",), environment=("e1",))


def test_missing_sections_default_empty(tmp_path) -> None:
    p = tmp_path / "policy.json"
    p.write_text(json.dumps({"hard_deny": ["only"]}), encoding="utf-8")
    pol = load_policy(p)
    assert pol.hard_deny == ("only",)
    assert pol.allow == () and pol.soft_deny == () and pol.environment == ()


def test_invalid_json_returns_default(tmp_path) -> None:
    p = tmp_path / "policy.json"
    p.write_text("{ not valid json ", encoding="utf-8")
    assert load_policy(p) is DEFAULT_POLICY


def test_bad_schema_returns_default(tmp_path) -> None:
    for bad in ([1, 2, 3], {"soft_deny": "not-a-list"}, {"hard_deny": [1, 2]}, "top-level-string"):
        p = tmp_path / f"policy_{abs(hash(str(bad)))}.json"
        p.write_text(json.dumps(bad), encoding="utf-8")
        assert load_policy(p) is DEFAULT_POLICY, bad


def test_unknown_key_returns_default(tmp_path) -> None:
    # 拼错键(hard-deny / hardDeny)或多余键 → 退默认,避免"以为设了硬红线、其实被静默丢弃"。
    for bad in ({"hard-deny": ["NEVER"]}, {"hardDeny": ["NEVER"]}, {"allow": ["x"], "evil": 1}):
        p = tmp_path / f"policy_{abs(hash(str(bad)))}.json"
        p.write_text(json.dumps(bad), encoding="utf-8")
        assert load_policy(p) is DEFAULT_POLICY, bad


def test_no_blocking_rules_returns_default(tmp_path) -> None:
    # 无任何 soft_deny/hard_deny(空对象 / 只有 allow / null 段)→ 分类器将放行一切灰色调用,
    # 视为坏配置退默认(fail-safe,不静默 fail-open)。
    for empty in ({}, {"allow": ["x"]}, {"environment": ["e"]}, {"soft_deny": None, "hard_deny": None}):
        p = tmp_path / f"policy_{abs(hash(str(empty)))}.json"
        p.write_text(json.dumps(empty), encoding="utf-8")
        assert load_policy(p) is DEFAULT_POLICY, empty


def test_default_policy_is_tailored_and_blocks() -> None:
    # 裁剪版生产默认政策:四段都非空,且 hard_deny 非空(auto 下分类器可 deny 数据外发)。
    assert DEFAULT_POLICY.allow and DEFAULT_POLICY.soft_deny
    assert DEFAULT_POLICY.hard_deny and DEFAULT_POLICY.environment
    assert any("Data exfiltration" in s for s in DEFAULT_POLICY.hard_deny)


def _find(section: tuple, keyword: str) -> str:
    """取出含关键词的那条政策;取不到返回空串(让断言给出可读失败)。

    优先按**类目名**(条目开头到首个冒号)匹配 —— 关键词可能同时出现在别条的正文里,
    纯子串匹配会取错条目。
    """
    by_name = [s for s in section if keyword in s.split(":", 1)[0]]
    return by_name[0] if by_name else next((s for s in section if keyword in s), "")


def test_workspace_dependency_install_is_allowed() -> None:
    # auto 下最高频的正常步骤:空工作区里为完成任务装依赖 / 拉运行时资源。
    # 判据按"装到哪 / 从哪来 / 有无提权"而非枚举包管理器,故不因生态更迭失效。
    entry = _find(DEFAULT_POLICY.allow, "Workspace dependency")
    assert entry, "allow 段缺『工作区依赖与资源准备』例外"
    assert "mirror the user has already configured" in entry
    assert "sudo" in entry and "--global" in entry  # B 档仍不解锁


def test_soft_deny_scoped_to_four_interrupting_categories() -> None:
    """弹窗面只保留四类:工作区外的不可逆毁坏、改 Agent 自身、真实世界后果、外部系统写。

    其余(凭证 / 出网 / 系统级安装 / 对外发布 / 不可控来源执行)降为「**送审但不弹窗**」——
    它们仍触碰风险面、仍过一遍分类器(注入与异常模式还有拦截点),但不再命中任何 soft_deny,
    故判 allow、不打断用户。明显的恶意外传由 hard_deny『数据外发』直接拒绝,那是 deny 不是 ask。
    """
    names = {s.split(":", 1)[0] for s in DEFAULT_POLICY.soft_deny}
    assert names == {
        "Irreversible local destruction",
        "Self-modification",
        "Instruction poisoning",
        "Real-world transactions",
        "External system writes",
    }


def test_no_dangling_cross_references() -> None:
    # 删条目时必须一并清理其它段对它的引用,否则提示词里会出现指向不存在类目的悬空指路。
    removed = (
        "External code execution",
        "Unverified destination",
        "Package registry bypass",
        "Exposing local",
        "Credential materialisation",
    )
    body = "\n".join(DEFAULT_POLICY.allow + DEFAULT_POLICY.soft_deny + DEFAULT_POLICY.hard_deny)
    for name in removed:
        assert f"'{name}'" not in body, name


def test_mounted_paths_are_authorized() -> None:
    assert _find(DEFAULT_POLICY.allow, "Mounting a file is authorisation"), "allow 段缺挂载授权例外"


def test_user_named_project_dir_is_quasi_workspace() -> None:
    """用户在请求里点名某个本地项目目录并要求在其中工作时,该目录就是本次任务的工作区。

    信任边界原本只认两种:会话 .work 与 UI「添加文件/文件夹」挂载。用户在对话里给出
    绝对路径("基于 /path/to/repo 帮我做…")不算,于是整个任务的写操作全判越界送审 ——
    实测一个会话连弹 5 次、用户 5 次全点允许。
    """
    entry = _find(DEFAULT_POLICY.allow, "A project directory the user named")
    assert entry, "allow 段缺『用户点名的项目目录』例外"
    assert "creating files" in entry and "deleting" in entry  # 新建/编辑放行,删除仍按原规则


def test_new_file_creation_is_not_irreversible_destruction() -> None:
    # 分类器实测把"往刚 mkdir 出来的新目录里写新文件"判成"可能覆盖会话前已存在的文件"。
    # 定义里必须显式排除新建,否则模型确认不了文件存不存在就会保守 ask。
    entry = _find(DEFAULT_POLICY.soft_deny, "Irreversible local destruction")
    assert "creating a new file" in entry and "did not exist before" in entry


def test_dependency_install_covers_user_named_dirs() -> None:
    # 原表述写死"在会话工作区内",导致用户点名的外部项目里 `pnpm add` 落不进例外。
    entry = _find(DEFAULT_POLICY.allow, "Workspace dependency")
    assert "project directory the user named" in entry


def test_workspace_dependency_install_needs_no_soft_deny_backstop() -> None:
    # 『外部代码执行』已从 soft_deny 移除,allow 例外不得再把"任一不满足"指回一个不存在的类目。
    entry = _find(DEFAULT_POLICY.allow, "Workspace dependency")
    assert "External code execution" not in entry


def test_app_level_python_base_dependency_install_is_allowed() -> None:
    """The product-managed shared base is the intended Python install target."""
    dependency_rule = _find(DEFAULT_POLICY.allow, "Workspace dependency")
    environment = _find(DEFAULT_POLICY.environment, "The Python runtime")

    assert "uv pip install <pkg>" in dependency_rule
    assert "python <script>" in dependency_rule
    assert "~/.bridgic/AmphiAgent/python/base" in dependency_rule
    assert "counts as a global / system install or as self-modification" in dependency_rule
    assert "~/.bridgic/AmphiAgent/python/base" in environment
    assert "Child Agent" in environment
    assert "do not create a Python project or virtual environment in the workspace" in environment


def test_app_base_install_is_not_bundled_interpreter_self_modification() -> None:
    """Base dependencies are writable while signed interpreter files stay protected."""
    dependency_rule = _find(DEFAULT_POLICY.allow, "Workspace dependency")
    self_modification = _find(DEFAULT_POLICY.soft_deny, "Self-modification")

    assert "uv pip install <pkg>" in dependency_rule
    assert "app-bundled Python interpreter and standard-library files" in self_modification
    assert "uv pip install" in self_modification
    assert "does not match this entry" in self_modification


def test_workspace_writes_are_not_irreversible_destruction() -> None:
    # 工作区内有 checkpoint 兜底,不该按"不可逆毁坏"拦。
    entry = _find(DEFAULT_POLICY.soft_deny, "Irreversible local destruction")
    assert "outside the workspace" in entry and "checkpoint" in entry


def test_environment_states_workspace_is_disposable() -> None:
    # 击穿"无清单 = 异常"的前提:工作区本就是每会话新建的空目录。
    assert _find(DEFAULT_POLICY.environment, "throwaway isolated directory")


def test_reload_reflects_latest_content(tmp_path) -> None:
    # 不缓存:改文件下次读到最新(热重载,且无 mtime 缓存的"同刻改写读旧"问题)。
    p = tmp_path / "policy.json"
    p.write_text(json.dumps({"hard_deny": ["A"]}), encoding="utf-8")
    assert load_policy(p).hard_deny == ("A",)
    p.write_text(json.dumps({"hard_deny": ["B"]}), encoding="utf-8")
    assert load_policy(p).hard_deny == ("B",)
