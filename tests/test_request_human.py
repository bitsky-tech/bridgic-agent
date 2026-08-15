import json

import pytest

from src.amphi_agent.tools._request_human import (
    RequestAcceptRule,
    RequestBuild,
    RequestHumanChoice,
    RequestHumanRejection,
    RequestRunWorkflow,
    request_accept_rule,
    request_build,
    request_human_choice,
    request_human_choice_tool,
    request_run_workflow,
)


def test_acceptance_candidates_drop_premature_ac_ids() -> None:
    assert RequestAcceptRule.normalize_rules([
        "AC-001: 最终链接可以访问。",
    ]) == [
        "最终链接可以访问。",
    ]


def test_acceptance_review_allows_one_or_two_final_outcomes() -> None:
    assert RequestAcceptRule.normalize_rules([
        "报告存在。",
        "报告链接已返回。",
    ]) == [
        "报告存在。",
        "报告链接已返回。",
    ]
    with pytest.raises(RequestHumanRejection, match="one or two final-outcome"):
        RequestAcceptRule.normalize_rules(["报告存在。", "报告包含摘要。", "报告使用中文。"])

    description = request_accept_rule.__doc__ or ""
    assert "one or two direct final-outcome standards" in description
    assert "Add a second only for another independently" in description
    assert "never for an input, field, step, quality, or" in description
    assert "environment or path availability" in description
    assert "The user adopts, rejects," in description
    assert "selects execution-only operation" in description
    assert "or replaces each statement" in description


def test_multi_select_questions_are_normalized_for_review_list_rendering() -> None:
    questions = RequestHumanChoice.normalize_questions(json.dumps({
        "questions": [{
            "question": "请选择需要继续分析的论文",
            "header": "论文筛选",
            "multiSelect": True,
            "allowEmpty": True,
            "emptyLabel": "不分析任何论文",
            "options": [
                {
                    "label": "MemRefine",
                    "description": "OpenReview · 2026-06-11",
                    "preview": "与长期记忆压缩相关。\n\n[查看论文](https://example.com/1)",
                },
                {"label": "ACON", "description": "arXiv · 2025-10-01"},
            ],
        }],
    }))

    question = questions[0]
    assert question["layout"] == "review-list"
    assert question["allowOther"] is False
    assert question["allowEmpty"] is True
    assert question["minSelections"] == 0
    assert question["maxSelections"] == 2
    assert question["emptyLabel"] == "不分析任何论文"
    assert question["options"][0]["preview"].startswith("与长期记忆压缩相关")


def test_compact_question_defaults_remain_backward_compatible() -> None:
    questions = RequestHumanChoice.normalize_questions({
        "questions": [{
            "question": "选择执行方式",
            "options": [{"label": "自动"}, {"label": "手动"}],
        }],
    })

    question = questions[0]
    assert question["layout"] == "compact"
    assert question["allowOther"] is True
    assert question["allowEmpty"] is False
    assert question["minSelections"] == 1
    assert question["maxSelections"] == 1


def test_multi_select_alone_controls_selection_and_presentation() -> None:
    questions = RequestHumanChoice.normalize_questions({
        "questions": [
            {
                "question": "选择实现方案",
                "options": [{"label": "方案 A"}, {"label": "方案 B"}],
            },
            {
                "question": "选择首期能力",
                "multiSelect": True,
                "options": [{"label": "关键词搜索"}, {"label": "语义搜索"}],
            },
        ],
    })

    assert questions[0]["layout"] == "compact"
    assert questions[0]["allowOther"] is True
    assert questions[1]["layout"] == "review-list"
    assert questions[1]["allowOther"] is False

    redundant_layout = {
        "questions": [{
            "question": "选择首期能力",
            "multiSelect": True,
            "layout": "review-list",
            "options": [{"label": "关键词搜索"}, {"label": "语义搜索"}],
        }],
    }
    with pytest.raises(RequestHumanRejection, match="layout is not accepted.*multiSelect"):
        RequestHumanChoice.normalize_questions(redundant_layout)


async def test_human_choice_separates_markdown_prompt_from_short_questions() -> None:
    questions_json = json.dumps({
        "questions": [{
            "question": "请选择实现方案",
            "options": [{"label": "方案 A"}, {"label": "方案 B"}],
            "multiSelect": False,
        }],
    }, ensure_ascii=False)
    prompt = (
        "先看[设计说明](https://example.com/design)。\n\n"
        "```mermaid\nflowchart LR\nA --> B\n```"
    )

    request = await request_human_choice(questions_json, prompt)

    assert request.prompt == prompt
    assert request.questions[0]["question"] == "请选择实现方案"
    assert "prompt" not in request.questions[0]
    description = request_human_choice.__doc__ or ""
    assert "Every call must provide a non-empty ``prompt``" in description
    assert "why you cannot continue without the user's input" in description
    assert "what the user's decision will determine" in description
    assert "questions: The questions as a JSON string" in description
    assert "``multiSelect`` is the question's only selection-mode control" in description
    assert "Do not pass a" in description
    assert "separate layout" in description

    with pytest.raises(RequestHumanRejection, match="prompt exceeds 20000 characters"):
        await request_human_choice(questions_json, "x" * 20_001)

    with pytest.raises(RequestHumanRejection, match="prompt must be non-empty text"):
        await request_human_choice(questions_json, "   ")


def test_human_choice_tool_schema_requires_questions_and_prompt() -> None:
    parameters = request_human_choice_tool.tool_parameters

    assert set(parameters["properties"]) == {"questions", "prompt"}
    assert parameters["required"] == ["questions", "prompt"]
    assert parameters["properties"]["questions"]["type"] == "string"
    assert parameters["properties"]["prompt"]["type"] == "string"


async def test_request_build_ask_carries_the_semantic_conflict() -> None:
    request = await request_build(
        "编辑另一个工作流",
        "ask",
        "新请求要编辑另一个工作流，与当前构建目标不同。",
    )

    assert isinstance(request, RequestBuild)
    assert request.mode == "ask"
    assert request.goal == "编辑另一个工作流"
    assert request.reason == "新请求要编辑另一个工作流，与当前构建目标不同。"
    assert request.request_id is not None

    with pytest.raises(RequestHumanRejection, match="goal.*non-empty"):
        await request_build("  ", "ask")


async def test_run_workflow_request_records_semantic_action() -> None:
    request = await request_run_workflow("wf-report", "resume")

    assert isinstance(request, RequestRunWorkflow)
    assert request.workflow_id == "wf-report"
    assert request.action == "resume"
    assert request.reason is None

    request = await request_run_workflow(
        "wf-report",
        "ask",
        "用户同时提到继续旧进度和使用刚修改的版本。",
    )
    assert request.action == "ask"
    assert request.reason == "用户同时提到继续旧进度和使用刚修改的版本。"


async def test_run_workflow_request_rejects_invalid_identity_or_ask_reason() -> None:
    with pytest.raises(RequestHumanRejection, match="workflow_id.*non-empty"):
        await request_run_workflow(" ", "resume")

    with pytest.raises(RequestHumanRejection, match="must explain"):
        await request_run_workflow("wf-report", "ask")

    with pytest.raises(RequestHumanRejection, match="exceeds 300"):
        await request_run_workflow("wf-report", "restart", "x" * 301)


@pytest.mark.parametrize(
    ("question", "message"),
    [
        (
            {"question": "x" * 241, "options": [{"label": "A"}, {"label": "B"}]},
            "exceeds 240 characters",
        ),
        (
            {"question": "请选择", "options": [{"label": "A"}]},
            "needs at least 2 options",
        ),
        (
            {
                "question": "请选择",
                "allowEmpty": False,
                "minSelections": 0,
                "options": [{"label": "A"}, {"label": "B"}],
            },
            "at least 1 unless allowEmpty is true",
        ),
    ],
)
def test_invalid_rich_question_contract_is_rejected(question: dict, message: str) -> None:
    with pytest.raises(RequestHumanRejection, match=message):
        RequestHumanChoice.normalize_questions({"questions": [question]})
