from src.amphi_store import SessionMountRepository, SessionRecord, SessionRepository
from tests._support.sandbox import IsolatedPaths


USER_ID = "local"


async def _create_session(session_id: str, title: str) -> None:
    """Persist one local Session through the public repository API."""
    await SessionRepository().save(
        SessionRecord(
            id=session_id,
            user_id=USER_ID,
            workspace_root=f"/workspace/{session_id}",
            title=title,
        )
    )


async def test_create_and_resolve(initialized_store: None) -> None:
    """Final database state:

    {
      "session-a": {
        "mounts": [
          {
            "id": "<generated mnt_* id>",
            "name": "project",
            "abs_path": "/data/project",
            "kind": "folder"
          },
          {
            "id": "<generated mnt_* id>",
            "name": "notes.txt",
            "abs_path": "/data/notes.txt",
            "kind": "file"
          }
        ]
      },
      "resolved_ids": ["<session-a mount ids only>"]
    }

    Checks:
    1. Creating a mount persists its Session, display name, path, and kind.
    2. A Session lists only its own mounts, newest first.
    3. Resolving mention ids returns matching mounts from the same Session.
    4. Unknown ids and ids from another Session are ignored.
    """
    await _create_session("session-a", "Primary session")
    await _create_session("session-b", "Other session")
    repository = SessionMountRepository()

    # Check 1: Creating a mount persists its Session, display name, path, and kind.
    notes = await repository.create(
        "session-a",
        USER_ID,
        name="notes.txt",
        abs_path="/data/notes.txt",
        kind="file",
    )
    project = await repository.create(
        "session-a",
        USER_ID,
        name="project",
        abs_path="/data/project",
        kind="folder",
    )
    assert notes.id.startswith("mnt_")
    assert notes.session_id == "session-a"
    assert notes.user_id == USER_ID
    assert notes.name == "notes.txt"
    assert notes.abs_path == "/data/notes.txt"
    assert notes.kind == "file"

    other = await repository.create(
        "session-b",
        USER_ID,
        name="other.txt",
        abs_path="/data/other.txt",
        kind="file",
    )

    # Check 2: A Session lists only its own mounts, newest first.
    mounts = await repository.list_for_session("session-a", USER_ID)
    assert [mount.id for mount in mounts] == [project.id, notes.id]

    # Check 3: Resolving mention ids returns matching mounts from the same Session.
    resolved = await repository.resolve(
        "session-a",
        USER_ID,
        [notes.id, project.id, notes.id, other.id, "missing-mount"],
    )
    assert set(resolved) == {notes.id, project.id}
    assert resolved[notes.id].abs_path == "/data/notes.txt"
    assert resolved[project.id].abs_path == "/data/project"

    # Check 4: Unknown ids and ids from another Session are ignored.
    assert other.id not in resolved
    assert "missing-mount" not in resolved


async def test_library_pages(initialized_store: None) -> None:
    """Final returned library:

    [
      {
        "mount": {"name": "brief.txt", "session_id": "session-b"},
        "session": {"id": "session-b", "title": "Research"}
      },
      {
        "mount": {"name": "design", "session_id": "session-a"},
        "session": {"id": "session-a", "title": "Build"}
      },
      {
        "mount": {"name": "spec.md", "session_id": "session-a"},
        "session": {"id": "session-a", "title": "Build"}
      }
    ]

    Checks:
    1. The mount library pairs every mount with its owning Session metadata.
    2. The library is ordered by newest mount first across Sessions.
    3. Limit and offset return the requested slice of that same ordering.
    """
    await _create_session("session-a", "Build")
    await _create_session("session-b", "Research")
    repository = SessionMountRepository()
    spec = await repository.create(
        "session-a",
        USER_ID,
        name="spec.md",
        abs_path="/data/spec.md",
        kind="file",
    )
    design = await repository.create(
        "session-a",
        USER_ID,
        name="design",
        abs_path="/data/design",
        kind="folder",
    )
    brief = await repository.create(
        "session-b",
        USER_ID,
        name="brief.txt",
        abs_path="/data/brief.txt",
        kind="file",
    )

    # Check 1: The mount library pairs every mount with its owning Session metadata.
    library = await repository.list_for_user_with_sessions(USER_ID)
    associations = {
        mount.id: (mount.session_id, session.id, session.title)
        for mount, session in library
    }
    assert associations == {
        spec.id: ("session-a", "session-a", "Build"),
        design.id: ("session-a", "session-a", "Build"),
        brief.id: ("session-b", "session-b", "Research"),
    }

    # Check 2: The library is ordered by newest mount first across Sessions.
    assert [mount.id for mount, _ in library] == [brief.id, design.id, spec.id]

    # Check 3: Limit and offset return the requested slice of that same ordering.
    page = await repository.list_for_user_with_sessions(USER_ID, limit=1, offset=1)
    assert [(mount.id, session.id) for mount, session in page] == [
        (design.id, "session-a")
    ]


async def test_unmount(initialized_store: None, test_sandbox: IsolatedPaths) -> None:
    """Final database and filesystem state:

    {
      "session-a": {"mounts": []},
      "session-b": {"mounts": ["other.txt"]},
      "source_paths": {
        "notes.txt": "still exists",
        "project": "still exists"
      }
    }

    Checks:
    1. Deleting one mount removes only its registry row, not the source file.
    2. Deleting the same mount again reports that nothing was removed.
    3. Clearing a Session removes all its remaining mounts and returns the count.
    4. Clearing one Session leaves another Session's mounts and source paths intact.
    """
    await _create_session("session-a", "Primary session")
    await _create_session("session-b", "Other session")
    source_file = test_sandbox.root / "notes.txt"
    source_folder = test_sandbox.root / "project"
    other_file = test_sandbox.root / "other.txt"
    source_file.write_text("notes", encoding="utf-8")
    source_folder.mkdir()
    other_file.write_text("other", encoding="utf-8")
    repository = SessionMountRepository()
    notes = await repository.create(
        "session-a",
        USER_ID,
        name=source_file.name,
        abs_path=str(source_file),
        kind="file",
    )
    await repository.create(
        "session-a",
        USER_ID,
        name=source_folder.name,
        abs_path=str(source_folder),
        kind="folder",
    )
    other = await repository.create(
        "session-b",
        USER_ID,
        name=other_file.name,
        abs_path=str(other_file),
        kind="file",
    )

    # Check 1: Deleting one mount removes only its registry row, not the source file.
    deleted = await repository.delete(notes.id, "session-a", USER_ID)
    remaining = await repository.list_for_session("session-a", USER_ID)
    assert deleted is True
    assert notes.id not in {mount.id for mount in remaining}
    assert source_file.read_text(encoding="utf-8") == "notes"

    # Check 2: Deleting the same mount again reports that nothing was removed.
    assert await repository.delete(notes.id, "session-a", USER_ID) is False

    # Check 3: Clearing a Session removes all its remaining mounts and returns the count.
    removed = await repository.delete_for_session("session-a", USER_ID)
    assert removed == 1
    assert await repository.list_for_session("session-a", USER_ID) == []

    # Check 4: Clearing one Session leaves another Session's mounts and source paths intact.
    other_mounts = await repository.list_for_session("session-b", USER_ID)
    assert [mount.id for mount in other_mounts] == [other.id]
    assert source_file.exists()
    assert source_folder.is_dir()
    assert other_file.read_text(encoding="utf-8") == "other"
