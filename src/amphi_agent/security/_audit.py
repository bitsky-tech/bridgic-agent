"""Approval records on disk — every tool approval leaves a complete, readable record in
the session's permissions directory.

Written to
``<session>/.internal/permissions/approval-<datetime>-<tool>-<rid8>.md``: when an
approval is parked it records the **full command text** + capability/boundary + safety
judgement + a plain-language explanation; after the user decides, the final allow/deny
is **appended**. Purely for auditing — any write failure only logs a WARNING and never
affects the approval flow (fail-safe).

The record's own scaffolding (headings, table headers, field labels) is **English only**
and deliberately not localized: it is a diagnostic artefact, not product surface, and it
already embeds English throughout — tool names, capability/boundary enum values, raw
commands, and the classifier's full English system prompt. Translating the labels around
that would produce a bilingual report without making it any more readable.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _command_text(arguments: Any) -> str:
    """The full command text of an approval item: entries with a ``command`` use it
    verbatim, everything else is serialised as multi-line JSON."""
    if isinstance(arguments, dict) and isinstance(arguments.get("command"), str):
        return arguments["command"]
    try:
        return json.dumps(arguments, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        return str(arguments)


def _safe_name(name: str) -> str:
    """Sanitise a tool name into a safe filename fragment (alphanumerics / - / _), with
    everything else replaced by _."""
    cleaned = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in name).strip("_")
    return cleaned or "tool"


def _render(request_id: str, mode: str, records: List[Dict[str, Any]], now: str) -> str:
    """Render a whole batch of pending calls into complete markdown (each item with its
    full command + judgement + explanation)."""
    lines = [
        "# Tool approval record",
        "",
        f"- Time: {now}",
        f"- request_id: `{request_id}`",
        f"- Execution mode: {mode}",
        f"- Pending approvals: {len(records)}",
    ]
    for k, r in enumerate(records, start=1):
        summary = str(r.get("summary") or "").strip() or "(No plain-language explanation available)"
        reason = str(r.get("reason") or "").strip() or "(None)"
        lines += [
            "",
            "---",
            "",
            f"## [{k}] `{r.get('tool', '')}`",
            "",
            f"- Capability / boundary: {r.get('capability', '')} / {r.get('boundary', '')}",
            f"- Safety judgement: `ask` — {reason}",
            "",
            "### Explanation",
            summary,
            "",
            "### Full command",
            "```",
            _command_text(r.get("arguments")),
            "```",
        ]
    return "\n".join(lines) + "\n"


def write_approval_record(
    perm_dir: Optional[Path],
    request_id: str,
    mode: str,
    records: List[Dict[str, Any]],
) -> Optional[Path]:
    """Write one complete approval record and return its path; a missing perm_dir or a
    write failure returns None (never affecting the approval)."""
    if perm_dir is None or not records:
        return None
    try:
        now = datetime.now()
        first_tool = _safe_name(str(records[0].get("tool") or "tool"))
        tool_tag = first_tool if len(records) == 1 else f"{first_tool}+{len(records) - 1}"
        name = f"approval-{now.strftime('%Y%m%d_%H%M%S')}-{tool_tag}-{request_id[:8]}.md"
        perm_dir.mkdir(parents=True, exist_ok=True)
        path = perm_dir / name
        path.write_text(
            _render(request_id, mode, records, now.strftime("%Y-%m-%d %H:%M:%S")),
            encoding="utf-8",
        )
        return path
    except OSError as exc:
        logger.warning("[audit] failed to write approval record request_id=%s: %s", request_id, exc)
        return None


def append_decisions(audit_file: Optional[str], decisions: List[Dict[str, Any]]) -> None:
    """Append the user's final decisions to the "user decisions" section of the approval
    record; a missing file or a failure is silent (WARNING only)."""
    if not audit_file or not decisions:
        return
    path = Path(audit_file)
    if not path.is_file():
        return
    try:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        lines = ["", "---", "", f"## User decisions ({now})", ""]
        for k, d in enumerate(decisions, start=1):
            mark = "✅ Allowed" if d.get("decision") == "allow" else "⛔ Denied"
            instr = str(d.get("instruction") or "").strip()
            suffix = f"(Additional instruction: {instr})" if instr else ""
            lines.append(f"- [{k}] `{d.get('tool', '')}`: {mark} {suffix}".rstrip())
        with path.open("a", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
    except OSError as exc:
        logger.warning("[audit] failed to append decisions file=%s: %s", audit_file, exc)


def _render_classify(now: str, system_prompt: str, user_prompt: str, verdicts: List[Any]) -> str:
    """One classifier judgement → self-contained markdown: the verdict table plus the full
    system/user prompts."""
    lines = [
        "# Safety classifier decision record",
        "",
        f"- Time: {now}",
        f"- Pending verdicts: {len(verdicts)}",
        "",
        "## Verdicts (classifier output)",
        "",
        "| # | verdict | rule | reason |",
        "| --- | --- | --- | --- |",
    ]
    for i, v in enumerate(verdicts):
        rule = str(getattr(v, "rule", "") or "").replace("|", "\\|")
        reason = str(getattr(v, "reason", "") or "").replace("|", "\\|")
        lines.append(f"| {i} | {getattr(v, 'verdict', '')} | {rule} | {reason} |")
    lines += [
        "",
        "## Full classifier context (user request / prior decisions / agent reasoning to verify; tool execution results excluded)",
        "",
        # Both sections are stored in full. An earlier version recorded only a sha256 fingerprint
        # of the SYSTEM section to save space (it is a static policy, byte-identical on every call),
        # but when investigating a misjudgement the one thing you most want to see is exactly that
        # set of criteria, and a fingerprint alone means going back and re-running a command to
        # reconstruct it — the whole value of an audit record is being self-contained. The space
        # saved isn't worth it either: 16KB per call, and calls that reach the classifier are a
        # minority anyway (with the auto rule plus the completed trust boundary, a whole session
        # was measured at 0–3).
        "### SYSTEM (criteria built from policy.json / built-in default policy)",
        "",
        "```text",
        system_prompt,
        "```",
        "",
        "### USER (varies per decision)",
        "",
        "```text",
        user_prompt,
        "```",
        "",
    ]
    return "\n".join(lines)


def write_classify_record(
    perm_dir: Optional[Path],
    system_prompt: str,
    user_prompt: str,
    verdicts: List[Any],
) -> Optional[Path]:
    """Persist the full context of one safety-classifier judgement (system + user prompt)
    along with its verdicts and return the path; a missing perm_dir or a write failure
    returns None (never affecting the judgement). In auto mode every judgement is written
    (including ones that judge allow and pass straight through); the filename uses a
    timestamp because request_id does not exist yet at judgement time."""
    if perm_dir is None:
        return None
    try:
        now = datetime.now()
        name = f"classify-{now.strftime('%Y%m%d_%H%M%S_%f')}.md"
        perm_dir.mkdir(parents=True, exist_ok=True)
        path = perm_dir / name
        path.write_text(
            _render_classify(now.strftime("%Y-%m-%d %H:%M:%S"), system_prompt, user_prompt, verdicts),
            encoding="utf-8",
        )
        return path
    except OSError as exc:
        logger.warning("[audit] failed to write classifier judgement record: %s", exc)
        return None


def _render_verdict(now: str, mode: str, records: List[Dict[str, Any]]) -> str:
    """A whole batch of permission verdicts → markdown: the verdict table (decision flags
    → final verdict) plus the full arguments of each call."""
    lines = [
        "# Permission verdict record",
        "",
        f"- Time: {now}",
        f"- Execution mode: {mode}",
        f"- Calls: {len(records)}",
        "",
        "| # | Tool | Capability | Boundary | Flags | Classified | Verdict | Reason |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for i, r in enumerate(records):
        flags = ",".join(
            name for name, on in (
                ("Sensitive", r.get("sensitive")),
                ("hard_deny", r.get("hard_deny")),
                ("Uncertain deletion", r.get("uncertain")),
            ) if on
        ) or "-"
        reason = (str(r.get("reason", "") or "").replace("|", "\\|")) or "-"
        classified = "Yes" if r.get("classified") else "No"
        lines.append(
            f"| {i} | {r.get('tool', '')} | {r.get('capability', '')} | {r.get('boundary', '')} "
            f"| {flags} | {classified} | {r.get('verdict', '')} | {reason} |"
        )
    lines += ["", "## Call details (full arguments)", ""]
    for i, r in enumerate(records):
        lines += [f"### [{i}] {r.get('tool', '')}", "", "```", _command_text(r.get("arguments")), "```", ""]
    return "\n".join(lines)


def write_verdict_record(
    perm_dir: Optional[Path],
    mode: str,
    records: List[Dict[str, Any]],
) -> Optional[Path]:
    """Persist a whole batch of permission verdicts in full (every call that went through
    the engine, whatever the allow/ask/deny outcome) and return the path; a missing
    perm_dir / no calls / a write failure returns None (never affecting the verdict). The
    filename uses a timestamp."""
    if perm_dir is None or not records:
        return None
    try:
        now = datetime.now()
        name = f"verdict-{now.strftime('%Y%m%d_%H%M%S_%f')}.md"
        perm_dir.mkdir(parents=True, exist_ok=True)
        path = perm_dir / name
        path.write_text(_render_verdict(now.strftime("%Y-%m-%d %H:%M:%S"), mode, records), encoding="utf-8")
        return path
    except OSError as exc:
        logger.warning("[audit] failed to write permission verdict record: %s", exc)
        return None
