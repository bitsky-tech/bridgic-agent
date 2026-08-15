from __future__ import annotations

from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec

from .._workspace import Workspace, WorkspaceCheckpoints

WORKSPACE_BASIC_TOOL_NAMES = frozenset({
    "workspace_status",
    "workspace_diff",
    "workspace_history",
    "workspace_restore_file",
    "workspace_restore",
    "load_workspace_tools",
})

WORKSPACE_ADVANCED_TOOL_NAMES = frozenset({
    "workspace_checkpoint",
})

WORKSPACE_TOOL_NAMES = WORKSPACE_BASIC_TOOL_NAMES | WORKSPACE_ADVANCED_TOOL_NAMES


def _workspace() -> Workspace:
    agent = current_agent.get(None)
    context = getattr(agent, "ctx", None) or getattr(agent, "context", None)
    workspace = getattr(context, "workspace", None) if context is not None else None
    if workspace is None:
        raise RuntimeError("workspace tools require an agent context with workspace.")
    return workspace


async def workspace_status() -> str:
    """Show current workspace changes and the latest checkpoint."""
    workspace = _workspace()
    changes = workspace.checkpoints.current_changes()
    checkpoints = workspace.checkpoints.history(max_count=1)
    latest_changes = (
        workspace.checkpoints.checkpoint_changes(checkpoints[0]["checkpoint_id"])
        if not changes and checkpoints else []
    )
    return _format_status(changes, checkpoints, latest_changes)


async def workspace_diff(
    file_path: str = "",
    staged: bool = False,
    checkpoint_id: str = "",
) -> str:
    """Show a git-style diff for current workspace changes or one checkpoint."""
    workspace = _workspace()
    checkpoint = (checkpoint_id or "").strip()
    if checkpoint:
        if staged:
            return "checkpoint_id cannot be used with staged=true. Use one diff mode at a time."
        return workspace.checkpoints.checkpoint_diff(checkpoint, file_path=file_path)

    diff = workspace.checkpoints.diff(file_path=file_path, staged=staged)
    new_files = [
        change for change in workspace.checkpoints.current_changes()
        if change["label"] == "New File"
    ]
    if new_files and diff == "(No diff.)":
        return (
            "(No diff for tracked files.)\n"
            "New files:\n"
            + "\n".join(f"- {WorkspaceCheckpoints.format_change(change)}" for change in new_files)
        )
    return diff


async def workspace_history(max_count: int = 20) -> str:
    """List recent workspace checkpoints."""
    return _format_history(_workspace().checkpoints.history(max_count=max_count))


async def load_workspace_tools() -> str:
    """Load advanced workspace versioning tools into the next reasoning step."""
    agent = current_agent.get(None)
    ota_ctx = getattr(agent, "ota_ctx", None)
    if ota_ctx is None:
        raise RuntimeError("load_workspace_tools can only run inside an agent turn.")
    ota_ctx.workspace_tools_loaded = True
    return (
        "Advanced workspace tools are loaded for the next reasoning step.\n\n"
        "New workspace tools include:\n"
        "- workspace_checkpoint: Create a named checkpoint.\n\n"
        "Restore tools are already available in the basic workspace tools."
    )


async def workspace_checkpoint(message: str = "") -> str:
    """Create a checkpoint for the current workspace if there are changes."""
    checkpoint_id = _workspace().checkpoints.checkpoint(message or "Workspace checkpoint")
    if checkpoint_id is None:
        return "Workspace is clean; no checkpoint created."
    return f"Created workspace checkpoint {checkpoint_id[:12]}."


async def workspace_restore_file(
    checkpoint_id: str,
    file_path: str,
) -> str:
    """Restore one workspace file from a checkpoint."""
    restored = _workspace().checkpoints.restore_file(checkpoint_id, file_path)
    return f"Restored {restored} from checkpoint {checkpoint_id}."


async def workspace_restore(checkpoint_id: str) -> str:
    """Restore the entire workspace to a checkpoint."""
    restored = _workspace().checkpoints.restore(checkpoint_id)
    return f"Restored workspace to checkpoint {restored[:12]}."


def _format_status(
    changes: list[dict],
    checkpoints: list[dict],
    latest_changes: list[dict],
) -> str:
    latest = (
        f"Latest checkpoint: {WorkspaceCheckpoints.format_checkpoint(checkpoints[0])}"
        if checkpoints else "Latest checkpoint: none"
    )
    if not changes:
        sections = ["Workspace is clean.", latest]
        if latest_changes:
            sections.append("Latest checkpoint changes:")
            sections.extend(f"- {WorkspaceCheckpoints.format_change(change)}" for change in latest_changes)
        return "\n".join(sections)
    sections = ["Workspace changes:"]
    sections.extend(f"- {WorkspaceCheckpoints.format_change(change)}" for change in changes)
    sections.append(latest)
    return "\n".join(sections)


def _format_history(checkpoints: list[dict]) -> str:
    if not checkpoints:
        return "(No workspace checkpoints.)"
    lines = [
        "Workspace checkpoints:",
        "Use the left 12-character id as checkpoint_id for workspace_diff or restore tools.",
    ]
    for item in checkpoints:
        lines.append(f"- {WorkspaceCheckpoints.format_checkpoint(item)}")
    return "\n".join(lines)


workspace_status_tool = FunctionToolSpec.from_raw(workspace_status)
workspace_diff_tool = FunctionToolSpec.from_raw(workspace_diff)
workspace_history_tool = FunctionToolSpec.from_raw(workspace_history)
load_workspace_tools_tool = FunctionToolSpec.from_raw(load_workspace_tools)
workspace_checkpoint_tool = FunctionToolSpec.from_raw(workspace_checkpoint)
workspace_restore_file_tool = FunctionToolSpec.from_raw(workspace_restore_file)
workspace_restore_tool = FunctionToolSpec.from_raw(workspace_restore)

workspace_basic_tool_specs = [
    workspace_status_tool,
    workspace_diff_tool,
    workspace_history_tool,
    workspace_restore_file_tool,
    workspace_restore_tool,
    load_workspace_tools_tool,
]

workspace_advanced_tool_specs = [
    workspace_checkpoint_tool,
]

workspace_tool_specs = [
    *workspace_basic_tool_specs,
    *workspace_advanced_tool_specs,
]

__all__ = [
    "WORKSPACE_ADVANCED_TOOL_NAMES",
    "WORKSPACE_BASIC_TOOL_NAMES",
    "WORKSPACE_TOOL_NAMES",
    "load_workspace_tools",
    "load_workspace_tools_tool",
    "workspace_advanced_tool_specs",
    "workspace_basic_tool_specs",
    "workspace_checkpoint",
    "workspace_checkpoint_tool",
    "workspace_diff",
    "workspace_diff_tool",
    "workspace_history",
    "workspace_history_tool",
    "workspace_restore",
    "workspace_restore_file",
    "workspace_restore_file_tool",
    "workspace_restore_tool",
    "workspace_status",
    "workspace_status_tool",
    "workspace_tool_specs",
]
