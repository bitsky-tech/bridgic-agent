from pathlib import Path

import httpx

from src.amphi_service.auth import LOCAL_USER_ID
from src.amphi_store import SessionTurnRepository, TurnStatus, UserInput
from tests._support.sandbox import IsolatedPaths


async def create_session(service_client: httpx.AsyncClient, model: str = "test-model") -> dict:
    response = await service_client.post("/sessions", json={"model": model})
    assert response.status_code == 201
    return response.json()


async def test_create_session(service_client: httpx.AsyncClient, test_sandbox: IsolatedPaths) -> None:
    """Final service state:

    {
      "sessions": [
        {
          "id": "<generated>",
          "title": "",
          "model": "test-model",
          "status": "finish",
          "tokens": 0,
          "workspace_root": "<sandbox>/sessions/<generated>"
        }
      ],
      "workspace": {
        "root_exists": true,
        "work_directory_exists": true
      }
    }

    Checks:
    1. Creating a Session returns its complete initial HTTP projection.
    2. The Service creates the Session workspace and its system work directory.
    3. The Session list exposes the newly persisted root Session.
    """
    # Check 1: Creating a Session returns its complete initial HTTP projection.
    response = await service_client.post("/sessions", json={"model": "test-model"})
    assert response.status_code == 201
    created = response.json()
    session_id = created["id"]
    workspace_root = Path(created["workspace_root"])
    assert session_id.startswith("session_")
    assert created == {
        "id": session_id,
        "model": "test-model",
        "workspace_root": str(workspace_root),
        "tokens": 0,
        "status": "finish",
        "turn_status": None,
        "parent_session_id": None,
        "subagent_mode": None,
        "last_answer": None,
    }

    # Check 2: The Service creates the Session workspace and its system work directory.
    assert workspace_root == test_sandbox.sessions / session_id
    assert workspace_root.is_dir()
    assert (workspace_root / ".work").is_dir()

    # Check 3: The Session list exposes the newly persisted root Session.
    response = await service_client.get("/sessions")
    assert response.status_code == 200
    assert response.json() == [
        {
            "id": session_id,
            "model": "test-model",
            "workspace_root": str(workspace_root),
            "tokens": 0,
            "status": "finish",
            "turn_status": None,
            "parent_session_id": None,
            "subagent_mode": None,
            "last_answer_preview": None,
            "title": "",
        }
    ]


async def test_session_lifecycle(service_client: httpx.AsyncClient) -> None:
    """Rename and delete change exactly what the user sees through the Session API.

    Final HTTP state:
    {
      "renamed": {"id": "<generated>", "title": "Planning"},
      "deleted": {"detail_status": 404, "visible_in_list": false}
    }

    Checks:
    1. A newly created Session can be loaded through its detail endpoint.
    2. Rename returns the new title and the Session list keeps that title.
    3. An empty Session cannot be duplicated as a finished conversation.
    4. Delete removes the Session from detail and list endpoints.
    """
    created = await create_session(service_client)
    session_id = created["id"]

    # Check 1: The detail endpoint exposes the newly created Session.
    detail_response = await service_client.get(f"/sessions/{session_id}")
    assert detail_response.status_code == 200
    assert detail_response.json() == created

    # Check 2: Rename is immediately visible in its response and the Session list.
    rename_response = await service_client.patch(
        f"/sessions/{session_id}",
        json={"title": "Planning"},
    )
    assert rename_response.status_code == 200
    assert rename_response.json()["title"] == "Planning"
    list_response = await service_client.get("/sessions")
    assert list_response.status_code == 200
    assert list_response.json()[0]["id"] == session_id
    assert list_response.json()[0]["title"] == "Planning"

    # Check 3: Duplication rejects a Session with no finished Turn history.
    duplicate_response = await service_client.post(f"/sessions/{session_id}/duplicate")
    assert duplicate_response.status_code == 409
    assert duplicate_response.json() == {
        "detail": "Only finished Sessions can be duplicated."
    }

    # Check 4: Delete makes both detail and list endpoints forget the Session.
    delete_response = await service_client.delete(f"/sessions/{session_id}")
    assert delete_response.status_code == 204
    assert (await service_client.get(f"/sessions/{session_id}")).status_code == 404
    assert (await service_client.get("/sessions")).json() == []


async def test_session_pagination(service_client: httpx.AsyncClient) -> None:
    """Session pages are slices of the same user-visible root Session order.

    Final HTTP pages:
    {
      "all": ["<first-visible>", "<second-visible>", "<third-visible>"],
      "limit_1_offset_1": ["<second-visible>"],
      "past_end": []
    }

    Checks:
    1. The unpaged endpoint returns all three root Sessions.
    2. Limit and offset select the matching slice from that visible order.
    3. An offset beyond the list returns an empty page.
    """
    for _ in range(3):
        await create_session(service_client)

    # Check 1: The complete list contains all newly created root Sessions.
    full_response = await service_client.get("/sessions")
    assert full_response.status_code == 200
    full = full_response.json()
    assert len(full) == 3

    # Check 2: Pagination selects a stable slice of the complete visible order.
    page_response = await service_client.get("/sessions", params={"limit": 1, "offset": 1})
    assert page_response.status_code == 200
    assert page_response.json() == full[1:2]

    # Check 3: Moving past the final Session produces an empty page.
    empty_response = await service_client.get("/sessions", params={"limit": 1, "offset": 10})
    assert empty_response.status_code == 200
    assert empty_response.json() == []


async def test_message_pagination(service_client: httpx.AsyncClient) -> None:
    """Conversation pages return complete message pairs with stable global identities.

    Final HTTP pages:
    {
      "latest": {
        "messages": ["Question 1", "Answer 1", "Question 2", "Answer 2"],
        "has_more": true,
        "next_before": 1
      },
      "older": {
        "messages": ["Question 0", "Answer 0"],
        "has_more": false,
        "next_before": 0
      }
    }

    Checks:
    1. A two-Turn page returns the newest user/assistant pairs in reading order.
    2. Message IDs retain their global Turn ordinals instead of restarting per page.
    3. The returned cursor loads the remaining older Turn with no further page.
    """
    created = await create_session(service_client)
    session_id = created["id"]
    turns = SessionTurnRepository()
    tail_id: str | None = None
    for ordinal in range(3):
        turn = await turns.append_result(
            LOCAL_USER_ID,
            session_id=session_id,
            expected_tail_id=tail_id,
            user_input=UserInput(text=f"Question {ordinal}"),
            ota_records=[],
            agent_state={},
            browser_tool_loaded=False,
            workspace_tools_loaded=False,
            skills_tool_loaded=False,
            status=TurnStatus.COMPLETED,
            final_answer=f"Answer {ordinal}",
            error=None,
            input_tokens=ordinal + 1,
            output_tokens=ordinal + 2,
            model="test-model",
            execution_mode="normal",
        )
        tail_id = turn.id

    # Check 1: The latest page contains two complete Turn pairs in reading order.
    latest_response = await service_client.get(
        f"/sessions/{session_id}/messages",
        params={"limit": 2},
    )
    assert latest_response.status_code == 200
    latest = latest_response.json()
    assert [(message["role"], message["text"]) for message in latest["messages"]] == [
        ("user", "Question 1"),
        ("assistant", "Answer 1"),
        ("user", "Question 2"),
        ("assistant", "Answer 2"),
    ]
    assert latest["has_more"] is True
    assert latest["next_before"] == 1

    # Check 2: Message IDs preserve the original global Turn ordinals.
    assert [message["id"] for message in latest["messages"]] == [
        f"{session_id}:u1",
        f"{session_id}:1",
        f"{session_id}:u2",
        f"{session_id}:2",
    ]

    # Check 3: The cursor loads the remaining oldest pair and closes pagination.
    older_response = await service_client.get(
        f"/sessions/{session_id}/messages",
        params={"before_ordinal": latest["next_before"], "limit": 2},
    )
    assert older_response.status_code == 200
    older = older_response.json()
    assert [(message["role"], message["text"]) for message in older["messages"]] == [
        ("user", "Question 0"),
        ("assistant", "Answer 0"),
    ]
    assert older["has_more"] is False
    assert older["next_before"] == 0


async def test_workspace_file_boundary(service_client: httpx.AsyncClient, test_sandbox: IsolatedPaths) -> None:
    """The file endpoint reads workspace text but never follows a path outside it.

    Final HTTP results:
    {
      "notes/result.txt": {"status": 200, "content": "completed"},
      "../outside.txt": {"status": 400},
      "outside-link.txt": {"status": 400},
      "missing.txt": {"status": 404}
    }

    Checks:
    1. A relative file inside the Session workspace is returned as text.
    2. Parent traversal and an escaping symlink are rejected before reading data.
    3. A contained path that does not exist returns a not-found response.
    """
    created = await create_session(service_client)
    session_id = created["id"]
    workspace = Path(created["workspace_root"])
    notes = workspace / "notes"
    notes.mkdir()
    (notes / "result.txt").write_text("completed", encoding="utf-8")
    outside = test_sandbox.root / "outside.txt"
    outside.write_text("private", encoding="utf-8")
    (workspace / "outside-link.txt").symlink_to(outside)

    # Check 1: A workspace-relative file is returned with its requested path.
    valid_response = await service_client.get(
        f"/sessions/{session_id}/files",
        params={"path": "notes/result.txt"},
    )
    assert valid_response.status_code == 200
    assert valid_response.json() == {
        "path": "notes/result.txt",
        "content": "completed",
    }

    # Check 2: Traversal and symlink resolution cannot escape the workspace root.
    traversal_response = await service_client.get(
        f"/sessions/{session_id}/files",
        params={"path": "../outside.txt"},
    )
    symlink_response = await service_client.get(
        f"/sessions/{session_id}/files",
        params={"path": "outside-link.txt"},
    )
    assert traversal_response.status_code == 400
    assert traversal_response.json() == {"detail": "Path escapes the session workspace."}
    assert symlink_response.status_code == 400
    assert symlink_response.json() == {"detail": "Path escapes the session workspace."}

    # Check 3: A missing file inside the workspace is reported as not found.
    missing_response = await service_client.get(
        f"/sessions/{session_id}/files",
        params={"path": "missing.txt"},
    )
    assert missing_response.status_code == 404
    assert missing_response.json() == {
        "detail": f"No file at 'missing.txt' in session '{session_id}'."
    }
