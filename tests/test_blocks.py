"""``render_input`` — raw turn input → inlined prompt text.

The @-mention ordering fix: each mention's resolved path is inlined AT ITS POSITION,
so the user's ordering survives. ``render_input`` is pure (takes an already-resolved
``path_map``), fail-closed: traversal, absolute paths and symlink escapes degrade to
the clean ``@label``. (The session-wired ``user_input_block`` path is exercised end
to end by test_chat's mention-injection turn.)
"""

from __future__ import annotations

from typing import Dict, List, Optional

import pytest

from src.amphi_agent._cognitive import render_input
from src.amphi_service.i18n import use_locale
from src.amphi_store import UserInput
from src.amphi_service.protocol._ws_messages import (
    WsAcceptRuleMessage,
    WsBuildConfirmMessage,
    WsChatMessage,
    WsMentionBlock,
    WsMessageError,
    WsSlashBlock,
    WsTaskConfirmMessage,
    WsTextBlock,
    WsWorkflowConfirmMessage,
    parse_client_message,
)


def _frame(blocks: List) -> WsChatMessage:
    return WsChatMessage(type="chat", session_id="s1", input="raw", blocks=blocks)


def _render(blocks: List, path_map: Optional[Dict[str, str]] = None) -> str:
    """render_input over a frame with an already-resolved ``path_map``."""
    return render_input(_frame(blocks), path_map or {})


def test_input_shapes_and_inline_order() -> None:
    """Plain str → verbatim; blockless frame → its .input text; mentions / slash
    commands render AT THEIR POSITION so the user's ordering survives, with a
    repeated mention inlining at every occurrence."""
    assert render_input("统计当前目录文件数") == "统计当前目录文件数"
    assert render_input(
        WsChatMessage(type="chat", session_id="s1", input="legacy text")
    ) == "legacy text"
    assert render_input(_frame([WsTextBlock(value="hello")])) == "hello"

    out = _render(
        [
            WsTextBlock(value="先读 "),
            WsMentionBlock(id="mnt_config", label="config.json", group="g"),
            WsTextBlock(value="，再改 "),
            WsMentionBlock(id="mnt_main", label="main.py", group="g"),
        ],
        {"mnt_config": "/abs/config.json", "mnt_main": "/abs/main.py"},
    )
    assert out == "先读 config.json(/abs/config.json)，再改 main.py(/abs/main.py)"

    repeated = _render(
        [
            WsMentionBlock(id="m", label="a.py", group="g"),
            WsTextBlock(value=" 和 "),
            WsMentionBlock(id="m", label="a.py", group="g"),
        ],
        {"m": "/p/a.py"},
    )
    assert repeated == "a.py(/p/a.py) 和 a.py(/p/a.py)"

    slash = _render(
        [WsSlashBlock(id="think", label="思考"), WsTextBlock(value=" 这个问题")], {},
    )
    assert slash == "/think 这个问题"

    build = _render(
        [WsSlashBlock(id="build", label="构建"), WsTextBlock(value=" 每周生成报告")], {},
    )
    assert build == "我明确要求将后续需求构建成一个可复用的 Workflow。构建需求： 每周生成报告"
    assert render_input("/build 每周生成报告") == "/build 每周生成报告"

    help_request = _render(
        [WsSlashBlock(id="help", label="帮助"), WsTextBlock(value=" 我该从哪开始？")],
        {},
    )
    assert "Call the `help` tool" in help_request
    assert "current conversation context" in help_request
    assert "give the user a final answer in the language they are using" in help_request
    assert help_request.endswith("Additional input: 我该从哪开始？")
    assert render_input("/help") == "/help"

    workflow = _render(
        [
            WsSlashBlock(id="wf_123", label="每周报告", resource="workflow"),
            WsTextBlock(value=" 使用本周数据"),
        ],
        {},
    )
    assert workflow == (
        "我明确要求运行已保存的 Workflow“每周报告”（workflow_id: `wf_123`）。"
        "运行输入： 使用本周数据"
    )

    with use_locale("en"):
        build_en = _render(
            [WsSlashBlock(id="build", label="Build"), WsTextBlock(value=" weekly report")], {},
        )
        workflow_en = _render(
            [
                WsSlashBlock(id="wf_123", label="Weekly report", resource="workflow"),
                WsTextBlock(value=" use this week's data"),
            ],
            {},
        )
    assert build_en == (
        "I explicitly request that the following requirement be built into a reusable Workflow. "
        "Build requirement: weekly report"
    )
    assert workflow_en == (
        "I explicitly request to run the saved Workflow “Weekly report” (workflow_id: `wf_123`). "
        "Run input: use this week's data"
    )

    schedule = _render(
        [
            WsSlashBlock(id="sched_123", label="每日汇总", resource="schedule"),
            WsTextBlock(value=" 立即执行"),
        ],
        {},
    )
    assert schedule == "/每日汇总 立即执行"

    schedule_reference = _render(
        [WsMentionBlock(id="sched_123", label="每日汇总", group="Schedule")],
        {},
    )
    assert schedule_reference == "@每日汇总(schedule_id=sched_123)"

    persisted = UserInput(
        text="比较历史结果",
        blocks=[
            {"type": "text", "value": "比较 "},
            {"type": "mention", "id": "wfr_1", "label": "上次结果", "group": "WorkflowRun"},
        ],
    )
    assert render_input(persisted, {"wfr_1": "/runs/wfr_1/result"}) == "比较 上次结果(/runs/wfr_1/result)"

    internal = render_input(
        WsWorkflowConfirmMessage(
            session_id="s1",
            request_id="req-1",
            action="confirm",
            name="工作流",
        )
    )
    assert internal == ""


def test_workflow_confirm_is_a_ws_message_not_chat_block() -> None:
    msg = parse_client_message({
        "type": "workflow_confirm",
        "session_id": "s1",
        "request_id": "req-1",
        "action": "confirm",
        "name": "工作流",
    })
    assert isinstance(msg, WsWorkflowConfirmMessage)
    assert msg.name == "工作流"

    save_as_new = parse_client_message({
        "type": "workflow_confirm",
        "session_id": "s1",
        "request_id": "req-2",
        "action": "save_as_new",
        "name": "工作流副本",
    })
    assert isinstance(save_as_new, WsWorkflowConfirmMessage)
    assert save_as_new.action == "save_as_new"
    assert save_as_new.name == "工作流副本"

    with pytest.raises(WsMessageError):
        parse_client_message({
            "type": "workflow_confirm",
            "session_id": "s1",
            "request_id": "req-1",
            "action": "confirm",
            "name": "工作流",
            "workflow_id": "wf_legacy",
        })

    with pytest.raises(WsMessageError):
        parse_client_message({
            "type": "chat",
            "session_id": "s1",
            "input": "",
            "blocks": [{
                "type": "workflow_confirm",
                "request_id": "req-1",
                "action": "confirm",
            }],
        })


def test_build_confirm_is_a_ws_message_not_chat_block() -> None:
    msg = parse_client_message({
        "type": "build_confirm",
        "session_id": "s1",
        "request_id": "build-1",
        "action": "confirm",
    })
    assert isinstance(msg, WsBuildConfirmMessage)

    with pytest.raises(WsMessageError):
        parse_client_message({
            "type": "chat",
            "session_id": "s1",
            "input": "",
            "blocks": [{
                "type": "build_confirm",
                "request_id": "build-1",
                "action": "confirm",
            }],
        })


def test_task_confirm_is_a_ws_message_not_chat_block() -> None:
    msg = parse_client_message({
        "type": "task_confirm",
        "session_id": "s1",
        "request_id": "task-1",
        "action": "revise",
        "feedback": "补充失败分支",
    })
    assert isinstance(msg, WsTaskConfirmMessage)

    with pytest.raises(WsMessageError):
        parse_client_message({
            "type": "chat",
            "session_id": "s1",
            "input": "",
            "blocks": [{
                "type": "task_confirm",
                "request_id": "task-1",
                "action": "confirm",
            }],
        })


def test_accept_rule_is_a_structured_ws_message() -> None:
    msg = parse_client_message({
        "type": "accept_rule",
        "session_id": "s1",
        "request_id": "accept-1",
        "decisions": ["accept", "reject"],
        "feedback": ["", "结果需要附带来源链接"],
        "supplement": "结果必须使用中文",
    })

    assert isinstance(msg, WsAcceptRuleMessage)
    assert msg.mode == "criteria"
    assert msg.decisions == ["accept", "reject"]
    assert msg.feedback == ["", "结果需要附带来源链接"]

    with pytest.raises(WsMessageError):
        parse_client_message({
            "type": "accept_rule",
            "session_id": "s1",
            "request_id": "accept-1",
            "decisions": ["accept", "reject"],
            "feedback": ["数量不匹配"],
        })


def test_accept_rule_supports_explicit_execution_only_mode() -> None:
    msg = parse_client_message({
        "type": "accept_rule",
        "session_id": "s1",
        "request_id": "accept-1",
        "mode": "execution_only",
        "decisions": [],
        "supplement": "",
    })

    assert isinstance(msg, WsAcceptRuleMessage)
    assert msg.mode == "execution_only"

    with pytest.raises(WsMessageError):
        parse_client_message({
            "type": "accept_rule",
            "session_id": "s1",
            "request_id": "accept-1",
            "mode": "execution_only",
            "decisions": ["reject"],
            "supplement": "",
        })


def test_mention_resolution_and_fail_closed(tmp_path) -> None:
    """Resolution + fail-closed in one place. Degrade to ``@label`` (never a
    broken path) for: a stale mount id, an unresolved id, a stale id carrying a
    sub-path. Mount-relative sub-paths join onto the mount root, an empty sub-path
    keeps the root, and existence is NOT checked. But ``..`` traversal, absolute
    sub-paths, and symlinks escaping the mount must NOT inline."""
    assert _render(
        [WsTextBlock(value="看 "), WsMentionBlock(id="stale", label="gone.txt", group="g")], {},
    ) == "看 @gone.txt"
    assert _render([WsMentionBlock(id="m", label="a.py", group="g")], {}) == "@a.py"
    assert _render(
        [WsMentionBlock(id="stale", label="a.txt", group="g", path="a.txt")], {},
    ) == "@a.txt"

    # --- Sub-paths join onto the mount root (existence not checked).
    mount = tmp_path / "fapiao"
    (mount / "高德打车发票").mkdir(parents=True)
    (mount / "高德打车发票" / "行程单.pdf").write_text("x")
    joined = _render(
        [WsMentionBlock(id="m", label="行程单.pdf", group="g", path="高德打车发票/行程单.pdf")],
        {"m": str(mount)},
    )
    assert joined == f"行程单.pdf({mount / '高德打车发票' / '行程单.pdf'})"

    assert _render(
        [WsMentionBlock(id="m", label="proj/", group="g", path="")], {"m": "/abs/proj"},
    ) == "proj/(/abs/proj)"
    assert _render(
        [WsMentionBlock(id="m", label="gone.txt", group="g", path="gone.txt")], {"m": str(tmp_path)},
    ) == f"gone.txt({tmp_path / 'gone.txt'})"

    # --- Escaping sub-paths fail closed (traversal / absolute / symlink).
    assert _render(
        [WsMentionBlock(id="m", label="evil", group="g", path="../outside.txt")], {"m": str(tmp_path)},
    ) == "@evil"
    assert _render(
        [WsMentionBlock(id="m", label="evil", group="g", path="/etc/passwd")], {"m": str(tmp_path)},
    ) == "@evil"

    link_mount = tmp_path / "mount"
    outside = tmp_path / "outside"
    link_mount.mkdir()
    outside.mkdir()
    (outside / "secret.txt").write_text("x")
    (link_mount / "link").symlink_to(outside)
    assert _render(
        [WsMentionBlock(id="m", label="secret", group="g", path="link/secret.txt")], {"m": str(link_mount)},
    ) == "@secret"
