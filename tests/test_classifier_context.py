"""分类器上下文注入:可信通道(多轮用户消息)+ 待核验通道(Agent 推理)。

对照双通道设计:授权只认【用户请求】(user-provenance,跨轮),【Agent 推理】仅供
理解动作并交叉核验(不可信、不单独授权、工具结果仍不喂)。
"""

from __future__ import annotations

from types import SimpleNamespace

from src.amphi_agent._agent import AmphiAgent
from src.amphi_agent._context import AmphiContext
from src.amphi_agent._session import Session
from src.amphi_agent.security._routing import append_user_decisions


def _turn(text: str) -> SimpleNamespace:
    # Session.get_all() 只返回存入的 list、不校验类型,故用鸭子对象即可。
    return SimpleNamespace(user_input=SimpleNamespace(text=text))


def _ota(user_input: str = "", step_content: str = "") -> SimpleNamespace:
    return SimpleNamespace(
        user_input=user_input,
        think_result=SimpleNamespace(step_content=step_content),
    )


def test_recent_user_messages_preserves_only_recent_user_provenance() -> None:
    context = AmphiContext(session=Session(turns=[_turn("清理定时任务"), _turn("再帮我删掉旧的")]))
    msgs = AmphiAgent._recent_user_messages(_ota(user_input="继续"), context)
    assert msgs == ["清理定时任务", "再帮我删掉旧的", "继续"]  # 跨轮历史 + 当前轮
    assert AmphiAgent._recent_user_messages(_ota(user_input="登录飞书"), None) == ["登录飞书"]

    context = AmphiContext(session=Session(turns=[_turn("登录飞书")]))
    assert AmphiAgent._recent_user_messages(_ota(user_input="登录飞书"), context) == ["登录飞书"]

    context = AmphiContext(session=Session(turns=[_turn(f"m{i}") for i in range(8)]))
    msgs = AmphiAgent._recent_user_messages(_ota(user_input="now"), context)
    assert len(msgs) == 5 and msgs[-1] == "now"  # 最近 5 条,当前轮必含

    context = AmphiContext(session=Session(turns=[_turn(""), SimpleNamespace(user_input=None), _turn("有效")]))
    assert AmphiAgent._recent_user_messages(_ota(user_input=""), context) == ["有效"]


def test_current_reasoning_is_bounded_and_optional() -> None:
    r = AmphiAgent._current_reasoning(_ota(step_content="x" * 5000))
    assert 0 < len(r) <= 2000  # 有上限,控提示词体积 + 注入面
    assert AmphiAgent._current_reasoning(SimpleNamespace(think_result=None)) == ""


# ---------------------------------------------------------------------------
# 本会话审批记忆 —— 事实源是 <session>/.internal/permissions/_routing.jsonl 的决策行。
#
# 不从 session 对象拼装的三个实证理由(见 _session_approvals docstring):
#   ① _resume_permission 结尾 session.without_last() 把挂起轮摘掉,本轮决策在
#      session.get_all() 里永远不出现(真实会话 session_20260726_185427:19:20:37
#      批准了 .gitignore 编辑,19:20:56 同一轮同一个编辑又弹了一次);
#   ② 从 items 拼装时目标被截断到 200 字符,heredoc 命令的意图在尾部被切掉;
#   ③ append-only 文件不受对象生命周期影响,daemon 重启后记忆仍在。
# ---------------------------------------------------------------------------
def _ctx_with_perm_dir(perm_dir) -> SimpleNamespace:
    # _permission_dir 只 getattr,鸭子对象即可(AmphiContext.workspace 有类型约束)。
    return SimpleNamespace(workspace=SimpleNamespace(permission_dir=perm_dir))


def _record(perm_dir, items: list) -> None:
    append_user_decisions(perm_dir, items)


def test_session_approvals_extracts_decisions_best_effort(tmp_path) -> None:
    # 沿用 main 的"一个测试盖住提取 + 空态 + 容错"结构;数据源换成账本(本 PR 的改动)。
    _record(tmp_path, [
        {"tool": "bash", "decision": "allow", "arguments": {"command": "./deploy.sh"}, "summary": "运行部署脚本"},
        {"tool": "bash", "decision": "deny", "arguments": {"command": "dropdb prod"}, "summary": "删除生产数据库"},
        {"tool": "bash", "decision": None, "arguments": {"command": "x"}, "summary": "尚未决策"},  # 无决策 → 跳过
    ])
    approvals = AmphiAgent._session_approvals(_ctx_with_perm_dir(tmp_path))
    # Marks are pinned to English — the classifier prompt is the sole consumer.
    assert any("allowed" in a and "运行部署脚本" in a for a in approvals)
    assert any("denied" in a and "删除生产数据库" in a for a in approvals)
    assert not any("尚未决策" in a for a in approvals)

    # 无 context / 有目录但无账本 → 空,不抛
    assert AmphiAgent._session_approvals(None) == []
    assert AmphiAgent._session_approvals(_ctx_with_perm_dir(tmp_path / "empty")) == []

    # 账本里混入坏行 / 非对象行不得抛异常,也不得毁掉整份记忆(best-effort)。
    with (tmp_path / "_routing.jsonl").open("a", encoding="utf-8") as handle:
        handle.write("{坏 JSON\n[1,2]\n")
    assert any("运行部署脚本" in a for a in AmphiAgent._session_approvals(_ctx_with_perm_dir(tmp_path)))


def test_session_approvals_sees_same_turn_decisions(tmp_path) -> None:
    """本轮刚批准的决策立刻可见 —— 账本在 append_decisions 同刻写入,不等 turn 持久化。"""
    _record(tmp_path, [{
        "tool": "edit_file", "decision": "allow",
        "arguments": {"file_path": "/repo/.gitignore"}, "summary": "把视频产物加入忽略列表",
    }])
    approvals = AmphiAgent._session_approvals(_ctx_with_perm_dir(tmp_path))
    assert any("edit_file" in a and "/repo/.gitignore" in a for a in approvals)


def test_session_approvals_accumulates_across_turns(tmp_path) -> None:
    # 历史轮与本轮同在一份 append-only 账本里,不再需要两路来源各取一半。
    _record(tmp_path, [{"tool": "bash", "decision": "allow", "arguments": {"command": "pnpm i"}, "summary": "装依赖"}])
    _record(tmp_path, [{"tool": "edit_file", "decision": "allow", "arguments": {"file_path": "/repo/.gitignore"}}])
    approvals = AmphiAgent._session_approvals(_ctx_with_perm_dir(tmp_path))
    assert any("装依赖" in a for a in approvals)
    assert any("/repo/.gitignore" in a for a in approvals)


def test_approval_line_carries_concrete_target() -> None:
    # 只有人话摘要判不出"同不同类",必须带具体目标。
    line = AmphiAgent._approval_line({
        "tool": "bash", "decision": "allow", "command": "pnpm add remotion", "summary": "安装依赖",
    })
    assert "pnpm add remotion" in line and "✅ allowed" in line


def test_approval_line_is_english_regardless_of_the_active_locale() -> None:
    """The only consumer is the classifier's all-English system prompt, whose
    approved/denied recognition keys off these lines — same reason _engine.py
    pins judgement labels to en. A zh mark inside the English prompt degraded
    matching and re-asked already-approved operations."""
    from src.amphi_service.i18n import use_locale

    with use_locale("zh"):
        line = AmphiAgent._approval_line({
            "tool": "bash", "decision": "deny", "command": "rm -rf /",
        })
    assert "⛔ denied" in line and "target: rm -rf /" in line


def test_approval_line_renders_a_persisted_label_id_in_english(tmp_path) -> None:
    """Rows persist the judgement's label id alongside the park-time rendering, so
    the classifier line re-renders it in English even for zh sessions."""
    from src.amphi_service.i18n import use_locale

    with use_locale("zh"):
        line = AmphiAgent._approval_line({
            "tool": "bash",
            "decision": "allow",
            "command": "cat ~/.ssh/id_rsa",
            "label": "读写敏感文件",
            "label_id": "security.label.sensitive_file_access",
        })
    assert "读写敏感文件" not in line
    assert "sensitive file" in line.lower()


def test_approval_line_keeps_heredoc_tail(tmp_path) -> None:
    """长 heredoc 命令的**尾部**必须留在决策行里 —— 那才是真正要跑的东西。

    旧实现取前 200 字符,而 ``python3 - <<'PY' … base64 … PY`` 前 200 字符全是壳:
    分类器据此判不出"同类",于是刚批准过的操作又被问一遍(截图实证)。
    """
    command = "python3 - <<'PY'\n" + ("# padding\n" * 400) + "PY\nuv run python create_task_record.py --note 结尾标记"
    _record(tmp_path, [{"tool": "bash", "decision": "allow", "arguments": {"command": command}}])
    line = AmphiAgent._session_approvals(_ctx_with_perm_dir(tmp_path))[0]
    assert "create_task_record.py" in line and "结尾标记" in line


def test_session_approvals_dedups_repeated_lines(tmp_path) -> None:
    same = {"tool": "edit_file", "decision": "allow", "arguments": {"file_path": "/repo/.gitignore"}}
    _record(tmp_path, [same])
    _record(tmp_path, [same])
    assert len(AmphiAgent._session_approvals(_ctx_with_perm_dir(tmp_path))) == 1


# ---------------------------------------------------------------------------
# 用户点名的路径:不随 5 条消息窗口滑出
# ---------------------------------------------------------------------------
def test_named_paths_survive_the_message_window() -> None:
    named = "/Users/me/Desktop/github-code/box-stl-generator"
    turns = [_turn(f"基于 {named} 帮我做个视频")] + [_turn(t) for t in ("继续", "好的", "再改一下", "嗯")]
    context = AmphiContext(session=Session(turns=turns))
    # 点名那条已被挤出最近 5 条用户消息……
    assert not any(named in m for m in AmphiAgent._recent_user_messages(_ota(user_input="接着来"), context))
    # ……但仍在点名路径里,ALLOW『用户点名的项目目录』不会静默失效。
    assert named in AmphiAgent._named_paths(_ota(user_input="接着来"), context)


def test_named_paths_strips_trailing_punctuation_and_dedups() -> None:
    context = AmphiContext(session=Session(turns=[_turn("看看 /srv/app，然后再看 /srv/app。")]))
    assert AmphiAgent._named_paths(_ota(user_input=""), context) == ["/srv/app"]


def test_named_paths_empty_without_paths() -> None:
    context = AmphiContext(session=Session(turns=[_turn("帮我写个函数")]))
    assert AmphiAgent._named_paths(_ota(user_input="继续"), context) == []


def test_named_paths_ignores_non_paths() -> None:
    # 中文顿号式 "视频/动画"、URL、相对路径、"and/or"、"24/7" 都不是本地路径。
    noise = [
        "Remotion 视频/动画项目的最佳实践",
        "看看 https://example.com/docs/guide",
        "这个是 and/or 的问题，24/7 都在跑，文件在 ./relative/path 里",
    ]
    context = AmphiContext(session=Session(turns=[_turn(t) for t in noise]))
    assert AmphiAgent._named_paths(_ota(user_input=""), context) == []


def test_named_paths_keeps_unicode_dirs_and_strips_quoting() -> None:
    context = AmphiContext(session=Session(turns=[_turn("看 /Users/me/我的项目/src 和 `/opt/app` 行吗")]))
    assert AmphiAgent._named_paths(_ota(user_input=""), context) == ["/Users/me/我的项目/src", "/opt/app"]


def test_named_paths_keeps_windows_drive_paths() -> None:
    context = AmphiContext(session=Session(turns=[
        _turn(r"打开 C:\Users\me\项目 和 D:/code/app。"),
    ]))
    assert AmphiAgent._named_paths(_ota(user_input=""), context) == [
        r"C:\Users\me\项目",
        "D:/code/app",
    ]


def test_named_paths_keeps_quoted_windows_paths_with_spaces() -> None:
    context = AmphiContext(session=Session(turns=[
        _turn(r'检查 `C:\Users\me\My Project\src` 和 "D:/研发 项目/app"'),
    ]))
    assert AmphiAgent._named_paths(_ota(user_input=""), context) == [
        r"C:\Users\me\My Project\src",
        "D:/研发 项目/app",
    ]


def test_named_paths_ignores_windows_drive_like_noise() -> None:
    context = AmphiContext(session=Session(turns=[
        _turn(r"版本 C:123、变量 NAME:value 和网址 https://example.com/C:/fake"),
    ]))
    assert AmphiAgent._named_paths(_ota(user_input=""), context) == []
