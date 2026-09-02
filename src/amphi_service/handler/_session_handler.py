import asyncio
import ast
import json
import os
from datetime import timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from fastapi import HTTPException, Response, status

from ...amphi_agent import WorkflowPackage
from ...amphi_agent._workflow_run import RunWorkflow
from ...amphi_agent._workspace import Workspace
from ..i18n import backend_i18n
from ..protocol import CreateSessionRequest, RenameSessionRequest
from ...amphi_store import (
    SessionRecord,
    SessionRepository,
    SessionStatus,
    SubAgentMode,
    SessionTurnRecord,
    SessionTurnRepository,
    SessionTurnSummary,
    TurnStatus,
    UserInput,
)
from ._base import BaseHandler


_SubagentProjection = tuple[str, Optional[SessionTurnRecord], str]


def session_summary(record: SessionRecord, summary: SessionTurnSummary) -> dict:
    """Shape a session row into the ``/sessions`` list entry."""
    return {
        "id": record.id,
        "model": record.last_used_model or "",
        "workspace_root": record.workspace_root,
        "tokens": summary.tokens,
        "status": _session_status(record, summary),
        "turn_status": (
            summary.latest_status.value if summary.latest_status is not None else None
        ),
        "parent_session_id": record.parent_session_id,
        "subagent_mode": record.subagent_mode.value if record.subagent_mode is not None else None,
        "last_answer_preview": record.last_answer[:80] if record.last_answer else None,
        "title": record.title or (summary.first_user_input or "")[:80],
    }


def session_detail(record: SessionRecord, summary: SessionTurnSummary) -> dict:
    """Shape a session row into the ``/sessions/{id}`` detail body."""
    return {
        "id": record.id,
        "model": record.last_used_model or "",
        "workspace_root": record.workspace_root,
        "tokens": summary.tokens,
        "status": _session_status(record, summary),
        "turn_status": (
            summary.latest_status.value if summary.latest_status is not None else None
        ),
        "parent_session_id": record.parent_session_id,
        "subagent_mode": record.subagent_mode.value if record.subagent_mode is not None else None,
        "last_answer": record.last_answer,
    }


def _session_status(record: SessionRecord, summary: SessionTurnSummary) -> str:
    """Project an internally parked Child join as continued Agent execution."""
    if summary.latest_status is TurnStatus.AWAITING_SUBAGENTS:
        return "running"
    return record.status.value


class SessionDuplicateHandler(BaseHandler):
    """Bind: ``POST /sessions/{session_id}/duplicate`` — copy the whole thing into a new
    USER Session.

    Continuing the conversation only accepts a Run Session in ``finish`` /
    ``completed``. It creates a new ``kind=USER`` root Session (with its own fresh
    workspace), copies the Session tree's projection, the Workflow association, the
    turns and the workspace directory except the legacy root ``.venv``, and shows up in
    the ``GET /sessions`` list.
    """

    tags = ["sessions"]

    async def post(self, session_id: str) -> Response:
        user = await self.require_user()
        source = await self.require_session(session_id, user)
        turns = SessionTurnRepository()
        source_summary = await turns.load_summary(source)
        if (
            source.status not in {SessionStatus.COMPLETED, SessionStatus.FINISH}
            or source_summary.latest_status is None
            or not source_summary.latest_status.is_terminal
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=backend_i18n.text("session.duplicate.only_finished"),
            )
        source_tree = await SessionRepository().list_tree(user.id, source.id)
        for record in source_tree:
            self.require_no_running_turn(record.id)
        try:
            record = await self.sessions.duplicate(source)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=str(exc),
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=backend_i18n.text("session.duplicate.failed", detail=exc),
            ) from exc
        summary = await turns.load_summary(record)
        return self.response(session_detail(record, summary), status_code=status.HTTP_201_CREATED)


class SessionListHandler(BaseHandler):
    """Bind: ``GET /sessions`` (list current user's), ``POST`` (create)."""

    tags = ["sessions"]

    async def post(self, body: CreateSessionRequest) -> Response:
        user = await self.require_user()
        try:
            record = await self.sessions.create_root(
                user.id, model=body.model or user.current_model,
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=backend_i18n.text("session.create.failed", detail=exc),
            ) from exc
        return self.response(
            session_detail(record, SessionTurnSummary()),
            status_code=status.HTTP_201_CREATED,
        )

    async def get(self, limit: Optional[int] = None, offset: int = 0) -> Response:
        user = await self.require_user()
        # Pagination is optional; limit applies to root sessions, and child
        # sessions come on the same page as their parent.
        rows = await SessionRepository().list_sidebar(user.id, limit=limit, offset=offset)
        summaries = await SessionTurnRepository().load_summaries(rows)
        return self.response([
            session_summary(record, summaries[record.id])
            for record in rows
        ])


class SessionDetailHandler(BaseHandler):
    """Bind: ``GET`` / ``PATCH`` / ``DELETE`` on ``/sessions/{session_id}``."""

    tags = ["sessions"]

    async def get(self, session_id: str) -> Response:
        user = await self.require_user()
        record = await self.require_session(session_id, user)
        summary = await SessionTurnRepository().load_summary(record)
        return self.response(session_detail(record, summary))

    async def patch(self, session_id: str, body: RenameSessionRequest) -> Response:
        user = await self.require_user()
        # Column-only UPDATE — never a full save, so it won't re-serialise (or
        # race) the history of an in-flight turn.
        record = await self.require_session(session_id, user)
        await SessionRepository().rename(session_id, user.id, body.title)
        record.title = body.title
        summary = await SessionTurnRepository().load_summary(record)
        return self.response(session_summary(record, summary))

    async def delete(self, session_id: str) -> Response:
        user = await self.require_user()
        record = await self.require_session(session_id, user)
        tree = await SessionRepository().list_tree(user.id, record.id)
        removed = await self.invocations.remove_session_tree(session_id)
        if not removed:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=backend_i18n.text(
                    "session.delete.not_registered", session_id=session_id,
                ),
            )
        await self.sessions.clear_attachments(tree)
        return self.response(status_code=status.HTTP_204_NO_CONTENT)


class SessionMessagesHandler(BaseHandler):
    """Bind: ``GET /sessions/{session_id}/messages``.

    The session's full transcript as frontend ``AgentMessage`` dicts — the
    daemon is the source of truth, so the GUI hydrates from here rather than
    from local storage.
    """

    tags = ["sessions"]

    async def get(
        self,
        session_id: str,
        before_ordinal: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> Response:
        user = await self.require_user()
        record = await self.require_session(session_id, user)
        repository = SessionTurnRepository()
        # No params → full transcript (back-compat). With `limit`, the newest
        # page below `before_ordinal`; `has_more` + `next_before` let clients
        # walk older pages.
        turns = await repository.list_conversation(
            user.id, record.id, before_ordinal=before_ordinal, limit=limit,
        )
        has_more = bool(turns) and limit is not None and await repository.list_conversation(
            user.id, record.id,
            before_ordinal=turns[0].session_ordinal, limit=1,
        ) != []
        # Only the tail page carries trailing-turn projections: an older page's
        # last turn is mid-history, so pending/thinking would be wrong there.
        is_tail_page = before_ordinal is None
        children = await SessionRepository().list_children(user.id, record.id)
        child_turns = await asyncio.gather(*(
            repository.latest(child.id, user.id) for child in children
        ))
        subagents: Dict[str, List[_SubagentProjection]] = {}
        for child, turn in zip(children, child_turns):
            if child.parent_call_id and child.subagent_mode is not SubAgentMode.BACKGROUND:
                subagents.setdefault(child.parent_call_id, []).append(
                    (child.id, turn, child.title or ""),
                )
        child_turn_by_id = {
            child.id: turn
            for child, turn in zip(children, child_turns)
        }

        def child_status(child: SessionRecord) -> str:
            turn = child_turn_by_id.get(child.id)
            return turn.status.value if turn is not None else "unknown"

        return self.response({
            "messages": session_to_agent_messages(
                session_id,
                turns,
                subagents,
                show_pending_interaction=(
                    is_tail_page and record.status is SessionStatus.AWAITING
                ),
            ),
            # Keep the parked Turn durable until its resumed Invocation settles,
            # but do not replay its question after AgentInvocation accepted the
            # answer and cleared the Session's awaiting projection.
            "pending_request": (
                _pending_request(turns)
                if is_tail_page and record.status is SessionStatus.AWAITING
                else None
            ),
            "has_more": has_more,
            "next_before": turns[0].session_ordinal if turns else None,
            "context_usage": _context_usage(turns) if is_tail_page else None,
            # The trailing turn's thinking position and active Workflow card.
            "thinking_mode": _thinking_mode(turns) if is_tail_page else None,
            "workflow_run": (
                self._workflow_run_snapshot(record)
                if is_tail_page else None
            ),
            # For the "session hierarchy" pane on the left of the run-detail dialog: this
            # session's background sub-Agents (independent Child Sessions,
            # fire-and-forget, not projected into the transcript, hence listed
            # separately). status uses the latest Turn's exact status; with no Turn we
            # do not guess the interaction semantics.
            "children": [
                {
                    "session_id": child.id,
                    "title": child.title or backend_i18n.text("session.child_default_title"),
                    "subagent_mode": (
                        child.subagent_mode.value if child.subagent_mode else None
                    ),
                    "status": child_status(child),
                }
                for child in children
                if child.subagent_mode is SubAgentMode.BACKGROUND
            ],
        })

    @staticmethod
    def _workflow_run_snapshot(record: SessionRecord) -> Optional[Dict[str, Any]]:
        """Read the active Workflow card without recovering or binding its Space."""
        workspace = Workspace(record.id, session_root=Path(record.workspace_root))
        checkpoint = workspace.run_workflow_checkpoint()
        if checkpoint is None:
            return None
        try:
            workflow_id = checkpoint.workflow_id
            workflow_name = checkpoint.workflow_name
            run = RunWorkflow(workspace.run_workflow_root)
            if not run.is_available:
                return None
            source = WorkflowPackage(
                run.source_dir,
                workflow_id=workflow_id,
                name=workflow_name,
            )
            reason = source.validation_reason()
            if reason:
                raise ValueError(reason)
            execution_steps = [step.title for step in source.execution_steps]
            validation_steps = [step.title for step in source.validation_steps]
            if workspace.run_workflow_checkpoint() != checkpoint:
                return None
        except (FileNotFoundError, OSError, RuntimeError, UnicodeError, ValueError):
            return None
        return {
            "workflow_id": workflow_id,
            "generation": checkpoint.generation,
            "workflow_name": workflow_name,
            "source_session_id": record.parent_session_id or record.id,
            "phase": checkpoint.stage,
            "step_index": checkpoint.step_index,
            "execution_steps": execution_steps,
            "validation_steps": validation_steps,
        }


class SessionFileHandler(BaseHandler):
    """Bind: ``GET /sessions/{session_id}/files?path=<relative>``.

    Reads one file under the session's workspace verbatim — the GUI renders
    ``.work/.build/task.md`` as the build brief from this (and later the other stage
    artifacts as read-only previews). Containment is fail-closed: the resolved
    real path must stay inside the workspace root, mirroring the @mention
    resolution rule in ``render_input`` (amphi_agent/_cognitive.py).
    """

    tags = ["sessions"]

    async def get(self, session_id: str, path: str = "") -> Response:
        user = await self.require_user()
        record = await self.require_session(session_id, user)
        rel = (path or "").strip()
        if not rel or os.path.isabs(rel):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=backend_i18n.text("session.file.path_required"),
            )
        root = os.path.realpath(record.workspace_root or "")
        candidate = os.path.realpath(os.path.join(root, rel))
        if not record.workspace_root or not candidate.startswith(root + os.sep):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=backend_i18n.text("session.file.path_escapes"),
            )
        if not os.path.isfile(candidate):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=backend_i18n.text(
                    "session.file.not_found", path=rel, session_id=session_id,
                ),
            )
        # Never 500 on odd bytes — the GUI shows text; lossy decode is fine.
        content = Path(candidate).read_bytes().decode("utf-8", errors="replace")
        return self.response({"path": rel, "content": content})


############################################################################
# Transcript derivation — Session Turn records → AgentMessage dicts
############################################################################

def session_to_agent_messages(
    session_id: str,
    turns: Sequence[SessionTurnRecord],
    subagents: Optional[Dict[str, List[_SubagentProjection]]] = None,
    *,
    show_pending_interaction: bool = True,
) -> List[dict]:
    """Rebuild a session transcript from its ordered top-level Turns.

    Each Turn becomes its root ``user`` message and one logical ``assistant``
    reply. Intermediate interactions stay inside that reply as process blocks.
    """
    messages: List[dict] = []
    seq = 0
    last = len(turns) - 1
    for page_idx, turn_record in enumerate(turns):
        # id/seq are based on the global session_ordinal, not the in-page index: with
        # cursor pagination every page enumerates from 0, so in-page ids would collide
        # across pages (duplicate React keys, the frontend head guard stops working).
        idx = turn_record.session_ordinal
        is_last = page_idx == last
        ota = turn_record.ota_context_dump()
        messages.append(_user_message(
            session_id,
            idx,
            turn_record.id,
            turn_record.user_input,
            seq,
        ))
        seq += 1
        turn = _turn_messages(
            session_id,
            idx,
            turn_record,
            seq,
            is_last=is_last,
            subagents=subagents or {},
            show_pending_interaction=show_pending_interaction,
        )
        messages.extend(turn)
        seq += len(turn)
        err = None
        if turn_record.status is TurnStatus.FAILED:
            err = turn_record.error or ota.get("turn_error")
        if err:
            assistant = next(
                (message for message in reversed(turn) if message["role"] == "assistant"),
                None,
            )
            if assistant is not None:
                assistant["error"] = str(err)
            else:
                messages.append(_error_message(
                    session_id,
                    idx,
                    turn_record.id,
                    str(err),
                    seq,
                    model=turn_record.model,
                    execution_mode=turn_record.execution_mode,
                ))
                seq += 1
        elif turn_record.status is TurnStatus.CANCELLED:
            assistant = next(
                (message for message in reversed(turn) if message["role"] == "assistant"),
                None,
            )
            if assistant is not None:
                assistant["stopped"] = True
            else:
                cancelled_message = {
                    "id": f"{session_id}:{idx}",
                    "turnId": turn_record.id,
                    "role": "assistant",
                    "text": "",
                    "blocks": [],
                    "toolCalls": [],
                    "done": True,
                    "stopped": True,
                    "finalAnswer": "",
                    "createdAt": seq,
                }
                if turn_record.model is not None:
                    cancelled_message["model"] = turn_record.model
                if turn_record.execution_mode is not None:
                    cancelled_message["executionMode"] = turn_record.execution_mode
                messages.append(cancelled_message)
                seq += 1
    return messages


def _user_message(
    session_id: str,
    idx: int,
    turn_id: str,
    user_input: UserInput,
    seq: int,
) -> dict:
    return {
        "id": f"{session_id}:u{idx}",
        "turnId": turn_id,
        "role": "user",
        "text": user_input.text,
        "blocks": _user_blocks(user_input.blocks),
        "toolCalls": [],
        "done": True,
        "createdAt": seq,
    }


def _error_message(
    session_id: str,
    idx: int,
    turn_id: str,
    message: str,
    seq: int,
    *,
    model: Optional[str] = None,
    execution_mode: Optional[str] = None,
) -> dict:
    """A failed agent turn → an assistant error bubble — mirrors the live
    ``error`` frame (``error`` set, no text). The UI shows this internal error
    separately; persisted Agent messages from the failed Turn remain in context."""
    error_message = {
        "id": f"{session_id}:{idx}.err",
        "turnId": turn_id,
        "role": "assistant",
        "text": "",
        "error": message,
        "blocks": [],
        "toolCalls": [],
        "done": True,
        "createdAt": seq,
    }
    if model is not None:
        error_message["model"] = model
    if execution_mode is not None:
        error_message["executionMode"] = execution_mode
    return error_message


def _user_blocks(input_blocks: List[dict]) -> List[dict]:
    """Map stored ChatBlock dicts → frontend ``MessageBlock`` dicts.

    Text blocks rename ``value`` → ``text``; mention / slash pass through.
    Unknown types are dropped.
    """
    out: List[dict] = []
    for b in input_blocks:
        t = b.get("type")
        if t == "text":
            out.append({"type": "text", "text": b.get("value", "")})
        elif t == "mention":
            block = {
                "type": "mention",
                "id": b.get("id", ""),
                "label": b.get("label", ""),
                "group": b.get("group", ""),
            }
            # ``path`` (the mount-relative path) is part of the identity of an @ file
            # chip. It used not to be passed through here, so the path stored in the DB
            # was lost by the time it reached the frontend — and when the composer
            # recalled history with ↑ it could no longer rebuild an interactive chip.
            # Only included when non-empty, keeping the old payload shape.
            if b.get("path"):
                block["path"] = b["path"]
            out.append(block)
        elif t == "slash":
            block = {"type": "slash", "id": b.get("id", ""), "label": b.get("label", "")}
            if b.get("resource") in {"workflow", "schedule"}:
                block["resource"] = b["resource"]
            out.append(block)
    return out


def _workflow_entry_succeeded(step: dict, payload: Dict[str, Any]) -> bool:
    """Return whether one historical control call entered a Workflow Run."""
    if step.get("success") is False:
        return False
    status = str(payload.get("status") or payload.get("resolved_action") or "")
    if status in {"started", "resumed", "restarted"}:
        return True
    if status == "resolved" and payload.get("action") in {"resume", "restart"}:
        return True

    # Older traces may only retain the requested action. Fail closed for an
    # unresolved ``ask`` and for every explicit non-entry terminal state.
    if status in {"pending", "failed", "not_answered"}:
        return False
    arguments = step.get("tool_arguments") or {}
    return arguments.get("action") in {"start", "resume", "restart"}


def _workflow_steps_before_content(
    blocks: List[dict],
    spans: Sequence[tuple[int, int]],
) -> List[dict]:
    """Rotate completed Workflow markers before their historical process blocks.

    Live ``workflow_progress`` opens a section with ``running`` and later updates
    that same marker to ``success`` or ``failure``. Persisted traces retain only
    the terminal ``report_workflow_step`` action, so their marker is discovered
    after all OTA rounds for the section. ``spans`` records those stable report
    boundaries; rotating each ``content ... marker`` range restores the live
    ordering without changing any block payload or unreported tail content.
    """
    if not spans:
        return blocks
    ordered: List[dict] = []
    cursor = 0
    for content_start, marker_index in spans:
        if content_start < cursor or marker_index < content_start or marker_index >= len(blocks):
            continue
        ordered.extend(blocks[cursor:content_start])
        ordered.append(blocks[marker_index])
        ordered.extend(blocks[content_start:marker_index])
        cursor = marker_index + 1
    ordered.extend(blocks[cursor:])
    return ordered


def _turn_messages(
    session_id: str,
    idx: int,
    turn: SessionTurnRecord,
    seq: int,
    *,
    is_last: bool,
    subagents: Dict[str, List[_SubagentProjection]],
    show_pending_interaction: bool,
) -> List[dict]:
    """Project one Session Turn into one assistant reply with interaction blocks."""
    ota = turn.ota_context_dump()
    blocks: List[dict] = []
    current_calls: List[dict] = []
    workflow_step_spans: List[tuple[int, int]] = []
    workflow_content_start: Optional[int] = None
    workflow_fallback_start = 0
    t_idx = 0
    active_build_stage: Optional[str] = None
    state = ota.get("state") or {}
    interaction = state.get("interaction") if isinstance(state, dict) else None
    think_state = state.get("think") if isinstance(state, dict) else None
    edit_workflow_id = (
        str(think_state.get("workflow_id"))
        if isinstance(think_state, dict)
        and think_state.get("mode") == "build"
        and think_state.get("workflow_id")
        else None
    )
    open_questions = (
        interaction.get("questions") or []
        if is_last and isinstance(interaction, dict)
        else []
    )
    open_choice = bool(open_questions)

    def should_show_interaction_block(block: dict) -> bool:
        return block.get("status") != "pending" or (is_last and show_pending_interaction)

    def confirmation_reply(payload: Any, question: str) -> Optional[dict]:
        if (
            not isinstance(payload, dict)
            or payload.get("status") != "not_answered"
            or not str(payload.get("user_message") or "").strip()
        ):
            return None
        return {
            "type": "confirmation",
            "kind": "confirmation_message",
            "question": question,
            "response": str(payload["user_message"]),
        }

    def remove_trailing_question(question: str) -> None:
        for block_index in range(len(blocks) - 1, -1, -1):
            block = blocks[block_index]
            if block.get("type") != "text":
                continue
            text = str(block.get("text") or "").rstrip()
            if text.endswith(question):
                remaining = text[:-len(question)].rstrip()
                if remaining:
                    blocks[block_index] = {"type": "text", "text": remaining}
                else:
                    blocks.pop(block_index)
            break

    def child_block(child_id: str, child_turn: Optional[SessionTurnRecord], goal: str = "") -> dict:
        block = {
            "invocationId": child_id,
            "goal": child_turn.user_input.text if child_turn is not None else goal,
            "status": child_turn.status.value if child_turn is not None else "running",
            "answer": child_turn.final_answer if child_turn is not None else None,
        }
        if child_turn is not None and child_turn.error:
            block["error"] = child_turn.error
        return block

    for round_ in ota.get("ota_record") or []:
        entered_workflow = False
        workflow_report_index: Optional[int] = None
        workflow_report_terminal = False
        # Every new cognitive round records its source mode and stage before
        # thinking. Build rounds project that generic scope into the existing UI
        # headings; older persisted rounds retain the legacy build_stage field.
        if isinstance(round_, dict) and (
            isinstance(round_.get("think_scope"), dict)
            or "build_stage" in round_
        ):
            scope = round_.get("think_scope")
            if isinstance(scope, dict):
                build_stage = (
                    str(scope.get("stage") or "").strip() or None
                    if scope.get("mode") == "build"
                    else None
                )
            else:
                build_stage = str(round_.get("build_stage") or "").strip() or None
            if build_stage != active_build_stage:
                if build_stage is not None or active_build_stage is not None:
                    blocks.append({"type": "build_stage", "stage": build_stage})
                active_build_stage = build_stage
        # This round's chain-of-thought first (streamed live as ``reasoning``
        # before the answer text) — matches the live block order; without it a
        # reloaded transcript would drop the thinking the GUI shows.
        reasoning = _reasoning_text(round_)
        if reasoning:
            blocks.append({"type": "thinking", "text": reasoning})
        think = (round_ or {}).get("think_result") or {}
        content = (think.get("step_content") or "").strip() if isinstance(think, dict) else ""
        if content:
            blocks.append({"type": "text", "text": content})
        # A decided approval → terminal-state card, placed BEFORE this round's tool
        # cards: the approval happens before execution, so the card sits above the tool
        # it approved (matching the live order: the permission_request event arrives
        # first, the tool resuming afterwards). Follows the REST AgentMessage contract
        # (camelCase, same as the tool card); RoundPermission.items stores snake_case
        # call_index internally, mapped to callIndex on output here.
        perm = (round_ or {}).get("permission") or {}
        if perm.get("reviewed") and perm.get("items"):
            decided_items = [
                {
                    "callIndex": it.get("call_index"),
                    "tool": it.get("tool", ""),
                    "arguments": it.get("arguments") or {},
                    "capability": it.get("capability", ""),
                    "boundary": it.get("boundary", ""),
                    "label": it.get("label", ""),
                    # Plain-language summary: after a refresh / reconnect the historical
                    # card still has to show it, otherwise it falls back to a blob of
                    # raw shell command.
                    "summary": it.get("summary", ""),
                    # Criteria flags (older persisted rows default to False → the
                    # frontend conservatively treats them as "not assessable").
                    "sensitive": it.get("sensitive", False),
                    "deletion": it.get("deletion", False),
                    "regenerable": it.get("regenerable", False),
                    "uncertain_destruction": it.get("uncertain_destruction", False),
                    "touches_risk_surface": it.get("touches_risk_surface", False),
                    "decision": it.get("decision"),
                    "instruction": it.get("instruction"),
                }
                for it in perm.get("items")
            ]
            blocks.append({
                "type": "permission",
                "requestId": None,
                "decided": True,
                "items": decided_items,
                "questions": [],
            })
        # The act phase ran once per round; its wall-clock is shared across the
        # round's tools (mirrors the live ``tool_result.duration_ms``).
        duration_ms = int((round_ or {}).get("act_duration_ms") or 0)
        action = (round_ or {}).get("action_result") or {}
        for step in action.get("results") or []:
            if not isinstance(step, dict):
                continue
            if step.get("tool_name") in {"switch", "complete_run_workflow"}:
                # Internal control-flow — not a user-facing tool (the live stream
                # never publishes it either). Skip so it never leaks as a card.
                continue
            if step.get("tool_name") == "report_workflow_step":
                result = step.get("tool_result")
                if isinstance(result, dict) and result.get("workflow_id"):
                    block = {
                        "type": "workflow_step",
                        "workflowId": str(result.get("workflow_id")),
                        "generation": str(result.get("generation") or ""),
                        "workflowName": str(result.get("workflow_name") or ""),
                        "phase": str(result.get("phase") or "execute"),
                        "stepIndex": int(result.get("step_index") or 0),
                        "stepCount": int(result.get("step_count") or 1),
                        "title": str(result.get("title") or ""),
                        "status": str(result.get("status") or "failure"),
                        "summary": result.get("summary"),
                    }
                    if "execution_steps" in result:
                        block["executionSteps"] = [str(title) for title in result.get("execution_steps") or []]
                    if "validation_steps" in result:
                        block["validationSteps"] = [str(title) for title in result.get("validation_steps") or []]
                    workflow_report_index = len(blocks)
                    workflow_report_terminal = bool(result.get("run_id"))
                    blocks.append(block)
                continue
            if step.get("tool_name") == "request_human_choice":
                arguments = step.get("tool_arguments") or {}
                question = _question_text(arguments)
                prompt = _choice_prompt(arguments)
                answer = step.get("tool_result")
                answer_text = (
                    answer.strip()
                    if step.get("success") is not False and isinstance(answer, str)
                    else ""
                )
                if answer_text:
                    if question:
                        remove_trailing_question(question)
                    block = {
                        "type": "confirmation",
                        "question": question,
                        "response": answer_text,
                    }
                    if prompt:
                        block["prompt"] = prompt
                    blocks.append(block)
                elif not open_choice and question:
                    blocks.append({"type": "text", "text": question})
                continue
            if step.get("tool_name") == "request_run_workflow":
                payload = step.get("tool_result")
                payload = payload if isinstance(payload, dict) else {}
                entered_workflow = _workflow_entry_succeeded(step, payload)
                questions = payload.get("questions") or []
                question = (
                    str(questions[0].get("question") or "")
                    if questions and isinstance(questions[0], dict)
                    else backend_i18n.text("session.workflow_run_choice.fallback_question")
                )
                response = str(
                    payload.get("response") or payload.get("user_message") or "",
                ).strip()
                if payload.get("status") in {
                    "resolved",
                    "not_answered",
                    "failed",
                } and response:
                    block = {
                        "type": "confirmation",
                        "kind": "workflow_run_choice",
                        "question": question,
                        "response": response,
                    }
                    if payload.get("status") == "not_answered":
                        block["kind"] = "confirmation_message"
                    blocks.append(block)
                continue
            if step.get("tool_name") == "request_accept_rule":
                result = step.get("tool_result")
                payload = result if isinstance(result, dict) else {}
                rules = payload.get("rules") or []
                mode = payload.get("mode") or "criteria"
                if payload.get("status") == "confirmed" and (
                    rules or mode == "execution_only"
                ):
                    confirmed_rules = [
                        {
                            "id": str(rule.get("id") or ""),
                            "text": str(rule.get("text") or ""),
                        }
                        for rule in rules
                        if isinstance(rule, dict)
                        and rule.get("id")
                        and rule.get("text")
                    ]
                    response = (
                        backend_i18n.text("session.accept_rule.execution_only.response")
                        if mode == "execution_only"
                        else "\n".join(
                            f"{rule['id']}: {rule['text']}"
                            for rule in confirmed_rules
                        )
                    )
                    blocks.append({
                        "type": "confirmation",
                        "kind": "accept_rule",
                        "question": (
                            backend_i18n.text("session.accept_rule.execution_only.question")
                            if mode == "execution_only"
                            else backend_i18n.text("session.accept_rule.aligned.question")
                        ),
                        "response": response,
                        "rules": confirmed_rules,
                        "acceptanceMode": mode,
                    })
                elif payload.get("status") == "not_answered" and payload.get("user_message"):
                    blocks.append({
                        "type": "confirmation",
                        "kind": "accept_rule_message",
                        "question": backend_i18n.text("session.accept_rule.later.question"),
                        "response": str(payload["user_message"]),
                    })
                continue
            if step.get("tool_name") == "request_build":
                if step.get("success") is not False:
                    payload = step.get("tool_result")
                    payload = payload if isinstance(payload, dict) else {}
                    if payload.get("build_conflict") is True:
                        questions = payload.get("questions") or []
                        question = (
                            str(questions[0].get("question") or "")
                            if questions and isinstance(questions[0], dict)
                            else backend_i18n.text("session.build_conflict.fallback_question")
                        )
                        response = str(
                            payload.get("response") or payload.get("user_message") or "",
                        ).strip()
                        if payload.get("status") in {"resolved", "not_answered"} and response:
                            block = {
                                "type": "confirmation",
                                "question": question,
                                "response": response,
                            }
                            if payload.get("status") == "not_answered":
                                block["kind"] = "confirmation_message"
                            blocks.append(block)
                        continue
                    reply = confirmation_reply(
                        payload,
                        backend_i18n.text("session.workflow_build.confirmation_question"),
                    )
                    if reply is not None:
                        blocks.append(reply)
                        continue
                    if payload["mode"] == "ask":
                        block = {
                            "type": "build_confirm",
                            "requestId": payload["request_id"],
                            "goal": payload["goal"],
                            "reason": payload.get("reason"),
                            "status": payload["status"],
                        }
                        if should_show_interaction_block(block):
                            blocks.append(block)
                continue
            if step.get("tool_name") == "request_human_workflow_confirm":
                reply = confirmation_reply(
                    step.get("tool_result"),
                    backend_i18n.text("session.workflow_save.confirmation_question"),
                )
                if reply is not None:
                    blocks.append(reply)
                    continue
                block = _workflow_confirm_block(step, fallback_id=f"{session_id}:{idx}:workflow-confirm")
                if block is not None and should_show_interaction_block(block):
                    blocks.append(block)
                continue
            if step.get("tool_name") == "request_human_task_confirm":
                result = step.get("tool_result")
                reply = confirmation_reply(
                    result,
                    backend_i18n.text("session.task_spec.confirmation_question"),
                )
                if reply is not None:
                    blocks.append(reply)
                    continue
                task_markdown = (
                    str(result.get("task_markdown") or "").strip()
                    if isinstance(result, dict)
                    else ""
                )
                if task_markdown:
                    block = {
                        "type": "task_confirm",
                        "requestId": str(result.get("request_id") or f"{session_id}:{idx}:task-confirm"),
                        "taskMarkdown": task_markdown,
                        "status": str(result.get("status") or "pending"),
                        "feedback": result.get("feedback"),
                    }
                    if "operation" in result:
                        block["operation"] = str(result.get("operation") or "create")
                    elif edit_workflow_id:
                        block["operation"] = "edit"
                    if "workflow_id" in result:
                        block["workflowId"] = result.get("workflow_id")
                    elif edit_workflow_id:
                        block["workflowId"] = edit_workflow_id
                    if "previous_task_markdown" in result:
                        block["previousTaskMarkdown"] = result.get("previous_task_markdown")
                    if "original_task_markdown" in result:
                        block["originalTaskMarkdown"] = result.get("original_task_markdown")
                    if should_show_interaction_block(block):
                        blocks.append(block)
                continue
            if step.get("tool_name") in {"run_subagent", "start_subagent"}:
                arguments = step.get("tool_arguments") or {}
                for child_id, child_turn, child_title in subagents.get(
                    str(step.get("tool_id") or ""), [],
                ):
                    blocks.append({
                        "type": "subagent",
                        **child_block(
                            child_id,
                            child_turn,
                            str(arguments.get("goal") or child_title or ""),
                        ),
                    })
                continue
            call = _tool_call(session_id, idx, t_idx, step, duration_ms)
            children = subagents.get(str(step.get("tool_id") or ""), [])
            if children:
                call["subagents"] = [
                    child_block(child_id, child_turn, child_title)
                    for child_id, child_turn, child_title in children
                ]
            t_idx += 1
            current_calls.append(call)
            blocks.append({"type": "tool", **call})

        terminal = (round_ or {}).get("workflow_result")
        if isinstance(terminal, dict) and terminal.get("run_id"):
            workflow_report_terminal = workflow_report_index is not None
            run_id = str(terminal["run_id"])
            already_projected = any(
                block.get("type") == "workflow_result" and block.get("runId") == run_id
                for block in blocks
            )
            if not already_projected:
                block = {
                    "type": "workflow_result",
                    "runId": run_id,
                    "workflowId": str(terminal.get("workflow_id") or ""),
                    "workflowName": str(terminal.get("workflow_name") or ""),
                    "status": str(terminal.get("status") or "failed"),
                    "validationStatus": str(terminal.get("validation_status") or "failed"),
                    "createdAt": str(terminal.get("created_at") or ""),
                    "summary": terminal.get("summary"),
                }
                result_file_count = terminal.get("result_file_count")
                if (
                    isinstance(result_file_count, int)
                    and not isinstance(result_file_count, bool)
                    and result_file_count >= 0
                ):
                    block["resultFileCount"] = result_file_count
                blocks.append(block)

        round_end = len(blocks)
        if workflow_report_index is not None:
            content_start = (
                workflow_content_start
                if workflow_content_start is not None
                else workflow_fallback_start
            )
            if content_start <= workflow_report_index:
                workflow_step_spans.append((content_start, workflow_report_index))
            workflow_fallback_start = round_end
            workflow_content_start = None if workflow_report_terminal else round_end
        elif entered_workflow:
            # ``request_run_workflow`` is an exclusive control call. Its own Main
            # reasoning stays outside the Workflow; the next OTA round is the first
            # process content for the entered or resumed section.
            workflow_content_start = round_end
            workflow_fallback_start = round_end

    permission = interaction.get("permission") if is_last and isinstance(interaction, dict) else None
    if isinstance(permission, dict) and show_pending_interaction:
        blocks.append({
            "type": "permission",
            "requestId": interaction.get("request_id"),
            "items": [
                {
                    "callIndex": item.get("call_index"),
                    "tool": item.get("tool", ""),
                    "arguments": item.get("arguments") or {},
                    "capability": item.get("capability", ""),
                    "boundary": item.get("boundary", ""),
                    "label": item.get("label", ""),
                    "summary": item.get("summary", ""),
                    "sensitive": item.get("sensitive", False),
                    "deletion": item.get("deletion", False),
                    "regenerable": item.get("regenerable", False),
                    "uncertain_destruction": item.get("uncertain_destruction", False),
                    "touches_risk_surface": item.get("touches_risk_surface", False),
                }
                for item in permission.get("items") or []
                if isinstance(item, dict)
            ],
            "questions": permission.get("questions") or [],
        })

    blocks = _workflow_steps_before_content(blocks, workflow_step_spans)

    messages: List[dict] = []
    completed_at = turn.created_at
    if completed_at.tzinfo is None:
        completed_at = completed_at.replace(tzinfo=timezone.utc)
    if not blocks and turn.final_answer:
        blocks.append({"type": "text", "text": turn.final_answer})
    if blocks:
        assistant = {
            "id": f"{session_id}:{idx}",
            "turnId": turn.id,
            "role": "assistant",
            "text": "\n\n".join(
                block["text"]
                for block in blocks
                if block.get("type") == "text" and block.get("text")
            ),
            "toolCalls": current_calls,
            "blocks": blocks,
            "done": True,
            "finalAnswer": turn.final_answer,
            "createdAt": seq + len(messages),
            "completedAt": (
                int(completed_at.timestamp() * 1000)
            ),
            "durationMs": turn.duration_ms,
        }
        if turn.model is not None:
            assistant["model"] = turn.model
        if turn.execution_mode is not None:
            assistant["executionMode"] = turn.execution_mode
        if turn.status is TurnStatus.AWAITING_SUBAGENTS:
            assistant["turnStatus"] = turn.status.value
        messages.append(assistant)
    return messages


def _thinking_mode(turns: Sequence[SessionTurnRecord]) -> Optional[Dict[str, Any]]:
    """The trailing turn's think position as ``{mode, stage}`` — the GUI restores
    its build-rail position from this on reload, matching the live ``stage``
    event's two layers (``mode`` = loop, ``stage`` = unit). None when there's no
    prior turn; stage names are already the wire names (no ``_think`` suffix).
    """
    if not turns:
        return None
    state = turns[-1].ota_context_dump().get("state")
    think = state.get("think") if isinstance(state, dict) else None
    if not isinstance(think, dict) or not think.get("mode"):
        return None
    position = {"mode": think.get("mode"), "stage": think.get("stage")}
    if think.get("mode") == "build" and think.get("workflow_id"):
        position["workflow_id"] = think["workflow_id"]
    if think.get("mode") == "presentation":
        position.update({
            "presentation_goal": think.get("goal"),
            "presentation_step_index": think.get("step_index") or 0,
            "presentation_reports": think.get("reports") or [],
        })
    return position


def _context_usage(turns: Sequence[SessionTurnRecord]) -> Optional[Dict[str, Any]]:
    """Latest durable context occupancy, shaped like the live stream event."""
    def breakdown(value: Any) -> Dict[str, int]:
        data = value if isinstance(value, dict) else {}
        return {
            "system_prompt_tokens": int(data.get("system_prompt_tokens") or 0),
            "dynamic_context_tokens": int(data.get("dynamic_context_tokens") or 0),
            "tool_schema_tokens": int(data.get("tool_schema_tokens") or 0),
            "session_history_tokens": int(data.get("session_history_tokens") or 0),
            "current_input_tokens": int(data.get("current_input_tokens") or 0),
        }

    for turn in reversed(turns):
        usage = turn.context_usage
        if not isinstance(usage, dict):
            continue
        if not isinstance(usage.get("model_id"), str):
            continue
        if usage.get("source") not in {"provider", "estimated"}:
            continue
        if int(usage.get("used_tokens") or 0) <= 0:
            continue
        return {
            "model_id": usage["model_id"],
            "input_tokens": int(
                usage.get("occupied_input_tokens", usage.get("input_tokens")) or 0
            ),
            "output_tokens": int(
                usage.get("occupied_output_tokens", usage.get("output_tokens")) or 0
            ),
            "cached_input_tokens": (
                int(usage["cached_input_tokens"])
                if usage.get("cached_input_tokens") is not None
                else None
            ),
            "used_tokens": int(usage.get("used_tokens") or 0),
            "usable_tokens": usage.get("usable_tokens"),
            "percentage": usage.get("percentage"),
            "source": usage["source"],
            "breakdown": breakdown(usage.get("breakdown")),
        }
    return None


def _pending_request(turns: Sequence[SessionTurnRecord]) -> Optional[dict]:
    """The trailing Turn's open human interaction, else ``None``.

    Reads the parked ask from the trailing dump's ``state.interaction`` so a reloaded
    GUI re-shows the banner. Agent choices and system Build conflicts store their
    ``questions`` directly; the permission gate nests them under its ``permission``
    payload. A resumed turn clears ``state.interaction``, so the banner clears too.
    """
    if not turns:
        return None
    state = turns[-1].ota_context_dump().get("state")
    interaction = state.get("interaction") if isinstance(state, dict) else None
    if not isinstance(interaction, dict):
        return None
    # Permission gate: the interaction carries a "permission" payload (questions + the
    # per-item criteria in items). kind="permission" makes the GUI render an approval
    # card (as opposed to request_human_choice's generic choice).
    permission = interaction.get("permission")
    if isinstance(permission, dict):
        questions = permission.get("questions") or []
        if any(q.get("options") for q in questions if isinstance(q, dict)):
            pending = {
                "kind": "permission",
                "questions": questions,
                "items": permission.get("items") or [],
                # Sent back with permission_answer to correlate the parked turn
                # (AwaitingPermission.request_id).
                "request_id": interaction.get("request_id"),
            }
            return pending
        return None
    accept_rule = interaction.get("accept_rule")
    if isinstance(accept_rule, dict):
        rules = [
            str(rule)
            for rule in accept_rule.get("candidate_rules") or []
            if str(rule).strip()
        ]
        if rules:
            return {
                "kind": "accept_rule",
                "rules": rules,
                "questions": [],
                "request_id": accept_rule.get("request_id"),
            }
        return None
    # request_human_choice: carries questions directly.
    questions = interaction.get("questions")
    if questions:
        pending = {
            "kind": "choose",
            "questions": questions,
        }
        prompt = str(interaction.get("prompt") or "")
        if prompt:
            pending["prompt"] = prompt
        request_id = interaction.get("request_id")
        if request_id is not None:
            pending["request_id"] = request_id
        return pending
    return None


def _question_text(arguments: Dict[str, Any]) -> str:
    """Join the ask's questions as distinct Markdown paragraphs."""
    return "\n\n".join(
        str(q.get("question") or "")
        for q in _parse_questions(arguments)
        if q.get("question")
    )


def _choice_prompt(arguments: Dict[str, Any]) -> str:
    """Return only a current-contract Markdown prompt, never legacy questions JSON."""
    if not arguments.get("questions"):
        return ""
    prompt = arguments.get("prompt")
    return prompt.strip() if isinstance(prompt, str) else ""


def _workflow_confirm_block(step: dict, *, fallback_id: str) -> Optional[dict]:
    result = step.get("tool_result")
    payload = result if isinstance(result, dict) else {}
    if not payload:
        payload = _parse_workflow_confirm_payload(step.get("tool_arguments") or {})
    if isinstance(result, str):
        text = result.strip().lower()
        if "confirmed" in text:
            payload = {**payload, "status": "confirmed"}
        elif "cancelled" in text or "canceled" in text:
            payload = {**payload, "status": "cancelled"}

    default_name = str(payload.get("default_name") or payload.get("name") or "").strip()
    if not default_name:
        return None

    block = {
        "type": "workflow_confirm",
        "requestId": str(payload.get("request_id") or fallback_id),
        "defaultName": default_name,
        "summary": payload.get("summary"),
        "status": str(payload.get("status") or "pending"),
    }
    if "operation" in payload:
        block["operation"] = str(payload.get("operation") or "create")
    if "workflow_id" in payload or "workflowId" in payload:
        block["workflowId"] = payload.get("workflow_id") or payload.get("workflowId")
    if "name" in payload:
        block["name"] = payload.get("name")
    return block


def _parse_workflow_confirm_payload(arguments: Dict[str, Any]) -> Dict[str, Any]:
    prompt = arguments.get("prompt") or ""
    if isinstance(prompt, dict):
        return prompt
    for parse in (json.loads, ast.literal_eval):
        try:
            data = parse(prompt)
        except (ValueError, SyntaxError, TypeError):
            continue
        if isinstance(data, dict):
            return data
    return {}


def _parse_questions(arguments: Dict[str, Any]) -> List[dict]:
    """Parse the ask's questions from the current or legacy tool contract.

    The current contract carries JSON in ``questions``. Older persisted turns
    put the same JSON in ``prompt``; keep reading that form for transcript
    compatibility. The framework may stringify values as Python literals, so
    try JSON and ``ast.literal_eval``.
    """
    value = arguments.get("questions")
    if value in (None, ""):
        value = arguments.get("prompt") or ""
    if isinstance(value, list):
        return value
    for parse in (json.loads, ast.literal_eval):
        try:
            data = parse(value)
        except (ValueError, SyntaxError, TypeError):
            continue
        if isinstance(data, dict):
            data = data.get("questions", [])
        if isinstance(data, list) and data:
            return data
    return [{"question": str(value), "options": []}]


def _reasoning_text(round_: Dict[str, Any]) -> str:
    """This round's chain-of-thought as display text, or ``""``.

    ``reasoning_content`` (OpenAI / DeepSeek wire — a plain string) is preferred;
    otherwise the Anthropic ``thinking_blocks`` (``[{"thinking": str, ...}]``) are
    joined. Both are captured per round during the turn (see ``_cognitive.py``)
    and survive the OTA ``model_dump`` → reload roundtrip.
    """
    if not isinstance(round_, dict):
        return ""
    rc = round_.get("reasoning_content")
    if isinstance(rc, str) and rc.strip():
        return rc
    blocks = round_.get("thinking_blocks")
    if isinstance(blocks, list):
        text = "".join(
            b.get("thinking", "")
            for b in blocks
            if isinstance(b, dict) and isinstance(b.get("thinking"), str)
        )
        if text.strip():
            return text
    return ""


def _tool_call(session_id: str, round_idx: int, t_idx: int, step: dict, duration_ms: int = 0) -> dict:
    """Map one executed tool step onto the frontend ``toolCall`` shape.

    ``duration_ms`` is the round's act-phase wall-clock (persisted on the round,
    shared across its tools — mirrors the live ``tool_result.duration_ms``).
    """
    success = bool(step.get("success", True))
    result = step.get("tool_result")
    output = (
        str(result) if result is not None else ""
    ) if success else (step.get("error") or "tool failed")
    return {
        "toolUseId": str(step.get("tool_id") or f"{session_id}:{round_idx}:t{t_idx}"),
        "name": str(step.get("tool_name") or ""),
        "input": dict(step.get("tool_arguments") or {}),
        "result": {
            "output": str(output or ""),
            "isError": not success,
            "durationMs": duration_ms,
        },
    }


__all__ = [
    "session_summary",
    "session_detail",
    "session_to_agent_messages",
    "SessionListHandler",
    "SessionDetailHandler",
    "SessionMessagesHandler",
]
