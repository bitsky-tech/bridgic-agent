from typing import Optional, Sequence

from src.amphi_store import (
    SessionRecord,
    SessionRepository,
    SessionStatus,
    SessionTurnRecord,
    SessionTurnRepository,
    TurnStatus,
    UserInput,
)


def make_session_turns(
    pairs: Sequence[tuple[UserInput, dict]],
    *,
    user_id: str = "u",
    session_id: str = "s1",
) -> list[SessionTurnRecord]:
    """Build in-memory top-level Turns for Agent and rendering tests."""
    turns = []
    for ordinal, (user_input, ota_context) in enumerate(pairs):
        error = ota_context.get("turn_error")
        state = ota_context.get("state") or {}
        interaction = state.get("interaction") or {}
        awaiting_subagent = state.get("subagents") or None
        if error:
            turn_status = TurnStatus.FAILED
        elif awaiting_subagent:
            turn_status = TurnStatus.AWAITING_SUBAGENTS
        elif "permission" in interaction:
            turn_status = TurnStatus.AWAITING_PERMISSION
        elif interaction:
            turn_status = TurnStatus.AWAITING_HUMAN
        else:
            turn_status = TurnStatus.COMPLETED
        turns.append(SessionTurnRecord(
            id=str(ota_context.get("invocation_id") or f"turn_{ordinal}"),
            user_id=user_id,
            session_id=session_id,
            session_ordinal=ordinal,
            user_input=user_input,
            ota_records=ota_context.get("ota_record") or [],
            agent_state=state,
            browser_tool_loaded=bool(ota_context.get("browser_tool_loaded")),
            workspace_tools_loaded=bool(ota_context.get("workspace_tools_loaded")),
            skills_tool_loaded=bool(ota_context.get("skills_tool_loaded")),
            status=turn_status,
            final_answer=ota_context.get("final_answer"),
            error=str(error) if error else None,
            input_tokens=int(ota_context.get("input_tokens") or 0),
            output_tokens=int(ota_context.get("output_tokens") or 0),
        ))
    return turns


async def persist_session_turn(
    record: SessionRecord,
    user_input: UserInput,
    ota_context: dict,
    *,
    status: Optional[SessionStatus] = None,
    model: Optional[str] = "test-model",
    last_answer: Optional[str] = None,
) -> list[SessionTurnRecord]:
    """Persist one top-level Session Turn for fixture conversations."""
    state = ota_context.get("state") or {}
    interaction = state.get("interaction") or {}
    awaiting_subagent = state.get("subagents") or None
    if awaiting_subagent:
        turn_status = TurnStatus.AWAITING_SUBAGENTS
    elif "permission" in interaction:
        turn_status = TurnStatus.AWAITING_PERMISSION
    elif interaction:
        turn_status = TurnStatus.AWAITING_HUMAN
    else:
        turn_status = TurnStatus.COMPLETED

    turns = SessionTurnRepository()
    existing = await turns.list_conversation(record.user_id, record.id)
    await turns.append_result(
        record.user_id,
        session_id=record.id,
        expected_tail_id=existing[-1].id if existing else None,
        user_input=user_input,
        ota_records=ota_context.get("ota_record") or [],
        agent_state=ota_context.get("state") or {},
        browser_tool_loaded=bool(ota_context.get("browser_tool_loaded")),
        workspace_tools_loaded=bool(ota_context.get("workspace_tools_loaded")),
        skills_tool_loaded=bool(ota_context.get("skills_tool_loaded")),
        status=turn_status,
        final_answer=last_answer,
        error=None,
        input_tokens=int(ota_context.get("input_tokens") or 0),
        output_tokens=int(ota_context.get("output_tokens") or 0),
        model=model,
    )
    projection = status or (
        SessionStatus.AWAITING
        if interaction
        else SessionStatus.FINISH
        if awaiting_subagent
        else SessionStatus.COMPLETED
    )
    await SessionRepository().update_turn_projection(
        record.id,
        record.user_id,
        status=projection,
        model=model,
        last_answer=last_answer,
    )
    return await turns.list_conversation(record.user_id, record.id)
