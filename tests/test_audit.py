"""审计记录必须**自包含** —— 排查一次权限误判所需的一切都在文件里。

这份测试存在的唯一理由:早期版本为省空间把 SYSTEM 段(判定准则)换成了 sha256 指纹,
排查时只能回去敲命令重建。审计记录的价值就在于自包含,省那 16KB 不值得 —— 何况进
分类器的调用本就是少数(auto 铁律 + 信任边界补齐后,实测整场会话 0~3 次)。
把它钉在这里,免得下次又有人以"重复文本"为由优化掉。
"""

from __future__ import annotations

from src.amphi_agent.security._audit import (
    append_decisions,
    write_approval_record,
    write_classify_record,
    write_verdict_record,
)
from src.amphi_agent.security._classifier import ClassifyVerdict, _build_system_prompt
from src.amphi_service.i18n import use_locale


SYSTEM = "【SOFT DENY】\n- [S1] 不可逆本地毁坏:删工作区外既存文件\nSYSTEM_MARK_Z"
USER = "用户近期请求:\n- 帮我清理构建产物\nUSER_MARK_Q"


def test_classify_record_embeds_full_system_prompt(tmp_path) -> None:
    path = write_classify_record(
        tmp_path, SYSTEM, USER, [ClassifyVerdict(verdict="ask", reason="r", rule="不可逆本地毁坏")]
    )
    assert path is not None
    text = path.read_text(encoding="utf-8")
    # 判定准则全文 —— 不是指纹、不是"按其重建"的说明
    assert "SYSTEM_MARK_Z" in text
    assert "[S1] 不可逆本地毁坏" in text
    assert "sha256" not in text
    # user 侧照旧全文
    assert "USER_MARK_Q" in text
    # 裁决表:verdict / rule / reason 三列都在
    assert "| 0 | ask | 不可逆本地毁坏 | r |" in text


def test_classify_record_survives_real_policy_prompt(tmp_path) -> None:
    """用真实政策构建的提示词(含大量 markdown 特殊字符)也要能原样落盘、不被截断。"""
    from src.amphi_agent.security._default_policy import DEFAULT_POLICY

    system = _build_system_prompt(DEFAULT_POLICY)
    path = write_classify_record(tmp_path, system, USER, [ClassifyVerdict(verdict="allow")])
    assert path is not None
    text = path.read_text(encoding="utf-8")
    assert system in text, "真实提示词未被原样嵌入(可能被转义或截断)"


def test_classify_record_failure_is_silent(tmp_path) -> None:
    # 审计是旁路:目录不可用时返回 None,绝不抛异常打断判定。
    assert write_classify_record(None, SYSTEM, USER, []) is None


def test_verdict_record_keeps_full_arguments(tmp_path) -> None:
    # 裁决记录同理:完整参数(命令原文)必须在,否则事后无从复现当时判的是什么。
    long_command = "python3 - <<'PY'\n" + ("x = 1\n" * 200) + "PY"
    path = write_verdict_record(tmp_path, "auto", [{
        "tool": "bash", "arguments": {"command": long_command},
        "capability": "execute", "boundary": "in_workspace", "verdict": "allow",
    }])
    assert path is not None
    assert long_command in path.read_text(encoding="utf-8")


def test_new_audit_records_follow_the_active_backend_locale(tmp_path) -> None:
    records = [{
        "tool": "bash",
        "capability": "execute",
        "boundary": "in_workspace",
        "reason": "requires confirmation",
        "summary": "Run the build command.",
        "arguments": {"command": "npm run build"},
    }]
    with use_locale("en"):
        approval = write_approval_record(tmp_path, "request-123", "auto", records)
        classify = write_classify_record(
            tmp_path, "system prompt", "user prompt", [ClassifyVerdict(verdict="ask")]
        )
        verdict = write_verdict_record(tmp_path, "auto", records)
        assert approval is not None
        append_decisions(str(approval), [{"tool": "bash", "decision": "allow"}])

    assert approval is not None and "# Tool approval record" in approval.read_text(encoding="utf-8")
    assert "## User decisions (" in approval.read_text(encoding="utf-8")
    assert classify is not None and "# Safety classifier decision record" in classify.read_text(encoding="utf-8")
    assert verdict is not None and "# Permission verdict record" in verdict.read_text(encoding="utf-8")
