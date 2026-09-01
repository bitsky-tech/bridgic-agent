import os
from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from bridgic.amphibious import StepToolCall, ToolArgument

from src.amphi_agent.security import (
    ClassifyItem,
    ClassifyVerdict,
    ExecutionMode,
    PermissionEngine,
)

if TYPE_CHECKING:
    from tests._support.sandbox import IsolatedPaths


class _ScriptedClassifier:
    def __init__(self, verdicts: list[ClassifyVerdict]) -> None:
        self.verdicts = verdicts
        self.requests: list[dict[str, object]] = []

    async def judge(
        self,
        items: list[ClassifyItem],
        user_messages: list[str],
        roots: list[str],
        agent_reasoning: str = "",
        session_approvals: list[str] | None = None,
        named_paths: list[str] | None = None,
    ) -> list[ClassifyVerdict]:
        self.requests.append(
            {
                "items": items,
                "user_messages": user_messages,
                "roots": roots,
                "agent_reasoning": agent_reasoning,
                "session_approvals": session_approvals,
                "named_paths": named_paths,
            }
        )
        return list(self.verdicts)


def _tool_call(tool: str, **arguments: str) -> StepToolCall:
    return StepToolCall(
        tool=tool,
        tool_arguments=[
            ToolArgument(name=name, value=value)
            for name, value in arguments.items()
        ],
    )


def _outside_root() -> Path:
    return (
        Path(f"{os.environ.get('SystemDrive', 'C:')}\\")
        if os.name == "nt"
        else Path("/")
    )


async def test_execution_modes(test_sandbox: "IsolatedPaths") -> None:
    """Final permission decisions:

    {
      "web_fetch": {
        "request": "ask",
        "auto": "allow_after_safety_review",
        "full": "allow_without_safety_review"
      }
    }

    Checks:
    1. Request mode asks the user before a network destination is opened.
    2. Auto mode accepts the safety classifier's decision for the risky call.
    3. Full mode allows the call without invoking the safety classifier.
    """
    call = _tool_call("web_fetch", url="https://example.com/data")
    workspace = str(test_sandbox.sessions / "session" / ".work")

    # Check 1: Request mode asks the user before a network destination is opened.
    request_classifier = _ScriptedClassifier([ClassifyVerdict(verdict="allow")])
    request_engine = PermissionEngine(workspace, mode=ExecutionMode.REQUEST, classifier=request_classifier)
    request_verdict = (await request_engine.evaluate([call]))[0]
    assert request_verdict.verdict == "ask"
    assert request_verdict.capability == "network"
    assert request_classifier.requests == []

    # Check 2: Auto mode accepts the safety classifier's decision for the risky call.
    auto_classifier = _ScriptedClassifier([ClassifyVerdict(verdict="allow")])
    auto_engine = PermissionEngine(workspace, mode=ExecutionMode.AUTO, classifier=auto_classifier)
    auto_verdict = (await auto_engine.evaluate([call]))[0]
    assert auto_verdict.verdict == "allow"
    assert [item.tool for item in auto_classifier.requests[0]["items"]] == ["web_fetch"]

    # Check 3: Full mode allows the call without invoking the safety classifier.
    full_classifier = _ScriptedClassifier([ClassifyVerdict(verdict="deny")])
    full_engine = PermissionEngine(workspace, mode=ExecutionMode.FULL, classifier=full_classifier)
    full_verdict = (await full_engine.evaluate([call]))[0]
    assert full_verdict.verdict == "allow"
    assert full_classifier.requests == []


async def test_path_boundaries(test_sandbox: "IsolatedPaths") -> None:
    """Final permission decisions:

    {
      "outside_read": {"verdict": "allow", "boundary": "out_of_bounds"},
      "workspace_write": {"verdict": "allow", "boundary": "in_workspace"},
      "mounted_write": {"verdict": "allow", "boundary": "in_mount"},
      "outside_write": {"verdict": "ask", "boundary": "out_of_bounds"}
    }

    Checks:
    1. A non-sensitive read remains available outside the workspace.
    2. Writes inside the Session workspace are allowed.
    3. Writes inside a user-mounted directory are allowed.
    4. Request mode asks before writing anywhere outside trusted paths.
    """
    workspace = test_sandbox.sessions / "session" / ".work"
    mounted = test_sandbox.root / "mounted-project"
    workspace.mkdir(parents=True)
    mounted.mkdir()
    outside = _outside_root() / "amphi-permission-outside.txt"
    engine = PermissionEngine(str(workspace), [str(mounted)], mode=ExecutionMode.REQUEST)
    calls = [
        _tool_call("read_file", file_path=str(outside)),
        _tool_call("write_file", file_path=str(workspace / "inside.txt"), content="inside"),
        _tool_call("write_file", file_path=str(mounted / "mounted.txt"), content="mounted"),
        _tool_call("write_file", file_path=str(outside), content="outside"),
    ]

    verdicts = await engine.evaluate(calls)

    # Check 1: A non-sensitive read remains available outside the workspace.
    assert verdicts[0].verdict == "allow"
    assert verdicts[0].capability == "read"
    assert verdicts[0].boundary == "out_of_bounds"

    # Check 2: Writes inside the Session workspace are allowed.
    assert verdicts[1].verdict == "allow"
    assert verdicts[1].capability == "edit"
    assert verdicts[1].boundary == "in_workspace"

    # Check 3: Writes inside a user-mounted directory are allowed.
    assert verdicts[2].verdict == "allow"
    assert verdicts[2].capability == "edit"
    assert verdicts[2].boundary == "in_mount"

    # Check 4: Request mode asks before writing anywhere outside trusted paths.
    assert verdicts[3].verdict == "ask"
    assert verdicts[3].capability == "edit"
    assert verdicts[3].boundary == "out_of_bounds"


async def test_symlink_escape(test_sandbox: "IsolatedPaths") -> None:
    """Final permission decision:

    {
      "workspace/outside-link/secret.txt": {
        "real_target": "<system-root>/secret.txt",
        "verdict": "ask",
        "boundary": "out_of_bounds"
      }
    }

    Checks:
    1. A link inside the workspace is resolved to its real external target.
    2. Request mode asks before writing through the escaping link.
    """
    workspace = test_sandbox.sessions / "session" / ".work"
    workspace.mkdir(parents=True)
    link = workspace / "outside-link"
    try:
        link.symlink_to(_outside_root(), target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"Directory symlinks are unavailable on this platform: {exc}")
    call = _tool_call(
        "write_file",
        file_path=str(link / "amphi-permission-symlink.txt"),
        content="outside",
    )
    engine = PermissionEngine(str(workspace), mode=ExecutionMode.REQUEST)

    verdict = (await engine.evaluate([call]))[0]

    # Check 1: A link inside the workspace is resolved to its real external target.
    assert verdict.capability == "edit"
    assert verdict.boundary == "out_of_bounds"

    # Check 2: Request mode asks before writing through the escaping link.
    assert verdict.verdict == "ask"


async def test_deletion_rules(test_sandbox: "IsolatedPaths") -> None:
    """Final permission decisions in full mode:

    {
      "rm -rf ~/.ssh": {"verdict": "ask", "sensitive": true},
      "rm -rf node_modules": {"verdict": "allow", "regenerable": true},
      "rm -rf $TARGET": {"verdict": "deny_after_safety_review", "uncertain": true}
    }

    Checks:
    1. Sensitive credential deletion always requires human confirmation.
    2. Regenerable dependency deletion is allowed without review.
    3. An unresolved deletion target still reaches safety review in full mode.
    """
    workspace = test_sandbox.sessions / "session" / ".work"
    workspace.mkdir(parents=True)
    classifier = _ScriptedClassifier(
        [ClassifyVerdict(verdict="deny", reason="The target cannot be resolved safely.")]
    )
    engine = PermissionEngine(str(workspace), mode=ExecutionMode.FULL, classifier=classifier)
    calls = [
        _tool_call("bash", command="rm -rf ~/.ssh", cwd=str(workspace)),
        _tool_call("bash", command="rm -rf node_modules", cwd=str(workspace)),
        _tool_call("bash", command="rm -rf $TARGET", cwd=str(workspace)),
    ]

    verdicts = await engine.evaluate(calls)

    # Check 1: Sensitive credential deletion always requires human confirmation.
    assert verdicts[0].verdict == "ask"
    assert verdicts[0].sensitive is True
    assert verdicts[0].deletion is True

    # Check 2: Regenerable dependency deletion is allowed without review.
    assert verdicts[1].verdict == "allow"
    assert verdicts[1].deletion is True
    assert verdicts[1].regenerable is True

    # Check 3: An unresolved deletion target still reaches safety review in full mode.
    assert verdicts[2].verdict == "deny"
    assert verdicts[2].deletion is True
    assert verdicts[2].uncertain_destruction is True
    assert [item.arguments["command"] for item in classifier.requests[0]["items"]] == [
        "rm -rf $TARGET"
    ]


async def test_hard_denial(test_sandbox: "IsolatedPaths") -> None:
    """Final permission decisions:

    {
      "system_shutdown": {
        "direct": {"request": "deny", "auto": "deny", "full": "deny"},
        "after_safe_command": {"request": "deny", "auto": "deny", "full": "deny"}
      },
      "safety_classifier_calls": 0
    }

    Checks:
    1. A system shutdown command is denied in every execution mode.
    2. A harmless command prefix cannot hide the shutdown command.
    3. A hard denial cannot be overridden by a permissive safety classifier.
    """
    workspace = test_sandbox.sessions / "session" / ".work"
    workspace.mkdir(parents=True)
    command = "Stop-Computer" if os.name == "nt" else "shutdown -h now"
    compound = (
        "Write-Output ready; Stop-Computer"
        if os.name == "nt"
        else "echo ready && shutdown -h now"
    )
    calls = [
        _tool_call("bash", command=command, cwd=str(workspace)),
        _tool_call("bash", command=compound, cwd=str(workspace)),
    ]
    direct_outcomes: dict[str, str] = {}
    compound_outcomes: dict[str, str] = {}
    classifiers: list[_ScriptedClassifier] = []

    # Check 1: A system shutdown command is denied in every execution mode.
    for mode in ExecutionMode:
        classifier = _ScriptedClassifier([ClassifyVerdict(verdict="allow")])
        classifiers.append(classifier)
        engine = PermissionEngine(str(workspace), mode=mode, classifier=classifier)
        verdicts = await engine.evaluate(calls)
        direct_outcomes[mode.value] = verdicts[0].verdict
        compound_outcomes[mode.value] = verdicts[1].verdict
        assert verdicts[0].capability == "execute"
    assert direct_outcomes == {"request": "deny", "auto": "deny", "full": "deny"}

    # Check 2: A harmless command prefix cannot hide the shutdown command.
    assert compound_outcomes == {"request": "deny", "auto": "deny", "full": "deny"}

    # Check 3: A hard denial cannot be overridden by a permissive safety classifier.
    assert all(classifier.requests == [] for classifier in classifiers)


async def test_classifier_results(test_sandbox: "IsolatedPaths") -> None:
    """Final permission decisions:

    {
      "inspect_remote": "allow",
      "change_remote": "ask",
      "publish_remote": "deny"
    }

    Checks:
    1. Auto mode preserves the classifier's allow, ask, and deny result order.
    2. Ask and deny explanations remain attached to the matching tool calls.
    3. Trusted user context and path boundaries reach one batched safety review.
    """
    workspace = test_sandbox.sessions / "session" / ".work"
    mounted = test_sandbox.root / "mounted-project"
    workspace.mkdir(parents=True)
    mounted.mkdir()
    classifier = _ScriptedClassifier(
        [
            ClassifyVerdict(verdict="allow"),
            ClassifyVerdict(verdict="ask", reason="Confirm the remote change.", rule="External writes"),
            ClassifyVerdict(verdict="deny", reason="Publishing is blocked.", rule="Public publishing"),
        ]
    )
    engine = PermissionEngine(str(workspace), [str(mounted)], ExecutionMode.AUTO, classifier)
    calls = [
        _tool_call("inspect_remote", resource="alpha"),
        _tool_call("change_remote", resource="beta"),
        _tool_call("publish_remote", resource="gamma"),
    ]

    verdicts = await engine.evaluate(
        calls,
        user_messages=["Review and update the remote project."],
        agent_reasoning="The second call applies the requested update.",
        session_approvals=["[approved] inspect the same project"],
        named_paths=[str(mounted)],
    )

    # Check 1: Auto mode preserves the classifier's allow, ask, and deny result order.
    assert [verdict.verdict for verdict in verdicts] == ["allow", "ask", "deny"]
    assert [verdict.tool for verdict in verdicts] == [
        "inspect_remote",
        "change_remote",
        "publish_remote",
    ]

    # Check 2: Ask and deny explanations remain attached to the matching tool calls.
    assert verdicts[1].reason == "Confirm the remote change."
    assert verdicts[1].rule == "External writes"
    assert verdicts[2].reason == "Publishing is blocked."
    assert verdicts[2].rule == "Public publishing"

    # Check 3: Trusted user context and path boundaries reach one batched safety review.
    assert len(classifier.requests) == 1
    request = classifier.requests[0]
    assert [item.tool for item in request["items"]] == [
        "inspect_remote",
        "change_remote",
        "publish_remote",
    ]
    assert request["user_messages"] == ["Review and update the remote project."]
    assert request["roots"] == [str(workspace), str(mounted)]
    assert request["agent_reasoning"] == "The second call applies the requested update."
    assert request["session_approvals"] == ["[approved] inspect the same project"]
    assert request["named_paths"] == [str(mounted)]


async def test_classifier_fallback(test_sandbox: "IsolatedPaths") -> None:
    """Final permission decisions:

    {
      "classifier_unavailable": ["ask", "ask"],
      "incomplete_classifier_batch": ["deny", "ask"]
    }

    Checks:
    1. Auto mode fails closed when no safety classifier is available.
    2. A missing result in a classifier batch becomes ask without shifting another result.
    """
    workspace = str(test_sandbox.sessions / "session" / ".work")
    calls = [
        _tool_call("remote_action", resource="alpha"),
        _tool_call("remote_action", resource="beta"),
    ]

    # Check 1: Auto mode fails closed when no safety classifier is available.
    unavailable = PermissionEngine(workspace, mode=ExecutionMode.AUTO)
    unavailable_verdicts = await unavailable.evaluate(calls)
    assert [verdict.verdict for verdict in unavailable_verdicts] == ["ask", "ask"]
    assert [verdict.arguments["resource"] for verdict in unavailable_verdicts] == ["alpha", "beta"]

    # Check 2: A missing result in a classifier batch becomes ask without shifting another result.
    incomplete_classifier = _ScriptedClassifier(
        [ClassifyVerdict(verdict="deny", reason="The first action is blocked.")]
    )
    incomplete = PermissionEngine(workspace, mode=ExecutionMode.AUTO, classifier=incomplete_classifier)
    incomplete_verdicts = await incomplete.evaluate(calls)
    assert [verdict.verdict for verdict in incomplete_verdicts] == ["deny", "ask"]
    assert incomplete_verdicts[0].reason == "The first action is blocked."
    assert incomplete_verdicts[1].arguments == {"resource": "beta"}


async def test_gated_paths(test_sandbox: "IsolatedPaths") -> None:
    """Final permission decisions:

    {
      "workflow_run": {
        "work/output.txt": {"verdict": "allow", "boundary": "in_workspace"},
        "background/internal.json": {"verdict": "deny", "boundary": "out_of_bounds"}
      }
    }

    Checks:
    1. A managed writable subtree behaves like a workspace write target.
    2. A sibling framework-owned subtree remains gated from Agent writes.
    """
    workspace = test_sandbox.sessions / "session" / ".work"
    run_root = test_sandbox.runs / "run-a"
    writable = run_root / "work"
    protected = run_root / "background"
    workspace.mkdir(parents=True)
    writable.mkdir(parents=True)
    protected.mkdir()
    classifier = _ScriptedClassifier(
        [ClassifyVerdict(verdict="deny", reason="Framework records are protected.")]
    )
    engine = PermissionEngine(
        str(workspace),
        mode=ExecutionMode.AUTO,
        classifier=classifier,
        writable_roots=[str(writable)],
        gated_roots=[str(run_root)],
    )
    calls = [
        _tool_call("write_file", file_path=str(writable / "output.txt"), content="result"),
        _tool_call("write_file", file_path=str(protected / "internal.json"), content="tampered"),
    ]

    verdicts = await engine.evaluate(calls)

    # Check 1: A managed writable subtree behaves like a workspace write target.
    assert verdicts[0].verdict == "allow"
    assert verdicts[0].boundary == "in_workspace"

    # Check 2: A sibling framework-owned subtree remains gated from Agent writes.
    assert verdicts[1].verdict == "deny"
    assert verdicts[1].boundary == "out_of_bounds"
    assert verdicts[1].reason == "Framework records are protected."
    assert [item.arguments["file_path"] for item in classifier.requests[0]["items"]] == [
        str(protected / "internal.json")
    ]


async def test_tool_surfaces(test_sandbox: "IsolatedPaths") -> None:
    """Final permission decisions in auto mode:

    {
      "list_skills": "allow",
      "create_schedule": "allow",
      "mcp_get": "allow",
      "mcp_create": "deny_after_safety_review",
      "browser_snapshot": "allow",
      "browser_navigate": "ask_after_safety_review"
    }

    Checks:
    1. Read-only management and MCP calls are allowed without model review.
    2. Trusted in-app writes are allowed in auto mode.
    3. External MCP writes and new browser destinations reach safety review.
    4. Browser observation remains available without repeated safety review.
    """
    workspace = str(test_sandbox.sessions / "session" / ".work")
    classifier = _ScriptedClassifier(
        [
            ClassifyVerdict(verdict="deny", reason="External creation is blocked."),
            ClassifyVerdict(verdict="ask", reason="Confirm the new destination."),
        ]
    )
    engine = PermissionEngine(workspace, mode=ExecutionMode.AUTO, classifier=classifier)
    calls = [
        _tool_call("list_skills"),
        _tool_call("create_schedule", name="daily"),
        _tool_call("mcp__notes__get_item", item_id="note-a"),
        _tool_call("mcp__notes__create_item", title="New note"),
        _tool_call("browser_snapshot"),
        _tool_call("browser_navigate", url="https://example.com"),
    ]

    verdicts = await engine.evaluate(calls)

    # Check 1: Read-only management and MCP calls are allowed without model review.
    assert verdicts[0].verdict == "allow"
    assert verdicts[0].capability == "manage"
    assert verdicts[2].verdict == "allow"
    assert verdicts[2].capability == "mcp"

    # Check 2: Trusted in-app writes are allowed in auto mode.
    assert verdicts[1].verdict == "allow"
    assert verdicts[1].capability == "manage_write"

    # Check 3: External MCP writes and new browser destinations reach safety review.
    assert verdicts[3].verdict == "deny"
    assert verdicts[5].verdict == "ask"
    assert [item.tool for item in classifier.requests[0]["items"]] == [
        "mcp__notes__create_item",
        "browser_navigate",
    ]

    # Check 4: Browser observation remains available without repeated safety review.
    assert verdicts[4].verdict == "allow"
    assert verdicts[4].capability == "network"


async def test_permission_logs_redact_call_arguments(test_sandbox: "IsolatedPaths", caplog) -> None:
    """Daemon diagnostics retain the decision while never recording command secrets."""
    caplog.set_level("INFO", logger="src.amphi_agent.security._engine")
    workspace = str(test_sandbox.sessions / "session" / ".work")
    engine = PermissionEngine(workspace, mode=ExecutionMode.REQUEST)

    await engine.evaluate([
        _tool_call(
            "bash",
            command='curl -H "Authorization: Bearer sk-super-secret" https://example.test',
        )
    ])

    assert "[permission]" in caplog.text
    assert "bash" in caplog.text
    assert "Authorization" not in caplog.text
    assert "sk-super-secret" not in caplog.text


def test_every_workbench_tool_is_classified() -> None:
    """Final capability coverage:

    {"unclassified_workbench_tools": []}

    Checks:
    1. No spreadsheet or document tool falls through to the unregistered class,
       which the registry treats as "review" and would otherwise make every
       call prompt the person.
    2. The tools that only read are not classified as writes, and the tools
       that touch the filesystem are.
    """
    from src.amphi_agent.security._classify import _tool_capability
    from src.amphi_agent.security._types import Capability
    from src.amphi_agent.tools import DOC_TOOL_NAMES, SHEET_TOOL_NAMES

    workbench_tools = SHEET_TOOL_NAMES | DOC_TOOL_NAMES

    # Check 1: nothing is left unregistered.
    unclassified = sorted(
        name for name in workbench_tools
        if _tool_capability(name) is Capability.EXECUTE
    )
    assert unclassified == []

    # Check 2: reads, in-app writes and file writes land in their own classes.
    assert _tool_capability("sheet_read") is Capability.MANAGE
    assert _tool_capability("sheet_selection") is Capability.MANAGE
    assert _tool_capability("doc_read") is Capability.MANAGE
    assert _tool_capability("sheet_format") is Capability.MANAGE_WRITE
    assert _tool_capability("doc_append") is Capability.MANAGE_WRITE
    assert _tool_capability("sheet_save") is Capability.EDIT
    assert _tool_capability("doc_save") is Capability.EDIT
