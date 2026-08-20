from typing import Any

import pytest

from src.amphi_store import (
    SessionRecord,
    SessionRepository,
    SessionTurnRecord,
    SessionTurnRepository,
    TurnStatus,
    UserInput,
)


USER_ID = "local"


async def _create_session(session_id: str) -> SessionRecord:
    """Persist one local Session through the public repository API."""
    record = SessionRecord(
        id=session_id,
        user_id=USER_ID,
        workspace_root=f"/workspace/{session_id}",
    )
    await SessionRepository().save(record)
    return record


async def _append_turn(
    repository: SessionTurnRepository,
    session_id: str,
    text: str,
    expected_tail_id: str | None,
    *,
    status: TurnStatus = TurnStatus.COMPLETED,
    final_answer: str | None = None,
    error: str | None = None,
    input_tokens: int = 2,
    output_tokens: int = 3,
    user_input: UserInput | None = None,
    ota_records: list[dict[str, Any]] | None = None,
    agent_state: dict[str, Any] | None = None,
    browser_tool_loaded: bool = False,
    workspace_tools_loaded: bool = False,
    skills_tool_loaded: bool = False,
    model: str | None = "test-model",
    execution_mode: str | None = "auto",
    max_rounds: int | None = 8,
    duration_ms: int = 100,
) -> SessionTurnRecord:
    """Append one Turn through the public repository API."""
    return await repository.append_result(
        USER_ID,
        session_id=session_id,
        expected_tail_id=expected_tail_id,
        user_input=user_input if user_input is not None else UserInput(text=text),
        ota_records=ota_records if ota_records is not None else [{"event": text}],
        agent_state=agent_state if agent_state is not None else {"step": text},
        browser_tool_loaded=browser_tool_loaded,
        workspace_tools_loaded=workspace_tools_loaded,
        skills_tool_loaded=skills_tool_loaded,
        status=status,
        final_answer=final_answer,
        error=error,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        model=model,
        execution_mode=execution_mode,
        max_rounds=max_rounds,
        duration_ms=duration_ms,
    )


async def test_append_turns(initialized_store: None) -> None:
    """Final database state:

    {
      "session-a": {
        "turns": [
          {
            "ordinal": 0,
            "input": "First question",
            "status": "completed",
            "answer": "First answer",
            "tokens": 15,
            "duration_ms": 120
          },
          {
            "ordinal": 1,
            "input": "Second question",
            "status": "failed",
            "error": "Provider unavailable",
            "tokens": 10,
            "duration_ms": 240
          }
        ]
      }
    }

    Checks:
    1. The first result creates ordinal zero with its complete runtime context.
    2. The next result appends at ordinal one without changing the first Turn.
    3. A Turn can be loaded later by its generated id.
    4. Latest and conversation queries expose the persisted order.
    5. A stale expected tail cannot append another Turn.
    """
    await _create_session("session-a")
    repository = SessionTurnRepository()
    source_ota = [{"event": "first"}]

    # Check 1: The first result creates ordinal zero with its complete runtime context.
    first = await _append_turn(
        repository,
        "session-a",
        "First question",
        None,
        final_answer="First answer",
        input_tokens=10,
        output_tokens=5,
        ota_records=source_ota,
        agent_state={"step": "first"},
        browser_tool_loaded=True,
        workspace_tools_loaded=True,
        duration_ms=120,
    )
    assert first.session_ordinal == 0
    assert first.user_input == UserInput(text="First question")
    assert first.status is TurnStatus.COMPLETED
    assert first.final_answer == "First answer"
    assert first.input_tokens + first.output_tokens == 15
    assert first.model == "test-model"
    assert first.execution_mode == "auto"
    assert first.max_rounds == 8
    assert first.browser_tool_loaded is True
    assert first.workspace_tools_loaded is True
    assert first.skills_tool_loaded is False
    assert first.ota_records == [{"event": "first", "turn_duration_ms": 120}]
    assert first.agent_state == {"step": "first"}
    assert first.duration_ms == 120
    assert source_ota == [{"event": "first"}]

    # Check 2: The next result appends at ordinal one without changing the first Turn.
    second = await _append_turn(
        repository,
        "session-a",
        "Second question",
        first.id,
        status=TurnStatus.FAILED,
        error="Provider unavailable",
        input_tokens=4,
        output_tokens=6,
        duration_ms=240,
    )
    assert second.session_ordinal == 1
    assert second.status is TurnStatus.FAILED
    assert second.error == "Provider unavailable"
    assert second.input_tokens + second.output_tokens == 10
    assert second.duration_ms == 240

    # Check 3: A Turn can be loaded later by its generated id.
    loaded_first = await repository.get(USER_ID, first.id)
    assert loaded_first is not None
    assert loaded_first.session_ordinal == 0
    assert loaded_first.final_answer == "First answer"

    # Check 4: Latest and conversation queries expose the persisted order.
    latest = await repository.latest("session-a", USER_ID)
    conversation = await repository.list_conversation(USER_ID, "session-a")
    assert latest is not None
    assert latest.id == second.id
    assert [turn.id for turn in conversation] == [first.id, second.id]
    assert [turn.session_ordinal for turn in conversation] == [0, 1]

    # Check 5: A stale expected tail cannot append another Turn.
    with pytest.raises(RuntimeError, match="tail changed"):
        await _append_turn(
            repository,
            "session-a",
            "Stale question",
            first.id,
        )
    unchanged = await repository.list_conversation(USER_ID, "session-a")
    assert [turn.id for turn in unchanged] == [first.id, second.id]


async def test_replace_tail(initialized_store: None) -> None:
    """Final database state:

    {
      "session-a": {
        "turns": [
          {"ordinal": 0, "input": "First question"},
          {
            "ordinal": 1,
            "input": "Corrected question",
            "status": "completed",
            "answer": "Corrected answer"
          }
        ],
        "removed_turn": "<old-tail-id>"
      }
    }

    Checks:
    1. Replacing the tail creates a fresh id at the same ordinal.
    2. The old tail disappears while the earlier conversation remains intact.
    3. The replacement becomes the latest Turn.
    4. Replacing with the removed tail id is rejected without changing history.
    """
    await _create_session("session-a")
    repository = SessionTurnRepository()
    first = await _append_turn(repository, "session-a", "First question", None)
    old_tail = await _append_turn(
        repository,
        "session-a",
        "Waiting question",
        first.id,
        status=TurnStatus.AWAITING_HUMAN,
    )

    async def replace(expected_tail_id: str, text: str) -> SessionTurnRecord:
        return await repository.replace_tail_result(
            USER_ID,
            session_id="session-a",
            expected_tail_id=expected_tail_id,
            user_input=UserInput(text=text),
            ota_records=[{"event": "replacement"}],
            agent_state={"step": "replacement"},
            browser_tool_loaded=False,
            workspace_tools_loaded=True,
            skills_tool_loaded=False,
            status=TurnStatus.COMPLETED,
            final_answer="Corrected answer",
            error=None,
            input_tokens=7,
            output_tokens=5,
            model="replacement-model",
            execution_mode="request",
            max_rounds=4,
            duration_ms=300,
        )

    # Check 1: Replacing the tail creates a fresh id at the same ordinal.
    replacement = await replace(old_tail.id, "Corrected question")
    assert replacement.id != old_tail.id
    assert replacement.session_ordinal == old_tail.session_ordinal == 1
    assert replacement.user_input.text == "Corrected question"
    assert replacement.status is TurnStatus.COMPLETED
    assert replacement.final_answer == "Corrected answer"
    assert replacement.duration_ms == 300

    # Check 2: The old tail disappears while the earlier conversation remains intact.
    conversation = await repository.list_conversation(USER_ID, "session-a")
    assert await repository.get(USER_ID, old_tail.id) is None
    assert [turn.id for turn in conversation] == [first.id, replacement.id]
    assert [turn.session_ordinal for turn in conversation] == [0, 1]

    # Check 3: The replacement becomes the latest Turn.
    latest = await repository.latest("session-a", USER_ID)
    assert latest is not None
    assert latest.id == replacement.id

    # Check 4: Replacing with the removed tail id is rejected without changing history.
    with pytest.raises(RuntimeError, match="tail changed"):
        await replace(old_tail.id, "Stale replacement")
    unchanged = await repository.list_conversation(USER_ID, "session-a")
    assert [turn.id for turn in unchanged] == [first.id, replacement.id]


async def test_conversation_pages(initialized_store: None) -> None:
    """Returned conversations:

    {
      "full": [0, 1, 2, 3, 4],
      "latest_page": [3, 4],
      "previous_page": [1, 2],
      "other_session_excluded": true
    }

    Checks:
    1. The default query returns the complete conversation oldest first.
    2. A limited query returns the newest page while preserving display order.
    3. The ordinal cursor returns a stable previous page and excludes the cursor.
    4. Turns from another Session never appear in the conversation.
    """
    await _create_session("session-a")
    await _create_session("session-b")
    repository = SessionTurnRepository()
    expected_tail_id = None
    for ordinal in range(5):
        turn = await _append_turn(
            repository,
            "session-a",
            f"Question {ordinal}",
            expected_tail_id,
        )
        expected_tail_id = turn.id
    await _append_turn(repository, "session-b", "Other question", None)

    # Check 1: The default query returns the complete conversation oldest first.
    full = await repository.list_conversation(USER_ID, "session-a")
    assert [turn.session_ordinal for turn in full] == [0, 1, 2, 3, 4]
    assert [turn.user_input.text for turn in full] == [
        "Question 0",
        "Question 1",
        "Question 2",
        "Question 3",
        "Question 4",
    ]

    # Check 2: A limited query returns the newest page while preserving display order.
    latest_page = await repository.list_conversation(USER_ID, "session-a", limit=2)
    assert [turn.session_ordinal for turn in latest_page] == [3, 4]

    # Check 3: The ordinal cursor returns a stable previous page and excludes the cursor.
    previous_page = await repository.list_conversation(
        USER_ID,
        "session-a",
        before_ordinal=3,
        limit=2,
    )
    assert [turn.session_ordinal for turn in previous_page] == [1, 2]

    # Check 4: Turns from another Session never appear in the conversation.
    assert {turn.session_id for turn in full} == {"session-a"}
    assert all(turn.user_input.text != "Other question" for turn in full)


async def test_copy_history(initialized_store: None) -> None:
    """Final database state:

    {
      "source": {
        "ordinals": [0, 1],
        "reference_id": "old-ref"
      },
      "destination": {
        "ordinals": [0, 1],
        "fresh_turn_ids": true,
        "reference_id": "new-ref",
        "nested_context_remapped": true
      }
    }

    Checks:
    1. Copying returns the number of Turns added to the destination Session.
    2. Copied Turns retain order, result fields, configuration, and usage with new ids.
    3. Exact reference ids are remapped through input blocks and nested context.
    4. Source history and partial reference strings remain unchanged.
    """
    await _create_session("source-session")
    await _create_session("destination-session")
    repository = SessionTurnRepository()
    first = await _append_turn(
        repository,
        "source-session",
        "Use old-ref but keep this text unchanged",
        None,
        final_answer="First result",
        user_input=UserInput(
            text="Use old-ref but keep this text unchanged",
            blocks=[
                {"type": "reference", "id": "old-ref"},
                {"type": "reference", "id": "keep-ref"},
            ],
        ),
        ota_records=[
            {
                "old-ref": "old-ref",
                "references": ["old-ref"],
                "partial": "prefix-old-ref",
            }
        ],
        agent_state={
            "active": "old-ref",
            "by_reference": {"old-ref": "old-ref"},
            "partial": "prefix-old-ref",
        },
        browser_tool_loaded=True,
        skills_tool_loaded=True,
        input_tokens=8,
        output_tokens=4,
    )
    second = await _append_turn(
        repository,
        "source-session",
        "Second question",
        first.id,
        status=TurnStatus.FAILED,
        error="Second failed",
        input_tokens=3,
        output_tokens=1,
    )

    # Check 1: Copying returns the number of Turns added to the destination Session.
    copied_count = await repository.copy_to_session(
        "source-session",
        "destination-session",
        USER_ID,
        reference_id_map={"old-ref": "new-ref"},
    )
    assert copied_count == 2

    # Check 2: Copied Turns retain order, result fields, configuration, and usage with new ids.
    source = await repository.list_conversation(USER_ID, "source-session")
    destination = await repository.list_conversation(USER_ID, "destination-session")
    assert [turn.session_ordinal for turn in destination] == [0, 1]
    assert {turn.id for turn in source}.isdisjoint(turn.id for turn in destination)
    for source_turn, copied_turn in zip(source, destination):
        assert copied_turn.status is source_turn.status
        assert copied_turn.final_answer == source_turn.final_answer
        assert copied_turn.error == source_turn.error
        assert copied_turn.model == source_turn.model
        assert copied_turn.execution_mode == source_turn.execution_mode
        assert copied_turn.max_rounds == source_turn.max_rounds
        assert copied_turn.browser_tool_loaded is source_turn.browser_tool_loaded
        assert copied_turn.workspace_tools_loaded is source_turn.workspace_tools_loaded
        assert copied_turn.skills_tool_loaded is source_turn.skills_tool_loaded
        assert copied_turn.input_tokens == source_turn.input_tokens
        assert copied_turn.output_tokens == source_turn.output_tokens

    # Check 3: Exact reference ids are remapped through input blocks and nested context.
    copied_first = destination[0]
    assert [block["id"] for block in copied_first.user_input.blocks] == ["new-ref", "keep-ref"]
    assert copied_first.ota_records is not None
    assert copied_first.ota_records[0]["new-ref"] == "new-ref"
    assert copied_first.ota_records[0]["references"] == ["new-ref"]
    assert copied_first.agent_state is not None
    assert copied_first.agent_state["active"] == "new-ref"
    assert copied_first.agent_state["by_reference"] == {"new-ref": "new-ref"}

    # Check 4: Source history and partial reference strings remain unchanged.
    assert source[0].user_input.blocks[0]["id"] == "old-ref"
    assert source[0].user_input.text == "Use old-ref but keep this text unchanged"
    assert source[0].ota_records is not None
    assert source[0].ota_records[0]["partial"] == "prefix-old-ref"
    assert copied_first.user_input.text == "Use old-ref but keep this text unchanged"
    assert copied_first.ota_records[0]["partial"] == "prefix-old-ref"
    assert copied_first.agent_state["partial"] == "prefix-old-ref"
    assert second.id == source[1].id


async def test_latest_statuses(initialized_store: None) -> None:
    """Returned latest-status groups:

    {
      "completed": ["session-a"],
      "awaiting_subagents": ["session-b"]
    }

    Checks:
    1. Status queries consider only each Session's latest Turn.
    2. Returned rows are the actual latest Turns for the matching Sessions.
    """
    await _create_session("session-a")
    await _create_session("session-b")
    repository = SessionTurnRepository()
    first_a = await _append_turn(
        repository,
        "session-a",
        "A waiting",
        None,
        status=TurnStatus.AWAITING_SUBAGENTS,
    )
    latest_a = await _append_turn(
        repository,
        "session-a",
        "A completed",
        first_a.id,
    )
    first_b = await _append_turn(repository, "session-b", "B completed", None)
    latest_b = await _append_turn(
        repository,
        "session-b",
        "B waiting",
        first_b.id,
        status=TurnStatus.AWAITING_SUBAGENTS,
    )

    # Check 1: Status queries consider only each Session's latest Turn.
    completed = await repository.list_latest_by_status(TurnStatus.COMPLETED)
    waiting = await repository.list_latest_by_status(TurnStatus.AWAITING_SUBAGENTS)
    assert {turn.session_id for turn in completed} == {"session-a"}
    assert {turn.session_id for turn in waiting} == {"session-b"}

    # Check 2: Returned rows are the actual latest Turns for the matching Sessions.
    assert {turn.id for turn in completed} == {latest_a.id}
    assert {turn.id for turn in waiting} == {latest_b.id}


async def test_summaries(initialized_store: None) -> None:
    """Returned Session summaries:

    {
      "session-a": {
        "first_user_input": "First question",
        "tokens": 20,
        "latest_status": "failed"
      },
      "session-b": {
        "first_user_input": "Only question",
        "tokens": 7,
        "latest_status": "completed"
      },
      "empty-session": {
        "first_user_input": null,
        "tokens": 0,
        "latest_status": null
      }
    }

    Checks:
    1. A summary uses the first Turn's user input.
    2. Token usage is summed across the complete conversation.
    3. Summary status comes from the latest Turn.
    4. A Session without Turns receives an empty summary.
    5. The single-Session summary agrees with the bulk result.
    """
    session_a = await _create_session("session-a")
    session_b = await _create_session("session-b")
    empty_session = await _create_session("empty-session")
    repository = SessionTurnRepository()
    first_a = await _append_turn(
        repository,
        "session-a",
        "First question",
        None,
        input_tokens=4,
        output_tokens=6,
    )
    await _append_turn(
        repository,
        "session-a",
        "Second question",
        first_a.id,
        status=TurnStatus.FAILED,
        error="Failed",
        input_tokens=3,
        output_tokens=7,
    )
    await _append_turn(
        repository,
        "session-b",
        "Only question",
        None,
        input_tokens=2,
        output_tokens=5,
    )

    summaries = await repository.load_summaries([session_a, session_b, empty_session])

    # Check 1: A summary uses the first Turn's user input.
    assert summaries["session-a"].first_user_input == "First question"
    assert summaries["session-b"].first_user_input == "Only question"

    # Check 2: Token usage is summed across the complete conversation.
    assert summaries["session-a"].tokens == 20
    assert summaries["session-b"].tokens == 7

    # Check 3: Summary status comes from the latest Turn.
    assert summaries["session-a"].latest_status is TurnStatus.FAILED
    assert summaries["session-b"].latest_status is TurnStatus.COMPLETED

    # Check 4: A Session without Turns receives an empty summary.
    assert summaries["empty-session"].first_user_input is None
    assert summaries["empty-session"].tokens == 0
    assert summaries["empty-session"].latest_status is None

    # Check 5: The single-Session summary agrees with the bulk result.
    single = await repository.load_summary(session_a)
    assert single == summaries["session-a"]


async def test_delete_history(initialized_store: None) -> None:
    """Final database state:

    {
      "session-a": {"exists": true, "turns": []},
      "session-b": {
        "exists": true,
        "turns": [{"ordinal": 0, "input": "Keep me"}]
      }
    }

    Checks:
    1. Deleting one Session's history returns the exact removed count.
    2. The target Session no longer has any Turns.
    3. The Session record and another Session's history remain intact.
    4. Deleting the same empty history returns zero.
    """
    await _create_session("session-a")
    await _create_session("session-b")
    repository = SessionTurnRepository()
    first_a = await _append_turn(repository, "session-a", "Delete one", None)
    await _append_turn(repository, "session-a", "Delete two", first_a.id)
    kept = await _append_turn(repository, "session-b", "Keep me", None)

    # Check 1: Deleting one Session's history returns the exact removed count.
    deleted = await repository.delete_for_session(USER_ID, "session-a")
    assert deleted == 2

    # Check 2: The target Session no longer has any Turns.
    assert await repository.list_conversation(USER_ID, "session-a") == []

    # Check 3: The Session record and another Session's history remain intact.
    assert await SessionRepository().load("session-a", USER_ID) is not None
    remaining = await repository.list_conversation(USER_ID, "session-b")
    assert [turn.id for turn in remaining] == [kept.id]

    # Check 4: Deleting the same empty history returns zero.
    assert await repository.delete_for_session(USER_ID, "session-a") == 0
