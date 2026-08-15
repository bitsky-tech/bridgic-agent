import json
import os
from dataclasses import fields, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from bridgic.core.model.types import Message

if TYPE_CHECKING:
    from ._context import AmphiContext

THINKING_DEBUG_ENV_VAR = "BRIDGIC_AGENT_THINKING_DEBUG"
_WORK_DIR_NAME = ".work"
_THINKING_DEBUG_DIR = Path("_msg_debug")
_MESSAGE_PREVIEW_CHARS = 100


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if is_dataclass(value) and not isinstance(value, type):
        return {field.name: _jsonable(getattr(value, field.name)) for field in fields(value)}
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if hasattr(value, "__dict__"):
        return {
            str(k): _jsonable(v)
            for k, v in vars(value).items()
            if not k.startswith("_")
        }
    return value


def _json_dump(value: Any) -> str:
    return json.dumps(_jsonable(value), ensure_ascii=False, indent=2, default=str)


def _timestamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def _role_value(message: Message) -> str:
    return message.role.value if hasattr(message.role, "value") else str(message.role)


def _write_raw_section(lines: List[str], title: str, content: str) -> None:
    lines.append(title)
    lines.append("")
    lines.append(content)
    if not content.endswith("\n"):
        lines.append("")


def _render_debug_message(message: Message, index: int) -> str:
    lines: List[str] = [
        f"# message {index}",
        f"role: {_role_value(message)}",
    ]
    if message.extras:
        lines.extend(["extras:", "```json", _json_dump(message.extras), "```"])
    lines.extend(["", "---", ""])

    blocks = message.blocks or []
    if all(getattr(block, "block_type", None) == "text" for block in blocks):
        lines.append(message.content)
        if not message.content.endswith("\n"):
            lines.append("")
        return "\n".join(lines) + "\n"

    for block_index, block in enumerate(blocks, start=1):
        block_type = getattr(block, "block_type", type(block).__name__)
        if block_index > 1:
            lines.append("")
        lines.append(f"#### block {block_index} ({block_type})")
        if block_type == "text":
            _write_raw_section(lines, "text:", getattr(block, "text", ""))
        else:
            lines.extend(["```json", _json_dump(block), "```"])
    return "\n".join(lines) + "\n"


def _message_preview(message: Message) -> str:
    blocks = message.blocks or []
    if all(getattr(block, "block_type", None) == "text" for block in blocks):
        raw = message.content
    else:
        parts: List[str] = []
        for block in blocks:
            block_type = getattr(block, "block_type", type(block).__name__)
            if block_type == "text":
                parts.append(getattr(block, "text", ""))
            else:
                parts.append(_json_dump(block))
        raw = " ".join(parts)
    preview = " ".join(raw.replace("#", "").split())
    return preview or "(empty)"


def _sanitize_preview(raw: str, max_chars: int) -> str:
    preview = " ".join(raw.replace("#", "").split())
    if len(preview) > max_chars:
        preview = preview[:max_chars] + " ..."
    return (preview or "(empty)").replace("<", "&lt;").replace(">", "&gt;")


def _escape_result_markdown(value: Any) -> str:
    return (
        str(value)
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("[", "\\[")
        .replace("]", "\\]")
    )


def _session_root(context: "AmphiContext") -> Path:
    if context.session.workspace_root:
        return Path(context.session.workspace_root)
    workspace = context.workspace
    root = Path(workspace.work_dir if workspace is not None else os.getcwd())
    return root.parent if root.name == _WORK_DIR_NAME else root


def _debug_dir(root: Path) -> Path:
    debug_dir = root / _THINKING_DEBUG_DIR
    debug_dir.mkdir(parents=True, exist_ok=True)
    return debug_dir


def _message_file_name(index: int, message: Message) -> str:
    role = "".join(c if c.isalnum() or c in {"-", "_"} else "-" for c in _role_value(message).lower())
    return f"message-{index:03d}-{role or 'unknown'}.md"


def _write_message_files(debug_dir: Path, messages: List[Message], timestamp: str) -> List[Dict[str, str]]:
    message_dir = debug_dir / f"ota-messages-{timestamp}-"
    message_dir.mkdir(parents=True, exist_ok=True)
    refs: List[Dict[str, str]] = []
    for index, message in enumerate(messages, start=1):
        path = message_dir / _message_file_name(index, message)
        path.write_text(_render_debug_message(message, index), encoding="utf-8")
        refs.append({
            "role": _role_value(message),
            "preview": _message_preview(message),
            "href": path.relative_to(debug_dir).as_posix(),
        })
    return refs


def _render_debug_result(result: Any) -> str:
    return "\n".join([
        "# result",
        "",
        "```json",
        _json_dump(result),
        "```",
        "",
    ])


def _write_result_file(debug_dir: Path, result: Any, timestamp: str) -> Dict[str, str]:
    result_dir = debug_dir / f"ota-result-{timestamp}-"
    result_dir.mkdir(parents=True, exist_ok=True)
    path = result_dir / "result.md"
    path.write_text(_render_debug_result(result), encoding="utf-8")
    return {
        "href": path.relative_to(debug_dir).as_posix(),
    }


def _result_preview_lines(result: Any) -> List[str]:
    data = _jsonable(result)
    if not isinstance(data, dict):
        return []

    lines: List[str] = []
    content = data.get("content")
    if content:
        lines.extend(["content:", "", _escape_result_markdown(content)])

    tool_calls = data.get("tool_calls")
    if tool_calls:
        if lines:
            lines.append("")
        lines.append("tool_calls:")
        for tool_call in tool_calls:
            if isinstance(tool_call, dict):
                name = tool_call.get("name")
                arguments = tool_call.get("arguments")
            else:
                name = getattr(tool_call, "name", None)
                arguments = getattr(tool_call, "arguments", None)
            lines.append(
                f"- name: {_escape_result_markdown(name or '')}"
            )
            lines.append(
                f"- arguments: {_escape_result_markdown(arguments or {})}"
            )
    return lines


def write_thinking_debug(
    *,
    messages: List[Message],
    tools: List[Any],
    result: Any,
    extra_body: Optional[Dict[str, Any]],
    context: "AmphiContext",
) -> Optional[Path]:
    if not _truthy_env(THINKING_DEBUG_ENV_VAR):
        return None
    root = _session_root(context)
    debug_dir = _debug_dir(root)
    timestamp = _timestamp()
    message_refs = _write_message_files(debug_dir, messages, timestamp)
    result_ref = _write_result_file(debug_dir, result, timestamp)
    lines: List[str] = [
        "# thinking debug",
        "",
        f"created_at: {datetime.now(timezone.utc).isoformat()}",
        f"session_root: {root}",
        "",
        "## messages",
        "",
    ]
    for index, ref in enumerate(message_refs, start=1):
        lines.append(
            f"- [message {index:03d}]({ref['href']}) | role: {ref['role']} | preview: {_sanitize_preview(ref['preview'], _MESSAGE_PREVIEW_CHARS)}"
        )
    lines.extend([
        "",
        "## result",
        "",
        f"[result]({result_ref['href']})",
    ])
    lines.extend(_result_preview_lines(result))
    lines.extend([
        "",
        "## tools",
        "",
        "```json",
        _json_dump(tools),
        "```",
    ])
    if extra_body is not None:
        lines.extend(["", "## extra_body", "", "```json", _json_dump(extra_body), "```"])
    path = debug_dir / f"ota-{timestamp}.md"
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return path


__all__ = ["THINKING_DEBUG_ENV_VAR", "write_thinking_debug"]
