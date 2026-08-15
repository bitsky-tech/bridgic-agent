"""Session-level routing summary + the user decision ledger — where every tool call in
this session went, and how a human ruled on it.

Complementary to ``_audit``'s per-batch ``verdict-*.md``: this module accumulates each
call's routing result (sent to the model / no approval needed / settled by the rule
layer) into one quickly consumable per-session summary. The source of truth is the
append-only ``_routing.jsonl``; the view is ``_routing_summary.md``, rewritten per batch.
Any write failure only logs a WARNING and never affects the verdict (the same
side-channel semantics as auditing).

**The same jsonl also carries the user's approval decisions** (``category ==
USER_DECISION``): after the user clicks allow or deny, a line is appended carrying the
**full command** and the call signature. It is the single source of truth for "don't
ask again about something already approved" — it lives here rather than being assembled
from the session object because ``_resume_permission`` ends with
``session.without_last()``, which removes the parked round, so this round's decision
would never be readable along that path. An append-only file is immune to that
lifecycle, and it stores the full text without truncation.

Like ``_audit``, the summary's scaffolding is English only — it is a diagnostic artefact
rather than product surface, and the rows it frames are English data (tool names, verdict
enum values, raw commands).
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_ROUTING_LOG = "_routing.jsonl"
_ROUTING_SUMMARY = "_routing_summary.md"
# Storage cap for the command on a decision row: it gets fed into the classifier prompt, so a
# single write_file body must not blow up the context. The signature (see call_signature) is
# computed from the full arguments, so truncation does not affect exact matching.
_DISPLAY_LIMIT = 2000

CLASSIFIED = "classified"        # went through model review
AUTO_PASS = "auto_pass"          # allowed outright by the rule layer = no approval needed
RULE_TERMINAL = "rule_terminal"  # rule layer decided ask/deny without the model
USER_DECISION = "user_decision"  # the user's final ruling on one approval (allow/deny) — not a routing result


def routing_category(classified: bool, verdict: str) -> str:
    """Bucket one verdict into one of three categories.

    * ``classified`` — went through model review (whatever the final verdict).
    * ``auto_pass`` — not classified and verdict=allow: allowed outright by the rule
      layer = no approval needed.
    * ``rule_terminal`` — not classified and verdict in {ask, deny}: settled by the rule
      layer without the model.
    """
    if classified:
        return CLASSIFIED
    if verdict == "allow":
        return AUTO_PASS
    return RULE_TERMINAL


def call_signature(tool: str, arguments: Any) -> str:
    """The **exact** signature of one call: the tool name plus a short hash of the
    canonicalised JSON of all its arguments.

    Deliberately does no normalisation (no whitespace folding, no argument stripping, no
    semantics) — only "completely identical" counts as the same thing. Approximate calls
    (a different filename / an extra argument / rewritten as a script) are not allowed
    through here; they fall to the classifier, which judges "same kind" with the
    [decisions made this session] context. Better to ask once more than to extend an
    authorisation the user granted to an operation they did not.

    A hash rather than the raw text: ``write_file``'s ``content`` can be several MB, and
    recording it verbatim would blow up the file.
    """
    try:
        canonical = json.dumps(arguments, ensure_ascii=False, sort_keys=True, default=str)
    except (TypeError, ValueError):
        canonical = repr(arguments)
    return hashlib.sha256(f"{tool}\x00{canonical}".encode("utf-8")).hexdigest()[:16]


def _display_text(arguments: Any) -> str:
    """The target text on a decision row, for humans and for the classifier; entries with
    a ``command`` use it verbatim, everything else is serialised.

    Past :data:`_DISPLAY_LIMIT` it **keeps both ends**: for a heredoc-shaped command
    (``python3 - <<'PY' … base64 … PY``, where the real work comes after) the first N
    characters are all wrapper, so keeping only the head cuts the intent away — which is
    one of the causes of "I just approved that and it asked again".
    """
    if isinstance(arguments, dict) and isinstance(arguments.get("command"), str):
        text = arguments["command"]
    else:
        try:
            text = json.dumps(arguments, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            text = str(arguments)
    text = text.strip()
    if len(text) <= _DISPLAY_LIMIT:
        return text
    head = _DISPLAY_LIMIT // 4
    tail = _DISPLAY_LIMIT - head
    return (
        f"{text[:head]}\n"
        f"…({len(text) - _DISPLAY_LIMIT} characters omitted)…\n"
        f"{text[-tail:]}"
    )


def append_user_decisions(perm_dir: Optional[Path], items: List[Dict[str, Any]]) -> None:
    """Append the user's final allow/deny for a batch of approval items to
    ``_routing.jsonl``.

    ``items`` has the shape of ``RoundPermission.items`` (tool / arguments / capability /
    boundary / label / summary / decision / instruction). Items missing ``tool`` or
    ``decision`` are skipped. A write failure only logs a WARNING — decision memory is a
    UX optimisation and must never affect the approval flow itself.
    """
    if perm_dir is None or not items:
        return
    rows = [
        {
            "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "category": USER_DECISION,
            "tool": str(it.get("tool") or ""),
            "signature": call_signature(str(it.get("tool") or ""), it.get("arguments")),
            "command": _display_text(it.get("arguments")),
            "capability": str(it.get("capability") or ""),
            "boundary": str(it.get("boundary") or ""),
            "label": str(it.get("label") or ""),
            "label_id": str(it.get("label_id") or ""),
            "summary": str(it.get("summary") or ""),
            "decision": str(it.get("decision") or ""),
            "instruction": str(it.get("instruction") or ""),
        }
        for it in items
        if isinstance(it, dict) and it.get("tool") and it.get("decision") in ("allow", "deny")
    ]
    if not rows:
        return
    try:
        perm_dir.mkdir(parents=True, exist_ok=True)
        with (perm_dir / _ROUTING_LOG).open("a", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception as exc:  # noqa: BLE001 — side-channel record: no failure may affect the approval flow
        logger.warning("[routing] failed to append user decisions: %s", exc)


def read_user_decisions(perm_dir: Optional[Path]) -> List[Dict[str, Any]]:
    """Read this session's user decision rows in write order; a missing directory / file
    or a read failure → an empty list."""
    if perm_dir is None:
        return []
    log_path = perm_dir / _ROUTING_LOG
    try:
        if not log_path.is_file():
            return []
        return [r for r in _read_rows(log_path) if r.get("category") == USER_DECISION]
    except Exception as exc:  # noqa: BLE001 — failing to read only costs one piece of context; it must not interrupt the verdict
        logger.warning("[routing] failed to read user decisions: %s", exc)
        return []


def approved_signatures(perm_dir: Optional[Path]) -> frozenset:
    """The set of call signatures the user **explicitly allowed** in this session.

    Only ``allow`` is collected: ``deny`` is not turned into a deterministic block — the
    user may change their mind, and auto-denying would deadlock the task, while "it was
    denied last time" is still fed to the classifier as text for reference. When the same
    signature is allowed and then denied, the **last** occurrence wins (replayed in file
    order).
    """
    latest: Dict[str, str] = {}
    for row in read_user_decisions(perm_dir):
        signature = str(row.get("signature") or "")
        decision = str(row.get("decision") or "")
        if signature and decision in ("allow", "deny"):
            latest[signature] = decision
    return frozenset(sig for sig, decision in latest.items() if decision == "allow")


def append_routing(perm_dir: Optional[Path], records: List[Dict[str, Any]]) -> None:
    """Append each routing result of this batch to the session-level ``_routing.jsonl``
    (one JSON object per line); a missing perm_dir / no records / a write failure → silent
    (WARNING only), never affecting the verdict."""
    if perm_dir is None or not records:
        return
    try:
        perm_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with (perm_dir / _ROUTING_LOG).open("a", encoding="utf-8") as handle:
            for r in records:
                handle.write(json.dumps({"ts": ts, **r}, ensure_ascii=False) + "\n")
    except Exception as exc:  # noqa: BLE001 — side-channel record: no failure may affect the verdict
        logger.warning("[routing] failed to append the routing log: %s", exc)


def render_summary(perm_dir: Optional[Path]) -> Optional[Path]:
    """Aggregate the whole ``_routing.jsonl``, overwrite ``_routing_summary.md`` and
    return its path; a missing perm_dir / absent log / failure → None (never affecting the
    verdict)."""
    if perm_dir is None:
        return None
    log_path = perm_dir / _ROUTING_LOG
    if not log_path.is_file():
        return None
    try:
        rows = _read_rows(log_path)
        out = perm_dir / _ROUTING_SUMMARY
        out.write_text(_render(rows), encoding="utf-8")
        return out
    except Exception as exc:  # noqa: BLE001 — side-channel record: no failure may affect the verdict
        logger.warning("[routing] failed to render the routing summary: %s", exc)
        return None


def _read_rows(log_path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    dropped = 0
    for line in log_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            dropped += 1
            continue  # bad JSON: tolerated, so one line cannot ruin the whole summary
        if isinstance(obj, dict):
            rows.append(obj)
        else:
                dropped += 1  # valid JSON but not an object: dropped, so _render never calls .get() on a non-dict row
    if dropped:
        logger.warning("[routing] skipped %d bad / non-object log rows while summarising", dropped)
    return rows


def _render(rows: List[Dict[str, Any]]) -> str:
    by_cat: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_cat[r.get("category", "")].append(r)
    # User decision rows live in this same file but are **not routing results**, so they must not
    # count towards "total calls" — otherwise one approval would conjure N extra rows into the
    # statistics and distort the auto_pass ratio.
    routed = len(rows) - len(by_cat[USER_DECISION])
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = [
        "# Permission routing summary (session)",
        "",
        f"- Updated: {now}",
        f"- Total calls: {routed}",
        f"- Model review: {len(by_cat[CLASSIFIED])} / No approval needed: {len(by_cat[AUTO_PASS])}"
        f" / Rule-layer decision: {len(by_cat[RULE_TERMINAL])}",
    ]
    lines += _render_classified(by_cat[CLASSIFIED])
    lines += _render_auto_pass(by_cat[AUTO_PASS])
    lines += _render_rule_terminal(by_cat[RULE_TERMINAL])
    lines += _render_user_decisions(by_cat[USER_DECISION])
    return "\n".join(lines) + "\n"


def _render_classified(rows: List[Dict[str, Any]]) -> List[str]:
    lines = ["", f"## Model review (classified): {len(rows)}", ""]
    if not rows:
        return lines + ["(None)"]
    lines += [
        "> Duration is for the **whole batch** classifier call (multiple rows share one LLM call), "
        "not an individual row.",
        "",
        "| Tool | Calls | allow/ask/deny | Batch avg ms | Batch peak ms |",
        "| --- | --- | --- | --- | --- |",
    ]
    agg: Dict[str, Dict[str, Any]] = defaultdict(
        lambda: {"n": 0, "allow": 0, "ask": 0, "deny": 0, "ms": []}
    )
    for r in rows:
        a = agg[str(r.get("tool", ""))]
        a["n"] += 1
        v = r.get("verdict", "")
        if v in ("allow", "ask", "deny"):
            a[v] += 1
        ms = r.get("batch_elapsed_ms")
        if isinstance(ms, (int, float)) and not isinstance(ms, bool):
            a["ms"].append(ms)
    for tool, a in sorted(agg.items(), key=lambda kv: -kv[1]["n"]):
        ms = a["ms"]
        avg = round(sum(ms) / len(ms)) if ms else 0
        mx = round(max(ms)) if ms else 0
        lines.append(f"| {tool} | {a['n']} | {a['allow']}/{a['ask']}/{a['deny']} | {avg} | {mx} |")
    return lines


def _render_auto_pass(rows: List[Dict[str, Any]]) -> List[str]:
    lines = ["", f"## No approval needed (auto_pass): {len(rows)}", ""]
    if not rows:
        return lines + ["(None)"]
    lines += ["| Tool | Calls |", "| --- | --- |"]
    counts: Dict[str, int] = defaultdict(int)
    for r in rows:
        counts[str(r.get("tool", ""))] += 1
    for tool, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        lines.append(f"| {tool} | {n} |")
    return lines


def _render_user_decisions(rows: List[Dict[str, Any]]) -> List[str]:
    """The user approval trail: which operations this person allowed or denied. The source
    of the in-session explanation for "why it didn't ask me this time"."""
    lines = ["", f"## User approval decisions (user_decision): {len(rows)}", ""]
    if not rows:
        return lines + ["(None)"]
    lines += ["| Time | Tool | Decision | Target |", "| --- | --- | --- | --- |"]
    for r in rows:
        mark = "✅ Allowed" if r.get("decision") == "allow" else "⛔ Denied"
        target = str(r.get("command", "") or "").replace("|", "\\|").replace("\n", " ")[:120]
        lines.append(f"| {r.get('ts', '')} | {r.get('tool', '')} | {mark} | {target} |")
    return lines


def _render_rule_terminal(rows: List[Dict[str, Any]]) -> List[str]:
    lines = ["", f"## Rule-layer decision (rule_terminal): {len(rows)}", ""]
    if not rows:
        return lines + ["(None)"]
    lines += ["| Tool | Verdict | Calls |", "| --- | --- | --- |"]
    counts: Dict[tuple, int] = defaultdict(int)
    for r in rows:
        counts[(str(r.get("tool", "")), str(r.get("verdict", "")))] += 1
    for (tool, verdict), n in sorted(counts.items(), key=lambda kv: -kv[1]):
        lines.append(f"| {tool} | {verdict} | {n} |")
    return lines
