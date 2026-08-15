"""``session_to_agent_messages`` — Session Turns to frontend transcript."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from bridgic.core.model.types import Role

from src.amphi_agent._cognitive import MainThink, SESSION_MESSAGE_RECORD_LIMIT
from src.amphi_agent._context import AmphiContext, AmphiOTAContext
from src.amphi_agent._session import Session
from src.amphi_agent._workflow_run import RunWorkflow
from src.amphi_agent._workspace import Workspace
from src.amphi_service.handler._session_handler import (
    SessionMessagesHandler,
    _pending_request,
    _thinking_mode,
    session_to_agent_messages,
)
from src.amphi_service.i18n import use_locale
from src.amphi_service.protocol import StageEvent, TitleEvent
from src.amphi_store import (
    SessionRecord,
    SessionTurnRecord,
    TurnStatus,
    UserInput,
)

from ._session_turns import make_session_turns


def _ota(answer: str = "", steps: Optional[List[dict]] = None) -> Dict[str, Any]:
    """An OTA dump: an optional tool round, then the finishing decision."""
    rounds: List[dict] = []
    if steps is not None:
        rounds.append({
            "think_result": {"step_content": "", "tool_calls": [{"tool": "x"}]},
            "action_result": {"results": steps},
        })
    rounds.append({"think_result": {"step_content": answer, "tool_calls": []}})
    return {"ota_record": rounds}


def _messages(pairs: List[Tuple[UserInput, Dict[str, Any]]]) -> List[dict]:
    return session_to_agent_messages("s1", make_session_turns(pairs))


def _session_of(turns: List[SessionTurnRecord]) -> Session:
    record = SessionRecord(id="t", user_id="u", workspace_root="/tmp")
    return Session(record, turns=turns)


def _native_ota_context() -> AmphiOTAContext:
    return AmphiOTAContext(user_input="x")


def test_transcript_basics_and_tool_calls() -> None:
    """The transcript mapper, basics through multi-round replay, in one pass.

    Empty history → no messages; one pair → user then assistant (with blocks +
    monotonic createdAt); structured input blocks pass through to the user card
    (text uses ``text``, no path leak). Tool rounds render as toolCalls + blocks
    (tools before the answer text); a failed tool surfaces its error as the
    call's output. EVERY round's streamed think text replays, interleaved with
    its round's tool cards — not just the final answer (a build turn chains many
    units whose stage prose lives in intermediate rounds). A normalized resumed
    Turn keeps its human response inside the one assistant reply."""
    assert _messages([]) == []

    msgs = _messages([(UserInput(text="hello"), _ota("hi there"))])
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert msgs[0]["text"] == "hello"
    assert msgs[0]["toolCalls"] == []
    assert msgs[0]["blocks"] == []  # no structured input → GUI falls back to text
    assert msgs[1]["text"] == "hi there"
    assert msgs[1]["blocks"] == [{"type": "text", "text": "hi there"}]
    assert msgs[1]["done"] is True
    assert [m["createdAt"] for m in msgs] == [0, 1]

    configured_turn = make_session_turns([(UserInput(text="configured"), _ota("done"))])[0]
    configured_turn.model = "gpt-5.6"
    configured_turn.execution_mode = "request"
    configured_assistant = session_to_agent_messages("s1", [configured_turn])[-1]
    assert configured_assistant["turnId"] == configured_turn.id
    assert configured_assistant["model"] == "gpt-5.6"
    assert configured_assistant["executionMode"] == "request"

    structured = UserInput(
        text="先读 @config.json",
        blocks=[
            {"type": "text", "value": "先读 "},
            {"type": "mention", "id": "mnt_c", "label": "config.json", "group": "文件/文件夹"},
        ],
    )
    user = _messages([(structured, _ota("ok"))])[0]
    assert user["text"] == "先读 @config.json"  # clean flattened text, no path leak
    assert user["blocks"] == [
        {"type": "text", "text": "先读 "},
        {"type": "mention", "id": "mnt_c", "label": "config.json", "group": "文件/文件夹"},
    ]

    # --- Tool round: success renders a tool card before the answer text.
    msgs = _messages([(
            UserInput(text="run ls"),
            _ota("done", steps=[{
                "tool_name": "bash",
                "tool_arguments": {"command": "ls"},
                "tool_result": "a\nb",
                "success": True,
            }]),
        )])
    assistant = msgs[1]
    assert len(assistant["toolCalls"]) == 1
    call = assistant["toolCalls"][0]
    assert call["name"] == "bash"
    assert call["input"] == {"command": "ls"}
    assert call["result"] == {"output": "a\nb", "isError": False, "durationMs": 0}
    assert assistant["blocks"][0]["type"] == "tool"
    assert assistant["blocks"][-1] == {"type": "text", "text": "done"}

    # --- A failed tool surfaces its error as the call's output.
    failed = _messages([(
            UserInput(text="x"),
            _ota("", steps=[{
                "tool_name": "bash",
                "tool_arguments": {},
                "tool_result": "",
                "success": False,
                "error": "boom",
            }]),
        )])
    result = failed[1]["toolCalls"][0]["result"]
    assert result["isError"] is True
    assert result["output"] == "boom"
    assert failed[1]["text"] == ""

    # --- switch is internal control-flow: among real tools, it's filtered out and
    #     never becomes a card; only real tools (bash) survive as toolCalls/blocks.
    switch_ota = {"ota_record": [{
        "think_result": {"step_content": "go", "tool_calls": []},
        "action_result": {"results": [
            {"tool_name": "switch", "tool_arguments": {"stage": "explore"},
             "tool_result": "ok", "success": True},
            {"tool_name": "bash", "tool_arguments": {"command": "ls"},
             "tool_result": "a", "success": True},
        ]},
    }]}
    assistant = _messages([(UserInput(text="go"), switch_ota)])[1]
    assert [c["name"] for c in assistant["toolCalls"]] == ["bash"]
    assert [b["name"] for b in assistant["blocks"] if b["type"] == "tool"] == ["bash"]

    # --- EVERY round's streamed think text replays, interleaved with its round's
    #     tool cards — not just the final answer (a build turn chains many units
    #     whose stage prose lives in intermediate rounds; the old mapper rendered
    #     [all tools][final answer] and lost everything else).
    multi_ota = {"ota_record": [
        {
            "think_result": {"step_content": "clarify summary", "tool_calls": [{"tool": "write_file"}]},
            "action_result": {"results": [{
                "tool_name": "write_file", "tool_arguments": {"path": "task.md"},
                "tool_result": "ok", "success": True,
            }]},
        },
        {"think_result": {"step_content": "explore findings", "tool_calls": []}},
        {"think_result": {"step_content": "final verdict", "tool_calls": []}},
    ]}
    assistant = _messages([(UserInput(text="/build x"), multi_ota)])[1]
    texts = [b["text"] for b in assistant["blocks"] if b["type"] == "text"]
    assert texts == ["clarify summary", "explore findings", "final verdict"]
    assert assistant["blocks"][0] == {"type": "text", "text": "clarify summary"}
    assert assistant["blocks"][1]["type"] == "tool"  # a round's text streams BEFORE its tools
    for prose in ("clarify summary", "explore findings", "final verdict"):
        assert prose in assistant["text"]  # bubble text carries everything, not just the tail

    # --- Legacy two-Turn history keeps the answer as the next user input.
    ask_ota = {"ota_record": [
        {
            "think_result": {"step_content": "let me confirm one thing", "tool_calls": [{"tool": "request_human_choice"}]},
            "action_result": {"results": [{
                "tool_name": "request_human_choice",
                "tool_arguments": {"prompt": '{"questions": [{"question": "Q?", "options": [{"label": "A"}]}]}'},
                "tool_result": [{"question": "Q?"}],
                "success": True,
            }]},
        },
    ]}
    answer_ota = {"ota_record": [{"think_result": {"step_content": "done", "tool_calls": []}}]}
    msgs = _messages([(UserInput(text="go"), ask_ota), (UserInput(text="A"), answer_ota)])
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant"]
    assert msgs[1]["text"] == "let me confirm one thing\n\nQ?"
    assert "kind" not in msgs[2] and msgs[2]["text"] == "A"
    assert msgs[3]["text"] == "done"

    # A normalized resumed Root keeps one SessionTurn; the answer is recovered
    # from request_human_choice's tool result.
    resumed_ota = {
        "final_answer": "done",
        "state": {"interaction": None},
        "ota_record": [
            {
                **ask_ota["ota_record"][0],
                "action_result": {"results": [{
                    **ask_ota["ota_record"][0]["action_result"]["results"][0],
                    "tool_result": "A",
                }]},
            },
            {"think_result": {"step_content": "done", "tool_calls": []}},
        ],
    }
    msgs = _messages([(UserInput(text="go"), resumed_ota)])
    assert [message["role"] for message in msgs] == ["user", "assistant"]
    assert [message["text"] for message in msgs] == [
        "go",
        "let me confirm one thing\n\ndone",
    ]
    assistant = msgs[-1]
    assert assistant["finalAnswer"] == "done"
    assert {"type": "confirmation", "question": "Q?", "response": "A"} in assistant["blocks"]

    multi_question_ota = {
        "ota_record": [{
            "think_result": {"step_content": "请确认偏好", "tool_calls": [{"tool": "request_human_choice"}]},
            "action_result": {"results": [{
                "tool_name": "request_human_choice",
                "tool_arguments": {
                    "questions": json.dumps({"questions": [
                    {"question": "回复风格？", "options": [{"label": "简洁"}]},
                    {"question": "回答重点？", "options": [{"label": "结论优先"}]},
                    ]}, ensure_ascii=False),
                    "prompt": "**背景**：请统一后续回答的呈现方式。",
                },
                "tool_result": "回复风格？: 简洁\n回答重点？: 结论优先",
                "success": True,
            }]},
        }],
    }
    replayed = _messages([(UserInput(text="请再确认一次"), multi_question_ota)])[-1]
    assert {
        "type": "confirmation",
        "prompt": "**背景**：请统一后续回答的呈现方式。",
        "question": "回复风格？\n\n回答重点？",
        "response": "回复风格？: 简洁\n回答重点？: 结论优先",
    } in replayed["blocks"]

    cancelled_turn = make_session_turns([(UserInput(text="go"), resumed_ota)])[0]
    cancelled_turn.status = TurnStatus.CANCELLED
    cancelled_turn.error = "Agent execution cancelled"
    cancelled = session_to_agent_messages("s1", [cancelled_turn])
    assert [message["role"] for message in cancelled] == ["user", "assistant"]
    assert cancelled[-1]["stopped"] is True
    assert "error" not in cancelled[-1]

    empty_cancelled = make_session_turns([(
        UserInput(text="stop here"),
        {
            "state": {"think": {"mode": "build", "stage": "clarify"}},
            "ota_record": [],
        },
    )])[0]
    empty_cancelled.status = TurnStatus.CANCELLED
    empty_cancelled.model = "claude-sonnet"
    empty_cancelled.execution_mode = "full"
    empty = session_to_agent_messages("s1", [empty_cancelled])
    assert [message["role"] for message in empty] == ["user", "assistant"]
    assert empty[-1]["stopped"] is True
    assert empty[-1]["blocks"] == []
    assert empty[-1]["model"] == "claude-sonnet"
    assert empty[-1]["executionMode"] == "full"


def test_build_stage_boundaries_rehydrate_in_round_order() -> None:
    ota = {
        "ota_record": [
            {
                "build_stage": "clarify",
                "think_result": {"step_content": "clarify one", "tool_calls": []},
            },
            {
                "build_stage": "clarify",
                "think_result": {"step_content": "clarify two", "tool_calls": []},
            },
            {
                "build_stage": "explore",
                "think_result": {"step_content": "explore findings", "tool_calls": []},
            },
            {
                "build_stage": "generate",
                "think_result": {"step_content": "generated package", "tool_calls": []},
            },
            {
                "build_stage": None,
                "think_result": {"step_content": "back in Main", "tool_calls": []},
            },
            {
                "build_stage": "clarify",
                "think_result": {"step_content": "new clarify pass", "tool_calls": []},
            },
        ],
    }

    blocks = _messages([(UserInput(text="build it"), ota)])[-1]["blocks"]
    assert [
        block["stage"]
        for block in blocks
        if block["type"] == "build_stage"
    ] == ["clarify", "explore", "generate", None, "clarify"]
    assert [
        block["type"]
        for block in blocks
    ] == [
        "build_stage", "text", "text",
        "build_stage", "text",
        "build_stage", "text",
        "build_stage", "text",
        "build_stage", "text",
    ]

    legacy = _messages([(
        UserInput(text="legacy build"),
        {"ota_record": [{"think_result": {"step_content": "legacy", "tool_calls": []}}]},
    )])[-1]
    assert all(block["type"] != "build_stage" for block in legacy["blocks"])


def test_workflow_confirm_rehydrates_as_message_card() -> None:
    payload = {
        "request_id": "workflow_confirm_test",
        "default_name": "小红书内容爬虫",
        "summary": "验证通过",
        "status": "pending",
    }
    dump = {
        "ota_record": [
            {
                "think_result": {"step_content": "验证通过", "tool_calls": [{"tool": "request_human_workflow_confirm"}]},
                "action_result": {
                    "results": [
                        {
                            "tool_name": "request_human_workflow_confirm",
                            "tool_arguments": {"prompt": json.dumps(payload, ensure_ascii=False)},
                            "tool_result": payload,
                            "success": True,
                        }
                    ]
                },
            }
        ]
    }

    msgs = _messages([(UserInput(text="/build x"), dump)])
    assistant = msgs[1]

    assert assistant["toolCalls"] == []
    assert assistant["text"] == "验证通过"
    assert assistant["blocks"] == [
        {"type": "text", "text": "验证通过"},
        {
            "type": "workflow_confirm",
            "requestId": "workflow_confirm_test",
            "defaultName": "小红书内容爬虫",
            "summary": "验证通过",
            "status": "pending",
        },
    ]


def test_workflow_edit_confirmation_rehydrates_its_target() -> None:
    payload = {
        "request_id": "workflow_edit_test",
        "default_name": "目录报告",
        "summary": "修改验证通过",
        "operation": "edit",
        "workflow_id": "wf_existing",
        "status": "pending",
    }
    dump = {
        "ota_record": [{
            "think_result": {"step_content": "修改完成", "tool_calls": []},
            "action_result": {"results": [{
                "tool_name": "request_human_workflow_confirm",
                "tool_arguments": {},
                "tool_result": payload,
                "success": True,
            }]},
        }],
    }

    block = _messages([(UserInput(text="修改目录报告"), dump)])[1]["blocks"][-1]

    assert block == {
        "type": "workflow_confirm",
        "requestId": "workflow_edit_test",
        "defaultName": "目录报告",
        "summary": "修改验证通过",
        "operation": "edit",
        "status": "pending",
        "workflowId": "wf_existing",
    }


def test_workflow_edit_saved_as_new_rehydrates_as_a_created_workflow() -> None:
    payload = {
        "request_id": "workflow_copy_test",
        "default_name": "目录报告",
        "summary": "修改验证通过",
        "operation": "create",
        "workflow_id": "wf_copy",
        "name": "目录报告副本",
        "status": "confirmed",
    }
    dump = {
        "ota_record": [{
            "action_result": {"results": [{
                "tool_name": "request_human_workflow_confirm",
                "tool_arguments": {},
                "tool_result": payload,
                "success": True,
            }]},
        }],
    }

    block = _messages([(UserInput(text="修改目录报告"), dump)])[1]["blocks"][-1]

    assert block == {
        "type": "workflow_confirm",
        "requestId": "workflow_copy_test",
        "defaultName": "目录报告",
        "summary": "修改验证通过",
        "operation": "create",
        "status": "confirmed",
        "workflowId": "wf_copy",
        "name": "目录报告副本",
    }


def test_workflow_step_reports_rehydrate_as_process_blocks() -> None:
    result = {
        "workflow_id": "wf-report",
        "generation": "generation-1",
        "workflow_name": "生成报告",
        "phase": "execute",
        "step_index": 0,
        "step_count": 2,
        "title": "收集数据",
        "status": "success",
        "summary": "数据已收集",
        "evidence": ["input.json"],
    }
    dump = {
        "ota_record": [{
            "think_result": {
                "step_content": "",
                "tool_calls": [{"tool": "report_workflow_step"}],
            },
            "action_result": {
                "results": [{
                    "tool_name": "report_workflow_step",
                    "tool_result": result,
                    "success": True,
                }],
            },
        }],
        "state": {
            "think": {
                "mode": "run_workflow",
                "workflow_id": "wf-report",
                "generation": "generation-1",
                "stage": "execute",
                "step_index": 1,
            },
        },
    }

    turns = make_session_turns([(UserInput(text="/生成报告"), dump)])
    assistant = session_to_agent_messages("s1", turns)[1]

    assert assistant["toolCalls"] == []
    assert assistant["blocks"] == [{
        "type": "workflow_step",
        "workflowId": "wf-report",
        "generation": "generation-1",
        "workflowName": "生成报告",
        "phase": "execute",
        "stepIndex": 0,
        "stepCount": 2,
        "title": "收集数据",
        "status": "success",
        "summary": "数据已收集",
    }]
    assert _thinking_mode(turns) == {"mode": "run_workflow", "stage": "execute"}


def test_workflow_steps_precede_their_multi_round_tools_and_subagents() -> None:
    first_report = {
        "workflow_id": "wf-report",
        "generation": "generation-1",
        "workflow_name": "Generate report",
        "phase": "execute",
        "step_index": 0,
        "step_count": 2,
        "title": "Collect data",
        "status": "success",
        "summary": "Data collected",
    }
    second_report = {
        "workflow_id": "wf-report",
        "generation": "generation-1",
        "workflow_name": "Generate report",
        "phase": "execute",
        "step_index": 1,
        "step_count": 2,
        "title": "Write report",
        "status": "success",
        "summary": "Report written",
        "run_id": "wfr-report",
        "run_status": "completed",
        "validation_status": "not_required",
        "created_at": "2026-08-09T06:00:00+00:00",
    }
    terminal = {
        "run_id": "wfr-report",
        "workflow_id": "wf-report",
        "workflow_name": "Generate report",
        "status": "completed",
        "validation_status": "not_required",
        "created_at": "2026-08-09T06:00:00+00:00",
        "result_file_count": 1,
        "summary": "Workflow completed.",
    }
    dump = {
        "ota_record": [
            {
                "think_result": {
                    "step_content": "Preparing the Workflow run.",
                    "tool_calls": [{"tool": "request_run_workflow"}],
                },
                "action_result": {"results": [{
                    "tool_name": "request_run_workflow",
                    "tool_arguments": {"workflow_id": "wf-report", "action": "start"},
                    "tool_result": {"workflow_id": "wf-report", "status": "started"},
                    "success": True,
                }]},
            },
            {
                "reasoning_content": "Planning data collection.",
                "think_result": {
                    "step_content": "Collecting source files.",
                    "tool_calls": [{"tool": "bash"}],
                },
                "action_result": {"results": [{
                    "tool_id": "call-collect",
                    "tool_name": "bash",
                    "tool_arguments": {"command": "collect"},
                    "tool_result": "collected",
                    "success": True,
                }]},
            },
            {
                "think_result": {
                    "step_content": "Delegating semantic inspection.",
                    "tool_calls": [{"tool": "run_subagent"}],
                },
                "action_result": {"results": [{
                    "tool_id": "call-child",
                    "tool_name": "run_subagent",
                    "tool_arguments": {"goal": "Inspect the collected files"},
                    "tool_result": "Sub-agent completed successfully.",
                    "success": True,
                }]},
            },
            {
                "reasoning_content": "Reporting the collected data.",
                "think_result": {
                    "step_content": "",
                    "tool_calls": [{"tool": "report_workflow_step"}],
                },
                "action_result": {"results": [{
                    "tool_name": "report_workflow_step",
                    "tool_arguments": {},
                    "tool_result": first_report,
                    "success": True,
                }]},
            },
            {
                "reasoning_content": "Planning report output.",
                "think_result": {
                    "step_content": "Writing the final report.",
                    "tool_calls": [{"tool": "python"}],
                },
                "action_result": {"results": [{
                    "tool_id": "call-write",
                    "tool_name": "python",
                    "tool_arguments": {"code": "write_report()"},
                    "tool_result": "written",
                    "success": True,
                }]},
            },
            {
                "reasoning_content": "Reporting the final output.",
                "think_result": {
                    "step_content": "",
                    "tool_calls": [{"tool": "report_workflow_step"}],
                },
                "action_result": {"results": [{
                    "tool_name": "report_workflow_step",
                    "tool_arguments": {},
                    "tool_result": second_report,
                    "success": True,
                }]},
                "workflow_result": terminal,
            },
            {
                "think_result": {"step_content": "Workflow done.", "tool_calls": []},
            },
        ],
        "final_answer": "Workflow done.",
    }
    parent = make_session_turns([(UserInput(text="/generate-report"), dump)])
    child = make_session_turns([(UserInput(text="Inspect the collected files"), {
        "ota_record": [{"think_result": {"step_content": "Inspection complete.", "tool_calls": []}}],
        "final_answer": "Inspection complete.",
    })])[0]

    assistant = session_to_agent_messages(
        "s1",
        parent,
        {"call-child": [("child-1", child, "Inspect the child Session")]},
    )[1]
    blocks = assistant["blocks"]

    assert [(block["type"], block.get("stepIndex")) for block in blocks] == [
        ("text", None),
        ("workflow_step", 0),
        ("thinking", None),
        ("text", None),
        ("tool", None),
        ("text", None),
        ("subagent", None),
        ("thinking", None),
        ("workflow_step", 1),
        ("thinking", None),
        ("text", None),
        ("tool", None),
        ("thinking", None),
        ("workflow_result", None),
        ("text", None),
    ]
    assert blocks[0]["text"] == "Preparing the Workflow run."
    assert blocks[1]["title"] == "Collect data"
    assert blocks[6]["goal"] == "Inspect the collected files"
    assert blocks[8]["title"] == "Write report"
    assert blocks[13]["runId"] == "wfr-report"
    assert blocks[14]["text"] == "Workflow done."


def test_legacy_workflow_report_without_entry_marker_still_opens_its_content() -> None:
    result = {
        "workflow_id": "wf-legacy",
        "generation": "generation-legacy",
        "workflow_name": "Legacy Workflow",
        "phase": "execute",
        "step_index": 0,
        "step_count": 1,
        "title": "Legacy step",
        "status": "success",
        "summary": "Legacy step completed",
    }
    dump = {
        "ota_record": [
            {
                "reasoning_content": "Legacy reasoning.",
                "think_result": {
                    "step_content": "Legacy process output.",
                    "tool_calls": [{"tool": "bash"}],
                },
                "action_result": {"results": [{
                    "tool_id": "legacy-tool",
                    "tool_name": "bash",
                    "tool_arguments": {"command": "legacy"},
                    "tool_result": "done",
                    "success": True,
                }]},
            },
            {
                "think_result": {
                    "step_content": "",
                    "tool_calls": [{"tool": "report_workflow_step"}],
                },
                "action_result": {"results": [{
                    "tool_name": "report_workflow_step",
                    "tool_result": result,
                    "success": True,
                }]},
            },
        ],
    }

    blocks = _messages([(UserInput(text="legacy run"), dump)])[1]["blocks"]

    assert [block["type"] for block in blocks] == [
        "workflow_step",
        "thinking",
        "text",
        "tool",
    ]
    assert blocks[0]["title"] == "Legacy step"
    assert blocks[1]["text"] == "Legacy reasoning."


def test_terminal_workflow_report_rehydrates_result_card_after_its_step() -> None:
    result = {
        "workflow_id": "wf-report",
        "generation": "generation-1",
        "workflow_name": "生成报告",
        "phase": "validate",
        "step_index": 0,
        "step_count": 1,
        "title": "检查报告",
        "status": "success",
        "summary": "报告完整",
        "run_id": "wfr-report",
        "run_status": "completed",
        "validation_status": "passed",
        "created_at": "2026-08-03T06:00:00+00:00",
    }
    dump = {
        "ota_record": [{
            "think_result": {"step_content": "", "tool_calls": []},
            "action_result": {"results": [{
                "tool_name": "report_workflow_step",
                "tool_result": result,
                "success": True,
            }]},
            "workflow_result": {
                "run_id": "wfr-report",
                "workflow_id": "wf-report",
                "workflow_name": "生成报告",
                "status": "completed",
                "validation_status": "passed",
                "created_at": "2026-08-03T06:00:00+00:00",
                "result_file_count": 1,
                "summary": "Workflow `生成报告` completed all execution and validation sections successfully.",
            },
        }],
    }

    assistant = _messages([(UserInput(text="/生成报告"), dump)])[1]

    assert assistant["blocks"] == [
        {
            "type": "workflow_step",
            "workflowId": "wf-report",
            "generation": "generation-1",
            "workflowName": "生成报告",
            "phase": "validate",
            "stepIndex": 0,
            "stepCount": 1,
            "title": "检查报告",
            "status": "success",
            "summary": "报告完整",
        },
        {
            "type": "workflow_result",
            "runId": "wfr-report",
            "workflowId": "wf-report",
            "workflowName": "生成报告",
            "status": "completed",
            "validationStatus": "passed",
            "createdAt": "2026-08-03T06:00:00+00:00",
            "resultFileCount": 1,
            "summary": "Workflow `生成报告` completed all execution and validation sections successfully.",
        },
    ]


def test_resumed_completion_boundary_rehydrates_its_structured_result() -> None:
    terminal = {
        "run_id": "wfr-resumed",
        "workflow_id": "wf-report",
        "workflow_name": "生成报告",
        "status": "completed",
        "validation_status": "not_required",
        "created_at": "2026-08-03T06:00:00+00:00",
        "summary": "执行阶段已全部完成。",
    }
    dump = {
        "ota_record": [{
            "observation_result": "[workflow] saved",
            "workflow_result": terminal,
        }],
    }

    assistant = _messages([(UserInput(text="继续"), dump)])[1]

    assert assistant["blocks"] == [{
        "type": "workflow_result",
        "runId": "wfr-resumed",
        "workflowId": "wf-report",
        "workflowName": "生成报告",
        "status": "completed",
        "validationStatus": "not_required",
        "createdAt": "2026-08-03T06:00:00+00:00",
        "summary": "执行阶段已全部完成。",
    }]


async def test_active_workflow_run_rehydrates_its_session_header(
    tmp_path: Path,
    connected_repo: None,
) -> None:
    source = tmp_path / "saved-workflow"
    package = source / "workflow"
    package.mkdir(parents=True)
    (package / "WORKFLOW.md").write_text(
        "---\nname: report\ndescription: Generate a report.\n---\n\n"
        "# 收集数据\n\n读取输入。\n\n# 生成报告\n\n写入报告。\n",
        encoding="utf-8",
    )
    (package / "VALIDATE.md").write_text(
        "# 检查报告\n\n确认结果完整。\n",
        encoding="utf-8",
    )
    for name in ("task.md", "explore.md", "verify.md"):
        (source / name).write_text(f"# {name}\n", encoding="utf-8")
    workspace = Workspace("s1", session_root=tmp_path)
    workflow_input = UserInput(text="/生成报告")
    space = await workspace.prepare_run_workflow_space(
        "create",
        initial_state={
            "workflow_id": "wf-report",
            "generation": "generation-1",
            "workflow_name": "生成报告",
            "workflow_input": workflow_input.model_dump(mode="json"),
            "stage": "execute",
            "step_index": 0,
        },
        populate=lambda root: RunWorkflow(root).prepare("create", source_root=source),
    )
    generation = space.generation
    RunWorkflow(space.root).prepare("resume").record_step(
        stage="execute",
        step_number=1,
        step_title="收集数据",
        status="success",
        summary="输入已读取。",
    )
    space.checkpoint_cursor(
        expected_workflow_id=space.workflow_id,
        expected_generation=generation,
        expected_stage="execute",
        expected_step_index=0,
        stage="execute",
        step_index=1,
    )

    record = SessionRecord(id="s1", user_id="user", workspace_root=str(tmp_path))

    assert SessionMessagesHandler._workflow_run_snapshot(record) == {
        "workflow_id": "wf-report",
        "generation": generation,
        "workflow_name": "生成报告",
        "source_session_id": "s1",
        "phase": "execute",
        "step_index": 1,
        "execution_steps": ["收集数据", "生成报告"],
        "validation_steps": ["检查报告"],
    }


def test_build_confirm_rehydrates_as_message_card() -> None:
    payload = {
        "mode": "ask",
        "request_id": "build_confirm_test",
        "goal": "每周生成一次目录报告",
        "reason": "这个任务需要稳定复用。",
        "status": "pending",
    }
    dump = {
        "ota_record": [{
            "think_result": {
                "step_content": "这项任务适合沉淀为工作流。",
                "tool_calls": [{"tool": "request_build"}],
            },
            "action_result": {"results": [{
                "tool_name": "request_build",
                "tool_arguments": {
                    "goal": payload["goal"],
                    "mode": "ask",
                    "reason": payload["reason"],
                },
                "tool_result": payload,
                "success": True,
            }]},
        }],
    }

    assistant = _messages([(UserInput(text="帮我设计每周报告流程"), dump)])[1]

    assert assistant["toolCalls"] == []
    assert assistant["blocks"][-1] == {
        "type": "build_confirm",
        "requestId": "build_confirm_test",
        "goal": payload["goal"],
        "reason": payload["reason"],
        "status": "pending",
    }


def test_direct_build_entry_does_not_rehydrate_as_confirmation_card() -> None:
    dump = {
        "ota_record": [{
            "think_result": {
                "step_content": "用户已明确要求构建工作流。",
                "tool_calls": [{"tool": "request_build"}],
            },
            "action_result": {"results": [{
                "tool_name": "request_build",
                "tool_arguments": {
                    "goal": "每周生成一次目录报告",
                    "mode": "start",
                },
                "tool_result": {
                    "mode": "start",
                    "goal": "每周生成一次目录报告",
                    "message": "The user's explicit Workflow request entered Build.",
                },
                "success": True,
            }]},
        }],
    }

    assistant = _messages([(UserInput(text="帮我构建每周报告工作流"), dump)])[1]

    assert assistant["toolCalls"] == []
    assert assistant["blocks"] == [{"type": "text", "text": "用户已明确要求构建工作流。"}]


def test_rejected_build_entry_does_not_rehydrate_as_confirmation_card() -> None:
    dump = {
        "ota_record": [{
            "think_result": {
                "step_content": "尝试进入工作流构建。",
                "tool_calls": [{"tool": "request_build"}],
            },
            "action_result": {"results": [{
                "tool_name": "request_build",
                "tool_arguments": {"goal": "生成报告", "mode": "start"},
                "tool_result": None,
                "success": False,
                "error": "request_build must run alone",
            }]},
        }],
    }

    assistant = _messages([(UserInput(text="帮我构建报告工作流"), dump)])[1]

    assert assistant["blocks"] == [{"type": "text", "text": "尝试进入工作流构建。"}]


def test_workflow_confirm_rehydrates_resolved_status() -> None:
    payload = {
        "request_id": "workflow_confirm_test",
        "default_name": "小红书内容爬虫",
        "summary": "验证通过",
        "status": "pending",
    }
    dump = {
        "ota_record": [
            {
                "think_result": {"step_content": "验证通过", "tool_calls": [{"tool": "request_human_workflow_confirm"}]},
                "action_result": {
                    "results": [
                        {
                            "tool_name": "request_human_workflow_confirm",
                            "tool_arguments": {"prompt": json.dumps(payload, ensure_ascii=False)},
                            "tool_result": "User confirmed the workflow.",
                            "success": True,
                        }
                    ]
                },
            }
        ]
    }

    assistant = _messages([(UserInput(text="/build x"), dump)])[1]

    assert assistant["blocks"][-1] == {
        "type": "workflow_confirm",
        "requestId": "workflow_confirm_test",
        "defaultName": "小红书内容爬虫",
        "summary": "验证通过",
        "status": "confirmed",
    }


def test_task_confirm_rehydrates_as_message_card() -> None:
    payload = {
        "request_id": "task_confirm_test",
        "task_markdown": "## Task\n\nReview this\n\n```mermaid\nflowchart TD\nA --> B\n```",
        "previous_task_markdown": "## Task\n\nEarlier draft",
        "status": "pending",
    }
    dump = {
        "ota_record": [{
            "think_result": {
                "step_content": "任务说明已完成",
                "tool_calls": [{"tool": "request_human_task_confirm"}],
            },
            "action_result": {"results": [{
                "tool_name": "request_human_task_confirm",
                "tool_arguments": {},
                "tool_result": payload,
                "success": True,
            }]},
        }],
    }

    assistant = _messages([(UserInput(text="/build x"), dump)])[1]

    assert assistant["toolCalls"] == []
    assert assistant["blocks"][-1] == {
        "type": "task_confirm",
        "requestId": "task_confirm_test",
        "taskMarkdown": payload["task_markdown"],
        "previousTaskMarkdown": payload["previous_task_markdown"],
        "status": "pending",
        "feedback": None,
    }


def test_accept_rule_rehydrates_as_one_row_per_confirmed_rule() -> None:
    dump = {
        "ota_record": [{
            "think_result": {
                "step_content": "请逐条确认验收规则",
                "tool_calls": [{"tool": "request_accept_rule"}],
            },
            "action_result": {"results": [{
                "tool_name": "request_accept_rule",
                "tool_arguments": {},
                "tool_result": {
                    "status": "confirmed",
                    "rules": [
                        {"id": "AC-001", "text": "报告存在"},
                        {"id": "AC-002", "text": "报告使用中文"},
                    ],
                },
                "success": True,
            }]},
        }],
    }

    assistant = _messages([(UserInput(text="/build x"), dump)])[1]

    assert assistant["blocks"][-1] == {
        "type": "confirmation",
        "kind": "accept_rule",
        "question": "完成标准已对齐",
        "response": "AC-001: 报告存在\nAC-002: 报告使用中文",
        "acceptanceMode": "criteria",
        "rules": [
            {"id": "AC-001", "text": "报告存在"},
            {"id": "AC-002", "text": "报告使用中文"},
        ],
    }


def test_accept_rule_rehydrates_execution_only_choice() -> None:
    dump = {
        "ota_record": [{
            "action_result": {"results": [{
                "tool_name": "request_accept_rule",
                "tool_arguments": {},
                "tool_result": {
                    "status": "confirmed",
                    "mode": "execution_only",
                    "rules": [],
                },
                "success": True,
            }]},
        }],
    }

    assistant = _messages([(UserInput(text="/build x"), dump)])[1]

    assert assistant["blocks"][-1] == {
        "type": "confirmation",
        "kind": "accept_rule",
        "question": "已选择不设置完成标准",
        "response": "该工作流未设置完成标准，运行时只执行步骤，无需结果校验；执行报错仍会正常失败。",
        "acceptanceMode": "execution_only",
        "rules": [],
    }


def test_accept_rule_execution_only_rehydrates_in_the_active_locale() -> None:
    dump = {
        "ota_record": [{
            "action_result": {"results": [{
                "tool_name": "request_accept_rule",
                "tool_arguments": {},
                "tool_result": {
                    "status": "confirmed",
                    "mode": "execution_only",
                    "rules": [],
                },
                "success": True,
            }]},
        }],
    }

    with use_locale("en"):
        assistant = _messages([(UserInput(text="/build x"), dump)])[1]

    assert assistant["blocks"][-1]["question"] == "No completion criteria selected"
    assert assistant["blocks"][-1]["response"] == (
        "This Workflow has no completion criteria. It will run the steps without "
        "validating the result; execution errors will still fail normally."
    )


def test_legacy_task_confirm_infers_edit_target_from_build_state() -> None:
    dump = {
        "state": {
            "think": {
                "mode": "build",
                "stage": "clarify",
                "workflow_id": "wf_existing",
            },
        },
        "ota_record": [{
            "think_result": {"step_content": "修改完成", "tool_calls": []},
            "action_result": {"results": [{
                "tool_name": "request_human_task_confirm",
                "tool_arguments": {},
                "tool_result": {
                    "request_id": "legacy_edit_task",
                    "task_markdown": "# Task\n新内容",
                    "status": "pending",
                },
                "success": True,
            }]},
        }],
    }

    block = _messages([(UserInput(text="修改工作流"), dump)])[1]["blocks"][-1]

    assert block["operation"] == "edit"
    assert block["workflowId"] == "wf_existing"


def test_handled_interaction_projection_hides_only_pending_cards() -> None:
    pending_dump = {
        "ota_record": [{
            "think_result": {"step_content": "等待确认", "tool_calls": []},
            "action_result": {"results": [
                {
                    "tool_name": "request_build",
                    "tool_result": {
                        "mode": "ask",
                        "request_id": "build-pending",
                        "goal": "生成报告",
                        "status": "pending",
                    },
                    "success": True,
                },
                {
                    "tool_name": "request_human_task_confirm",
                    "tool_result": {
                        "request_id": "task-pending",
                        "task_markdown": "# Task",
                        "status": "pending",
                    },
                    "success": True,
                },
                {
                    "tool_name": "request_human_workflow_confirm",
                    "tool_result": {
                        "request_id": "workflow-pending",
                        "default_name": "报告工作流",
                        "status": "pending",
                    },
                    "success": True,
                },
            ]},
        }],
        "state": {"interaction": {
            "request_id": "permission-pending",
            "permission": {
                "items": [{"call_index": 0, "tool": "bash"}],
                "questions": [{"question": "允许执行？", "options": [{"label": "允许"}]}],
            },
        }},
    }
    turn = make_session_turns([(UserInput(text="开始"), pending_dump)])

    visible = session_to_agent_messages("s1", turn)[-1]["blocks"]
    assert {block["type"] for block in visible} >= {
        "build_confirm", "task_confirm", "workflow_confirm", "permission",
    }

    handled = session_to_agent_messages(
        "s1", turn, show_pending_interaction=False,
    )[-1]["blocks"]
    assert not {
        "build_confirm", "task_confirm", "workflow_confirm", "permission",
    } & {block["type"] for block in handled}

    resolved_dump = {
        "ota_record": [{
            "think_result": {"step_content": "确认完成", "tool_calls": []},
            "action_result": {"results": [
                {
                    "tool_name": "request_human_task_confirm",
                    "tool_result": {
                        "request_id": "task-confirmed",
                        "task_markdown": "# Task",
                        "status": "confirmed",
                    },
                    "success": True,
                },
                {
                    "tool_name": "request_human_workflow_confirm",
                    "tool_result": {
                        "request_id": "workflow-confirmed",
                        "default_name": "报告工作流",
                        "status": "confirmed",
                    },
                    "success": True,
                },
            ]},
        }],
    }
    resolved_turn = make_session_turns([(UserInput(text="开始"), resolved_dump)])
    resolved = session_to_agent_messages(
        "s1", resolved_turn, show_pending_interaction=False,
    )[-1]["blocks"]
    assert [
        block["status"]
        for block in resolved
        if block["type"] in {"task_confirm", "workflow_confirm"}
    ] == ["confirmed", "confirmed"]


def test_normalized_build_turn_projects_one_agent_reply() -> None:
    """A resumed Build keeps every interaction inside one Agent reply."""
    dump = {
        "final_answer": "已完成并保存工作流：desktop-paper-contents-report",
        "state": {"interaction": None},
        "ota_record": [
            {
                "think_result": {"step_content": "先确认统计范围", "tool_calls": []},
                "action_result": {"results": [{
                    "tool_name": "request_human_choice",
                    "tool_arguments": {"prompt": "只统计哪一层?"},
                    "tool_result": "只统计第一层",
                    "success": True,
                }]},
            },
            {
                "think_result": {"step_content": "任务说明书已完成", "tool_calls": []},
                "action_result": {"results": [{
                    "tool_name": "request_human_task_confirm",
                    "tool_arguments": {},
                    "tool_result": {
                        "request_id": "task-1",
                        "task_markdown": "# Task",
                        "status": "confirmed",
                    },
                    "success": True,
                }]},
            },
            {
                "think_result": {"step_content": "验证完成", "tool_calls": []},
                "action_result": {"results": [{
                    "tool_name": "request_human_workflow_confirm",
                    "tool_arguments": {},
                    "tool_result": {
                        "request_id": "workflow-1",
                        "default_name": "desktop-paper-contents-report",
                        "status": "confirmed",
                    },
                    "success": True,
                }]},
            },
            {
                "think_result": {
                    "step_content": "已完成并保存工作流：desktop-paper-contents-report",
                    "tool_calls": [],
                },
            },
        ],
    }

    messages = _messages([(UserInput(text="/build 统计 paper 文件夹"), dump)])
    assert [message["role"] for message in messages] == ["user", "assistant"]
    assistant = messages[-1]
    assert assistant["finalAnswer"] == dump["final_answer"]
    assert [
        block["type"]
        for block in assistant["blocks"]
        if block["type"] in {"confirmation", "task_confirm", "workflow_confirm"}
    ] == ["confirmation", "task_confirm", "workflow_confirm"]


def test_confirmation_card_chat_replies_rehydrate_as_whole_card_responses() -> None:
    conflict_question = (
        "我发现当前请求与未完成的构建可能存在冲突："
        "新请求像是另一个任务。\n\n你希望如何处理？"
    )
    run_question = (
        "当前会话还有未完成的工作流运行（当前保存版本已经修改）。"
        "你希望继续原运行，还是丢弃它并从头运行工作流“目录统计”？"
    )
    steps = [
        {
            "tool_name": "request_build",
            "tool_arguments": {},
            "tool_result": {
                "mode": "ask",
                "request_id": "build-1",
                "goal": "构建目录统计工作流",
                "status": "not_answered",
                "user_message": "先调整构建目标",
            },
            "success": True,
        },
        {
            "tool_name": "request_human_task_confirm",
            "tool_arguments": {},
            "tool_result": {
                "request_id": "task-1",
                "task_markdown": "# Task",
                "status": "not_answered",
                "user_message": "补充失败重试要求",
            },
            "success": True,
        },
        {
            "tool_name": "request_human_workflow_confirm",
            "tool_arguments": {},
            "tool_result": {
                "request_id": "workflow-1",
                "default_name": "目录统计",
                "status": "not_answered",
                "user_message": "保存前再改一下名称策略",
            },
            "success": True,
        },
        {
            "tool_name": "request_build",
            "tool_arguments": {
                "goal": "构建另一个任务",
                "mode": "ask",
                "reason": "新请求像是另一个任务。",
            },
            "tool_result": {
                "build_conflict": True,
                "request_id": "build-conflict-resolved",
                "existing_stage": "generate",
                "reason": "新请求像是另一个任务。",
                "questions": [{"question": conflict_question, "options": []}],
                "status": "resolved",
                "action": "keep",
                "response": "保留并继续",
            },
            "success": True,
        },
        {
            "tool_name": "request_build",
            "tool_arguments": {
                "goal": "构建另一个任务",
                "mode": "ask",
                "reason": "新请求像是另一个任务。",
            },
            "tool_result": {
                "build_conflict": True,
                "request_id": "build-conflict-message",
                "existing_stage": "generate",
                "reason": "新请求像是另一个任务。",
                "questions": [{"question": conflict_question, "options": []}],
                "status": "not_answered",
                "action": "not_answered",
                "response": "继续构建上面的工作流",
                "user_message": "继续构建上面的工作流",
            },
            "success": True,
        },
        {
            "tool_name": "request_run_workflow",
            "tool_arguments": {
                "workflow_id": "wf-directory",
                "action": "ask",
                "reason": "无法判断是否采用修改后的版本。",
            },
            "tool_result": {
                "workflow_run_choice": True,
                "request_id": "workflow-run-choice",
                "existing_workflow_id": "wf-directory",
                "requested_workflow_id": "wf-directory",
                "questions": [{"question": run_question, "options": []}],
                "status": "resolved",
                "action": "restart",
                "response": "丢弃并重新运行",
            },
            "success": True,
        },
    ]

    assistant = _messages([(UserInput(text="/build 目录统计"), _ota("", steps=steps))])[1]

    replies = [block for block in assistant["blocks"] if block["type"] == "confirmation"]
    assert replies == [
        {
            "type": "confirmation",
            "kind": "confirmation_message",
            "question": "工作流构建确认",
            "response": "先调整构建目标",
        },
        {
            "type": "confirmation",
            "kind": "confirmation_message",
            "question": "任务说明书确认",
            "response": "补充失败重试要求",
        },
        {
            "type": "confirmation",
            "kind": "confirmation_message",
            "question": "工作流保存确认",
            "response": "保存前再改一下名称策略",
        },
        {
            "type": "confirmation",
            "question": conflict_question,
            "response": "保留并继续",
        },
        {
            "type": "confirmation",
            "kind": "confirmation_message",
            "question": conflict_question,
            "response": "继续构建上面的工作流",
        },
        {
            "type": "confirmation",
            "kind": "workflow_run_choice",
            "question": run_question,
            "response": "丢弃并重新运行",
        },
    ]


def test_reasoning_and_tool_duration_replay() -> None:
    """A round's reasoning replays as a thinking block BEFORE that round's text /
    tools (reasoning_content string, or Anthropic thinking_blocks joined), and a
    round's persisted ``act_duration_ms`` replays as each tool's ``durationMs``.
    Live carries both; replay used to drop reasoning and zero the duration."""
    ota = {"ota_record": [
        {
            "reasoning_content": "先想清楚再动手",
            "act_duration_ms": 1234,
            "think_result": {"step_content": "开始", "tool_calls": [{"tool": "bash"}]},
            "action_result": {"results": [{
                "tool_name": "bash", "tool_arguments": {"command": "ls"},
                "tool_result": "a", "success": True,
            }]},
        },
        {
            "thinking_blocks": [{"thinking": "Anthropic ", "signature": "s"}, {"thinking": "思考"}],
            "think_result": {"step_content": "答案", "tool_calls": []},
        },
    ]}
    assistant = _messages([(UserInput(text="go"), ota)])[1]
    blocks = assistant["blocks"]

    # Round 1: reasoning thinking block BEFORE the round's text, before its tool.
    assert blocks[0] == {"type": "thinking", "text": "先想清楚再动手"}
    assert blocks[1] == {"type": "text", "text": "开始"}
    assert blocks[2]["type"] == "tool"
    assert blocks[2]["result"]["durationMs"] == 1234  # B2: round act duration on the card
    # Round 2: Anthropic thinking_blocks join into one thinking block.
    assert {"type": "thinking", "text": "Anthropic 思考"} in blocks
    # Thinking is NOT folded into the bubble's plain text (text = step prose only).
    assert "先想清楚" not in assistant["text"]


def test_pending_request_rehydrates_a_parked_permission() -> None:
    """A parked permission gate (``state.interaction = {permission: {...}, request_id}``)
    surfaces as ``{kind: "permission", questions, items, request_id}`` on reload — so a GUI
    restart re-shows the approval card (kind="permission" lets it render the card, not the
    generic request_human_choice banner) and can echo request_id back in permission_answer."""
    perm_questions = [{
        "question": "Approve write_file(file_path=/etc/x)?",
        "options": [{"label": "allow"}, {"label": "deny"}],
    }]
    perm_items = [{
        "call_index": 0,
        "tool": "write_file", "arguments": {"file_path": "/etc/x"},
        "capability": "edit", "boundary": "out_of_bounds", "label": "编辑工作区外文件",
    }]
    history = make_session_turns([
        (UserInput(text="write it"), {
            "ota_record": [{"think_result": {"step_content": "", "tool_calls": []}}],
            "state": {"interaction": {
                "permission": {
                    "calls": [], "verdicts": ["ask"],
                    "questions": perm_questions, "items": perm_items,
                },
                "request_id": "req-1",
            }},
        }),
    ])
    assert _pending_request(history) == {
        "kind": "permission", "questions": perm_questions, "items": perm_items,
        "request_id": "req-1",
    }
    messages = session_to_agent_messages("s1", history)
    assert [message["role"] for message in messages] == ["user", "assistant"]
    assert messages[-1]["blocks"][-1]["type"] == "permission"


def test_pending_request_rehydrates_a_workflow_run_choice() -> None:
    questions = [{
        "question": "继续原运行，还是使用当前版本重新运行？",
        "options": [
            {"label": "继续原运行"},
            {"label": "丢弃并重新运行"},
        ],
    }]
    history = make_session_turns([(
        UserInput(text="继续运行"),
        {
            "ota_record": [],
            "state": {
                "interaction": {
                    "workflow_run_choice": True,
                    "existing_workflow_id": "wf-report",
                    "requested_workflow_id": "wf-report",
                    "questions": questions,
                    "request_id": "workflow-run-choice-1",
                },
            },
        },
    )])

    assert _pending_request(history) == {
        "kind": "choose",
        "questions": questions,
        "request_id": "workflow-run-choice-1",
    }


_QUESTIONS_JSON = (
    '{"questions": [{"question": "Which file?", "options": [{"label": "a.py"}]}]}'
)


def _rq_round(answer: Optional[str], prompt: str = _QUESTIONS_JSON) -> dict:
    return {
        "think_result": {"step_content": "", "tool_calls": [{"tool": "request_human_choice"}]},
        "action_result": {"results": [{
            "tool_name": "request_human_choice",
            "tool_arguments": {"prompt": prompt},
            "tool_result": answer,
            "success": True,
        }]},
    }


def test_internal_terminal_and_switch_steps_are_hidden_in_replay() -> None:
    """Internal control steps stay hidden in replay like they are in live output."""
    ota = {"ota_record": [
        {
            "think_result": {
                "step_content": "handing off to explore",
                "tool_calls": [{"tool": "switch"}],
            },
            "action_result": {"results": [{
                "tool_name": "switch",
                "tool_arguments": {"stage": "explore"},
                "tool_result": {"mode": None, "stage": "explore"},
                "success": True,
            }]},
        },
        {
            "think_result": {
                "step_content": "",
                "tool_calls": [{"tool": "complete_run_workflow"}],
            },
            "action_result": {"results": [{
                "tool_name": "complete_run_workflow",
                "tool_arguments": {},
                "tool_result": {
                    "run_id": "generation-1",
                    "terminal_status": "completed",
                },
                "success": True,
            }]},
        },
    ]}
    assistant = _messages([(UserInput(text="/build x"), ota)])[1]
    assert assistant["toolCalls"] == []
    assert all(b["type"] != "tool" for b in assistant["blocks"])
    assert "handing off to explore" in assistant["text"]


def test_subagent_rehydrates_as_card_without_becoming_a_root_request() -> None:
    """A parked Child is a dedicated card while its interaction stays isolated."""
    ota = {
        "ota_record": [{
            "think_result": {
                "step_content": "delegating",
                "tool_calls": [{"tool": "run_subagent"}],
            },
            "action_result": {"results": [{
                "tool_id": "call-child",
                "tool_name": "run_subagent",
                "tool_arguments": {"goal": "Inspect the repository"},
                "tool_result": "Sub-agent dispatch accepted and is running.",
                "success": True,
            }]},
        }],
        "state": {
            "interaction": None,
            "subagents": {
                "calls": [{
                    "session_id": "inv-child",
                    "tool_call_id": "call-child",
                    "goal": "Inspect the repository",
                }],
            },
        },
    }
    history = make_session_turns([(UserInput(text="delegate"), ota)])
    assistant = session_to_agent_messages(
        "s1",
        history,
        {"call-child": [("inv-child", None, "Child Session title")]},
    )[1]

    assert assistant["toolCalls"] == []
    assert assistant["blocks"][-1] == {
        "type": "subagent",
        "invocationId": "inv-child",
        "goal": "Inspect the repository",
        "status": "running",
        "answer": None,
    }
    assert assistant["turnStatus"] == "awaiting_subagents"
    assert _pending_request(history) is None


def test_cli_subagents_rehydrate_under_their_bash_call() -> None:
    ota = {
        "ota_record": [{
            "think_result": {"step_content": "batch", "tool_calls": [{"tool": "bash"}]},
            "action_result": {"results": [{
                "tool_id": "call-bash",
                "tool_name": "bash",
                "tool_arguments": {"command": "amphi agent run inspect"},
                "tool_result": "done",
                "success": True,
            }]},
        }],
    }
    parent = make_session_turns([(UserInput(text="batch inspect"), ota)])
    child = make_session_turns([(UserInput(text="inspect file.txt"), {
        "ota_record": [{"think_result": {"step_content": "done", "tool_calls": []}}],
    })])[0]

    assistant = session_to_agent_messages(
        "s1",
        parent,
        {"call-bash": [
            ("child-1", child, "stale completed title"),
            ("child-2", None, "inspect second.txt"),
        ]},
    )[1]

    assert assistant["blocks"][-1]["type"] == "tool"
    assert assistant["blocks"][-1]["toolUseId"] == "call-bash"
    assert assistant["blocks"][-1]["subagents"] == [
        {
            "invocationId": "child-1",
            "goal": "inspect file.txt",
            "status": "completed",
            "answer": None,
        },
        {
            "invocationId": "child-2",
            "goal": "inspect second.txt",
            "status": "running",
            "answer": None,
        },
    ]


_REPR_PROMPT = (
    "{'questions': [{'question': 'Pick one:', "
    "'options': [{'label': 'A'}], 'multiSelect': False}]}"
)


def test_request_human_qa_pending_and_thinking_mode() -> None:
    """Legacy request_human transcript and pending-state compatibility. PAST ask: the
    turn's closing assistant message carries the QUESTION (never a tool card);
    the user's pick is simply the NEXT turn's user message (no human_response
    kind), and that turn's work opens its own assistant bubble; the Python-literal
    repr prompt (single quotes, ``False``) parses too. TRAILING (open) ask:
    renders no transcript card and surfaces as ``pending_request`` (including
    option-less free-text asks; None once a later turn answers). The trailing turn's
    build stage from ``think_status`` surfaces for the build rail — empty history and
    pre-build dumps read as None. Also pins StageEvent's two-layer {mode, stage}
    wire shape, which the stage event and thinking_mode projection both ride."""
    # --- Legacy past ask → question bubble; pick + continuation are the next Turn.
    ask_turn = {"ota_record": [_rq_round(None)]}  # tool_result irrelevant now
    answer_turn = {"ota_record": [
        {
            "think_result": {"step_content": "", "tool_calls": [{"tool": "bash"}]},
            "action_result": {"results": [{
                "tool_name": "bash",
                "tool_arguments": {"command": "ls"},
                "tool_result": "ok",
                "success": True,
            }]},
        },
        {"think_result": {"step_content": "done", "tool_calls": []}},
    ]}
    msgs = _messages([
        (UserInput(text="fix the bug"), ask_turn),
        (UserInput(text="config.py"), answer_turn),
    ])
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant"]
    question, pick, continuation = msgs[1], msgs[2], msgs[3]
    assert question["text"] == "Which file?"
    assert question["toolCalls"] == []  # the ask is never a tool card
    assert "kind" not in pick and pick["text"] == "config.py"  # a normal user message
    assert [c["name"] for c in continuation["toolCalls"]] == ["bash"]
    assert continuation["text"] == "done"
    assert [m["createdAt"] for m in msgs] == [0, 1, 2, 3]

    # repr-prompt parses to the question text.
    msgs = _messages([
        (UserInput(text="go"), {"ota_record": [_rq_round(None, prompt=_REPR_PROMPT)]}),
        (UserInput(text="A"), {"ota_record": [{"think_result": {"step_content": "ok", "tool_calls": []}}]}),
    ])
    assert msgs[1]["text"] == "Pick one:"  # parsed question, not the repr

    # --- Trailing (open) ask → no transcript card, surfaced as pending_request.
    history = make_session_turns([
        (UserInput(text="fix it"), {
            "ota_record": [_rq_round(None)],
            "state": {"interaction": {"questions": [{"question": "Which file?", "options": [{"label": "a.py"}]}]}},
        }),
    ])
    assert [m["role"] for m in session_to_agent_messages("s1", history)] == ["user"]
    assert _pending_request(history) == {
        "kind": "choose",
        "questions": [{"question": "Which file?", "options": [{"label": "a.py"}]}],
    }

    repr_history = make_session_turns([
        (UserInput(text="go"), {
            "ota_record": [_rq_round(None, prompt=_REPR_PROMPT)],
            "state": {"interaction": {"questions": [{"question": "Pick one:", "options": [{"label": "A"}], "multiSelect": False}]}},
        }),
    ])
    assert _pending_request(repr_history) == {
        "kind": "choose",
        "questions": [{"question": "Pick one:", "options": [{"label": "A"}], "multiSelect": False}],
    }

    optionless = make_session_turns([
        (UserInput(text="go"), {
            "ota_record": [_rq_round(None, prompt="需要统计哪些层级?")],
            "state": {"interaction": {"questions": [{"question": "需要统计哪些层级?", "options": []}]}},
        }),
    ])
    assert [message["role"] for message in session_to_agent_messages("s1", optionless)] == ["user"]
    assert _pending_request(optionless) == {
        "kind": "choose",
        "questions": [{"question": "需要统计哪些层级?", "options": []}],
    }

    # A later turn answered it → the tail is no longer an ask → not pending.
    answered = make_session_turns([
        (UserInput(text="fix it"), {"ota_record": [_rq_round(None)]}),
        (UserInput(text="a.py"), {"ota_record": [{"think_result": {"step_content": "ok", "tool_calls": []}}]}),
    ])
    assert _pending_request(answered) is None

    # --- Trailing think position surfaces for the rail as {mode, stage}.
    assert _thinking_mode([]) is None
    parked = make_session_turns([
        (UserInput(text="/build x"), {"ota_record": [], "state": {"think": {"mode": "build", "stage": "generate"}}}),
    ])
    assert _thinking_mode(parked) == {"mode": "build", "stage": "generate"}
    editing = make_session_turns([
        (UserInput(text="edit"), {"ota_record": [], "state": {
            "think": {"mode": "build", "stage": "clarify", "workflow_id": "wf-existing"},
        }}),
    ])
    assert _thinking_mode(editing) == {
        "mode": "build", "stage": "clarify", "workflow_id": "wf-existing",
    }
    normal = make_session_turns([
        (UserInput(text="hi"), {"ota_record": [], "state": {"think": {"mode": "normal", "stage": "main"}}}),
    ])
    assert _thinking_mode(normal) == {"mode": "normal", "stage": "main"}
    legacy = make_session_turns([(UserInput(text="x"), {"ota_record": []})])
    assert _thinking_mode(legacy) is None

    # --- StageEvent's two-layer wire shape: mode (loop) + stage (unit), names
    #     already public (no _think suffix); the build-exit frame carries null stage.
    assert StageEvent(mode="build", stage="explore").payload() == {"mode": "build", "stage": "explore"}
    assert StageEvent(
        mode="build", stage="clarify", workflow_id="wf-existing",
    ).payload() == {
        "mode": "build", "stage": "clarify", "workflow_id": "wf-existing",
    }
    assert StageEvent(mode="normal", stage=None).payload() == {"mode": "normal", "stage": None}
    # TitleEvent's wire shape — name + {"title": ...} payload (no other test owns it).
    assert TitleEvent(title="Recursion?").name == "title"
    assert TitleEvent(title="Recursion?").payload() == {"title": "Recursion?"}


def test_failed_turn_persists_as_an_error_bubble() -> None:
    """A turn the agent failed on (``turn_error``) renders its user input + an
    assistant error bubble in the transcript — the GUI shows the failure (the LLM
    context excludes the turn; see test_build)."""
    err_ota = {"ota_record": [], "turn_error": "RuntimeError: boom"}
    failed_turn = make_session_turns([(UserInput(text="do X"), err_ota)])[0]
    failed_turn.model = "deepseek-chat"
    failed_turn.execution_mode = "auto"
    msgs = session_to_agent_messages("s1", [failed_turn])
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert msgs[0]["text"] == "do X"
    assert msgs[1]["text"] == "" and msgs[1]["error"] == "RuntimeError: boom"
    assert msgs[1]["model"] == "deepseek-chat"
    assert msgs[1]["executionMode"] == "auto"


async def test_session_replay_includes_historical_tool_calls_and_results() -> None:
    """Persisted turns replay user input, the think_result tool calls, action
    results, then the final answer, preserving native assistant/tool pairing."""
    history = make_session_turns([
        (UserInput(text="where am I?", blocks=[]), {"ota_record": [
            {
                "think_result": {
                    "step_content": "I will check the current directory.",
                    "tool_calls": [{
                        "tool": "bash",
                        "tool_arguments": [{"name": "cmd", "value": "pwd"}],
                    }],
                },
                "action_result": {"results": [{
                    "tool_id": "call_pwd",
                    "tool_name": "bash",
                    "tool_arguments": {"cmd": "pwd"},
                    "tool_result": "/tmp/.work",
                    "success": True,
                }]},
            },
            {
                "think_result": {
                    "step_content": "You are in /tmp/.work.",
                    "tool_calls": [],
                },
            },
        ]}),
    ])
    msgs = await MainThink().session_messages_block(
        _native_ota_context(),
        AmphiContext(session=_session_of(history)),
    )

    assert [m.role for m in msgs] == [Role.USER, Role.AI, Role.TOOL, Role.AI]
    assert msgs[0].content == "where am I?"
    assert msgs[1].content == "I will check the current directory."
    assert msgs[2].model_dump()["blocks"][0] == {
        "block_type": "tool_result",
        "id": "call_pwd",
        "content": "/tmp/.work",
    }
    assert msgs[3].content == "You are in /tmp/.work."

    tool_call = msgs[1].model_dump()["blocks"][1]
    assert tool_call == {
        "block_type": "tool_call",
        "id": "call_pwd",
        "name": "bash",
        "arguments": {"cmd": "pwd"},
    }


async def test_session_replay_downgrades_interrupted_tool_round() -> None:
    """A cancelled call without a result must not poison the next Codex request."""
    reasoning_items = [{
        "type": "reasoning",
        "id": "reasoning_1",
        "encrypted_content": "ENC==",
        "summary": [],
    }]
    history = make_session_turns([(
        UserInput(text="open the site", blocks=[]),
        {"ota_record": [{
            "think_result": {
                "step_content": "I will open it.",
                "tool_calls": [{
                    "tool": "browser_open",
                    "tool_arguments": [{"name": "url", "value": "https://example.com"}],
                }],
            },
            "action_result": None,
            "reasoning_items": reasoning_items,
        }]},
    )])
    history[0].status = TurnStatus.CANCELLED
    history[0].error = "Agent execution cancelled"

    messages = await MainThink().session_messages_block(
        _native_ota_context(),
        AmphiContext(session=_session_of(history)),
    )

    assert [message.role for message in messages] == [Role.USER, Role.AI]
    assert messages[1].content == "I will open it."
    assert messages[1].extras == {}
    assert not any(
        type(block).__name__ == "ToolCallBlock"
        for message in messages
        for block in message.blocks
    )

    from src.amphi_service.protocol.llms.codex_llm import CodexResponsesLlm

    _, items = CodexResponsesLlm(access_token="t", account_id="a")._convert_messages(messages)
    assert [item["type"] for item in items] == ["message", "message"]


async def test_session_replay_keeps_historical_tool_rounds_atomic() -> None:
    """Completed rounds survive cancellation; a partial parallel round is all text."""
    history = make_session_turns([(
        UserInput(text="inspect both", blocks=[]),
        {"ota_record": [
            {
                "think_result": {
                    "step_content": "I will inspect the first item.",
                    "tool_calls": [{"tool": "read_file", "arguments": {"path": "one.txt"}}],
                },
                "action_result": {"results": [{
                    "tool_id": "call_complete",
                    "tool_name": "read_file",
                    "tool_arguments": {"path": "one.txt"},
                    "tool_result": "one",
                    "success": True,
                }]},
            },
            {
                "think_result": {
                    "step_content": "I will inspect two more items.",
                    "tool_calls": [
                        {"tool": "read_file", "arguments": {"path": "two.txt"}},
                        {"tool": "read_file", "arguments": {"path": "three.txt"}},
                    ],
                },
                "action_result": {"results": [{
                    "tool_id": "call_partial",
                    "tool_name": "read_file",
                    "tool_arguments": {"path": "two.txt"},
                    "tool_result": "two",
                    "success": True,
                }]},
            },
        ]},
    )])
    history[0].status = TurnStatus.CANCELLED
    history[0].error = "Agent execution cancelled"

    messages = await MainThink().session_messages_block(
        _native_ota_context(),
        AmphiContext(session=_session_of(history)),
    )

    assert [message.role for message in messages] == [Role.USER, Role.AI, Role.TOOL, Role.AI]
    native_calls = [
        block
        for message in messages
        for block in message.blocks
        if type(block).__name__ == "ToolCallBlock"
    ]
    assert [call.id for call in native_calls] == ["call_complete"]
    assert messages[-1].content == "I will inspect two more items."


async def test_session_replay_selects_recent_otas_by_record_limit() -> None:
    """The session tail window is selected newest-first by whole OTA, and the
    selected OTA record counts never exceed the global limit."""
    def ota_with_records(count: int, answer: str) -> dict:
        records = [{"think_result": {"step_content": "", "tool_calls": []}} for _ in range(count)]
        records[-1] = {"think_result": {"step_content": answer, "tool_calls": []}}
        return {"ota_record": records}

    newest_count = 60
    middle_count = SESSION_MESSAGE_RECORD_LIMIT - newest_count
    history = make_session_turns([
        (UserInput(text="old", blocks=[]), ota_with_records(1, "old answer")),
        (UserInput(text="middle", blocks=[]), ota_with_records(middle_count, "middle answer")),
        (UserInput(text="newest", blocks=[]), ota_with_records(newest_count, "newest answer")),
    ])
    msgs = await MainThink().session_messages_block(
        _native_ota_context(),
        AmphiContext(session=_session_of(history)),
    )
    text = "\n".join(m.content for m in msgs)

    assert "middle" in text and "middle answer" in text
    assert "newest" in text and "newest answer" in text
    assert "old" not in text and "old answer" not in text
