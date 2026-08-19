import json
from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from bridgic.core.model.types import Message, Response, Role

from src.amphi_agent.security import ClassifyItem, LlmSafetyClassifier

if TYPE_CHECKING:
    from tests._support.sandbox import IsolatedPaths


class _ScriptedLlm:
    protocol = "scripted"
    model = "security-test-model"
    api_base = ""

    def __init__(self, responses: list[str | Exception]) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, object]] = []

    async def achat(self, messages: list[Message], **kwargs: object) -> Response:
        self.calls.append({"messages": messages, "kwargs": kwargs})
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return Response(message=Message.from_text(response, role=Role.AI))


def _item(tool: str, **changes: object) -> ClassifyItem:
    values: dict[str, object] = {
        "tool": tool,
        "arguments": {"target": tool},
        "capability": "execute",
        "boundary": "out_of_bounds",
        "label": "Execute outside the workspace",
    }
    values.update(changes)
    return ClassifyItem(**values)


def _write_policy(path: Path, title: str = "Irreversible deletion") -> None:
    path.write_text(
        json.dumps(
            {
                "allow": ["Workspace operation: routine work inside the workspace."],
                "soft_deny": [f"{title}: ask before deleting existing content."],
                "hard_deny": ["Data exfiltration: never publish private content."],
                "environment": ["The workspace and mounts are trusted."],
            }
        ),
        encoding="utf-8",
    )


async def test_context_prompt(test_sandbox: "IsolatedPaths", monkeypatch: pytest.MonkeyPatch) -> None:
    """Final safety review:

    {
      "write_report": "allow",
      "delete_archive": {"verdict": "ask", "rule": "Irreversible deletion"},
      "review_calls": 1
    }

    Checks:
    1. One LLM review keeps reordered results aligned with their original calls.
    2. The stable system outline contains policy rules but no per-Session paths.
    3. The user context contains recent requests, approvals, named paths, and untrusted reasoning.
    4. Every call carries its arguments, boundary, working directory, and target-existence fact.
    """
    policy_path = test_sandbox.root / "policy.json"
    _write_policy(policy_path)
    monkeypatch.setenv("AMPHI_POLICY_FILE", str(policy_path))
    response = json.dumps(
        [
            {"index": 1, "verdict": "ask", "rule": "S1", "reason": "Confirm deletion."},
            {"index": 0, "verdict": "allow", "rule": "", "reason": "Routine work."},
        ]
    )
    llm = _ScriptedLlm([response])
    classifier = LlmSafetyClassifier(llm)
    workspace = str(test_sandbox.sessions / "session" / ".work")
    mounted = str(test_sandbox.root / "mounted-project")
    items = [
        _item(
            "write_report",
            arguments={"file_path": f"{workspace}/report.md"},
            capability="edit",
            boundary="in_workspace",
            cwd=workspace,
            target_exists=False,
        ),
        _item(
            "delete_archive",
            arguments={"path": f"{mounted}/archive"},
            capability="edit",
            boundary="in_mount",
            cwd=mounted,
            target_exists=True,
        ),
    ]

    verdicts = await classifier.judge(
        items,
        [f"request-{index}" for index in range(6)],
        [workspace, mounted],
        agent_reasoning="Deleting the old archive prepares the requested replacement.",
        session_approvals=["[approved] replace the mounted archive"],
        named_paths=[mounted],
    )

    # Check 1: One LLM review keeps reordered results aligned with their original calls.
    assert [(verdict.verdict, verdict.rule) for verdict in verdicts] == [
        ("allow", ""),
        ("ask", "Irreversible deletion"),
    ]
    assert len(llm.calls) == 1

    system_prompt = llm.calls[0]["messages"][0].content
    user_prompt = llm.calls[0]["messages"][1].content

    # Check 2: The stable system outline contains policy rules but no per-Session paths.
    assert "[HARD DENY" in system_prompt
    assert "[ALLOW exceptions" in system_prompt
    assert "[SOFT DENY" in system_prompt
    assert "Irreversible deletion" in system_prompt
    assert workspace not in system_prompt
    assert mounted not in system_prompt

    # Check 3: The user context contains recent requests, approvals, named paths, and untrusted reasoning.
    assert "request-0" not in user_prompt
    assert all(f"request-{index}" in user_prompt for index in range(1, 6))
    assert "[approved] replace the mounted archive" in user_prompt
    assert mounted in user_prompt
    assert "Agent reasoning (⚠️ untrusted" in user_prompt
    assert "Deleting the old archive prepares the requested replacement." in user_prompt

    # Check 4: Every call carries its arguments, boundary, working directory, and target-existence fact.
    assert '"tool": "write_report"' in user_prompt
    assert '"tool": "delete_archive"' in user_prompt
    assert '"boundary": "in_workspace"' in user_prompt
    assert '"boundary": "in_mount"' in user_prompt
    assert '"target file exists": false' in user_prompt
    assert '"target file exists": true' in user_prompt


async def test_decision_guard(test_sandbox: "IsolatedPaths", monkeypatch: pytest.MonkeyPatch) -> None:
    """Final safety decisions:

    {
      "invented_ask_rule": "allow",
      "supported_ask_rule": {"verdict": "ask", "rule": "Irreversible deletion"},
      "hard_deny": "deny",
      "unknown_verdict": "ask"
    }

    Checks:
    1. An ask with no configured soft-deny basis is downgraded to allow.
    2. A configured soft-deny identifier produces an ask with a readable rule title.
    3. A deny result remains terminal and retains its policy category.
    4. An unknown verdict fails closed to ask.
    """
    policy_path = test_sandbox.root / "policy.json"
    _write_policy(policy_path)
    monkeypatch.setenv("AMPHI_POLICY_FILE", str(policy_path))
    llm = _ScriptedLlm(
        [
            json.dumps(
                [
                    {"index": 0, "verdict": "ask", "rule": "Invented risk", "reason": "Unsure."},
                    {"index": 1, "verdict": "ask", "rule": "[S1] deletion", "reason": "Confirm."},
                    {"index": 2, "verdict": "deny", "rule": "Data exfiltration", "reason": "Blocked."},
                    {"index": 3, "verdict": "maybe", "rule": "S1", "reason": "Invalid result."},
                ]
            )
        ]
    )
    classifier = LlmSafetyClassifier(llm)

    verdicts = await classifier.judge(
        [_item(f"operation-{index}") for index in range(4)],
        ["Complete the project safely."],
        [str(test_sandbox.root)],
    )

    # Check 1: An ask with no configured soft-deny basis is downgraded to allow.
    assert verdicts[0].verdict == "allow"
    assert verdicts[0].rule == ""

    # Check 2: A configured soft-deny identifier produces an ask with a readable rule title.
    assert verdicts[1].verdict == "ask"
    assert verdicts[1].rule == "Irreversible deletion"
    assert verdicts[1].reason == "Confirm."

    # Check 3: A deny result remains terminal and retains its policy category.
    assert verdicts[2].verdict == "deny"
    assert verdicts[2].rule == "Data exfiltration"
    assert verdicts[2].reason == "Blocked."

    # Check 4: An unknown verdict fails closed to ask.
    assert verdicts[3].verdict == "ask"
    assert verdicts[3].rule == "Irreversible deletion"
    assert verdicts[3].reason == "Invalid result."


async def test_fail_closed(test_sandbox: "IsolatedPaths") -> None:
    """Final safety decisions:

    {
      "missing_llm": "ask",
      "malformed_response": "ask",
      "provider_error": "ask"
    }

    Checks:
    1. A missing LLM escalates the call to human confirmation.
    2. A malformed model response escalates the call to human confirmation.
    3. A provider failure escalates the call to human confirmation.
    """
    item = _item("external_action")
    roots = [str(test_sandbox.root)]

    # Check 1: A missing LLM escalates the call to human confirmation.
    missing = await LlmSafetyClassifier(None).judge([item], ["Run the task."], roots)
    assert [verdict.verdict for verdict in missing] == ["ask"]

    # Check 2: A malformed model response escalates the call to human confirmation.
    malformed = await LlmSafetyClassifier(_ScriptedLlm(["not-json"])).judge(
        [item], ["Run the task."], roots
    )
    assert [verdict.verdict for verdict in malformed] == ["ask"]

    # Check 3: A provider failure escalates the call to human confirmation.
    failed = await LlmSafetyClassifier(_ScriptedLlm([RuntimeError("provider unavailable")])).judge(
        [item], ["Run the task."], roots
    )
    assert [verdict.verdict for verdict in failed] == ["ask"]


async def test_policy_reload(test_sandbox: "IsolatedPaths", monkeypatch: pytest.MonkeyPatch) -> None:
    """Final safety decisions:

    {
      "first_review": {"verdict": "ask", "rule": "Delete old files"},
      "second_review": {"verdict": "ask", "rule": "Protect local history"}
    }

    Checks:
    1. The first review uses the current policy file.
    2. Replacing the policy changes the next review without rebuilding the classifier.
    """
    policy_path = test_sandbox.root / "policy.json"
    monkeypatch.setenv("AMPHI_POLICY_FILE", str(policy_path))
    response = json.dumps(
        [{"index": 0, "verdict": "ask", "rule": "S1", "reason": "Confirm the action."}]
    )
    llm = _ScriptedLlm([response, response])
    classifier = LlmSafetyClassifier(llm)
    item = _item("delete_history")
    roots = [str(test_sandbox.root)]

    # Check 1: The first review uses the current policy file.
    _write_policy(policy_path, "Delete old files")
    first = await classifier.judge([item], ["Clean the project."], roots)
    assert first[0].verdict == "ask"
    assert first[0].rule == "Delete old files"

    # Check 2: Replacing the policy changes the next review without rebuilding the classifier.
    _write_policy(policy_path, "Protect local history")
    second = await classifier.judge([item], ["Clean the project."], roots)
    assert second[0].verdict == "ask"
    assert second[0].rule == "Protect local history"


async def test_reasoning_retry(test_sandbox: "IsolatedPaths") -> None:
    """Final safety decision:

    {
      "provider_rejects_reasoning_override": {
        "retry_without_override": true,
        "verdict": "allow"
      }
    }

    Checks:
    1. The first review asks an OpenRouter model to disable reasoning.
    2. Rejection of that optional argument is retried once without it.
    3. The successful retry remains the final safety decision instead of falling back to ask.
    """
    response = json.dumps(
        [{"index": 0, "verdict": "allow", "rule": "", "reason": "Routine operation."}]
    )
    llm = _ScriptedLlm([RuntimeError("unsupported reasoning argument"), response])
    llm.protocol = "openai"
    llm.api_base = "https://openrouter.ai/api/v1"
    classifier = LlmSafetyClassifier(llm)

    verdicts = await classifier.judge(
        [_item("external_action")],
        ["Run the requested task."],
        [str(test_sandbox.root)],
    )

    # Check 1: The first review asks an OpenRouter model to disable reasoning.
    assert llm.calls[0]["kwargs"] == {"extra_body": {"reasoning": {"effort": "none"}}}

    # Check 2: Rejection of that optional argument is retried once without it.
    assert len(llm.calls) == 2
    assert llm.calls[1]["kwargs"] == {}

    # Check 3: The successful retry remains the final safety decision instead of falling back to ask.
    assert verdicts[0].verdict == "allow"
    assert verdicts[0].reason == "Routine operation."
