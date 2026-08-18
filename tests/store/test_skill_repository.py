from src.amphi_store import SkillRepository


USER_ID = "local"


async def test_create_and_update(initialized_store: None) -> None:
    """Final database state:

    {
      "skills": [
        {
          "id": "<stable first id>",
          "name": "writer-pro",
          "description": "Write and edit documents",
          "skill_dir": "/skills/writer-pro",
          "group": "self_created",
          "source": "local",
          "source_uri": "/imports/writer-pro"
        },
        {
          "id": "<second id>",
          "name": "researcher"
        }
      ]
    }

    Checks:
    1. Creating a Skill persists its catalogue metadata with an enabled switch.
    2. Skills can be found later by either id or catalogue name.
    3. Updating a Skill replaces its metadata without changing its id.
    4. The renamed Skill replaces its old catalogue name and becomes newest.
    """
    repository = SkillRepository()

    # Check 1: Creating a Skill persists its catalogue metadata with an enabled switch.
    writer = await repository.create(
        USER_ID,
        name="writer",
        description="Write documents",
        skill_dir="/skills/writer",
        group="imported",
        source="github",
        source_uri="https://github.com/example/writer",
    )
    assert writer.id is not None
    assert writer.user_id == USER_ID
    assert writer.name == "writer"
    assert writer.description == "Write documents"
    assert writer.skill_dir == "/skills/writer"
    assert writer.group == "imported"
    assert writer.source == "github"
    assert writer.source_uri == "https://github.com/example/writer"
    assert writer.enabled is True
    assert writer.updated_at is not None

    researcher = await repository.create(
        USER_ID,
        name="researcher",
        description="Research topics",
        skill_dir="/skills/researcher",
        group="imported",
        source="skills.sh",
        source_uri="https://skills.sh/researcher",
    )

    # Check 2: Skills can be found later by either id or catalogue name.
    by_id = await repository.get(USER_ID, writer.id)
    by_name = await repository.get_by_name(USER_ID, "writer")
    assert by_id is not None
    assert by_id.id == writer.id
    assert by_name is not None
    assert by_name.id == writer.id
    assert by_name.skill_dir == "/skills/writer"

    # Check 3: Updating a Skill replaces its metadata without changing its id.
    updated = await repository.update(
        USER_ID,
        writer.id,
        name="writer-pro",
        description="Write and edit documents",
        skill_dir="/skills/writer-pro",
        group="self_created",
        source="local",
        source_uri="/imports/writer-pro",
    )
    assert updated is not None
    assert updated.id == writer.id
    assert updated.name == "writer-pro"
    assert updated.description == "Write and edit documents"
    assert updated.skill_dir == "/skills/writer-pro"
    assert updated.group == "self_created"
    assert updated.source == "local"
    assert updated.source_uri == "/imports/writer-pro"

    # Check 4: The renamed Skill replaces its old catalogue name and becomes newest.
    skills = await repository.list_for_user(USER_ID)
    renamed = await repository.get_by_name(USER_ID, "writer-pro")
    assert await repository.get_by_name(USER_ID, "writer") is None
    assert renamed is not None
    assert renamed.id == writer.id
    assert [skill.id for skill in skills] == [writer.id, researcher.id]


async def test_toggle(initialized_store: None) -> None:
    """Final database state:

    {
      "skills": [
        {
          "name": "translator",
          "enabled": true
        }
      ]
    }

    Checks:
    1. Disabling a Skill persists the off state returned by later reads.
    2. Enabling the same Skill restores it without changing its identity.
    """
    repository = SkillRepository()
    skill = await repository.create(
        USER_ID,
        name="translator",
        description="Translate documents",
        skill_dir="/skills/translator",
        group="imported",
        source="github",
        source_uri="https://github.com/example/translator",
    )
    assert skill.id is not None

    # Check 1: Disabling a Skill persists the off state returned by later reads.
    disabled = await repository.set_enabled(USER_ID, skill.id, False)
    loaded_disabled = await repository.get(USER_ID, skill.id)
    assert disabled is not None
    assert disabled.enabled is False
    assert loaded_disabled is not None
    assert loaded_disabled.enabled is False

    # Check 2: Enabling the same Skill restores it without changing its identity.
    enabled = await repository.set_enabled(USER_ID, skill.id, True)
    assert enabled is not None
    assert enabled.id == skill.id
    assert enabled.enabled is True


async def test_builtin_refresh(initialized_store: None) -> None:
    """Final database state:

    {
      "skills": [
        {
          "id": "<stable builtin id>",
          "name": "documents",
          "description": "Create and edit documents",
          "skill_dir": "/builtin/documents-v2",
          "group": "builtin",
          "source": "local",
          "source_uri": "app://documents-v2",
          "enabled": false
        }
      ]
    }

    Checks:
    1. Ensuring a built-in Skill creates its product-owned catalogue row.
    2. Refreshing that Skill updates product metadata without creating a duplicate.
    3. Refreshing preserves the user's disabled switch and the Skill's stable id.
    """
    repository = SkillRepository()

    # Check 1: Ensuring a built-in Skill creates its product-owned catalogue row.
    original = await repository.ensure_builtin(
        USER_ID,
        name="documents",
        description="Create documents",
        skill_dir="/builtin/documents",
        source="local",
        source_uri="app://documents",
    )
    assert original.id is not None
    assert original.group == "builtin"
    assert original.enabled is True

    disabled = await repository.set_enabled(USER_ID, original.id, False)
    assert disabled is not None
    assert disabled.enabled is False

    # Check 2: Refreshing that Skill updates product metadata without creating a duplicate.
    refreshed = await repository.ensure_builtin(
        USER_ID,
        name="documents",
        description="Create and edit documents",
        skill_dir="/builtin/documents-v2",
        source="local",
        source_uri="app://documents-v2",
    )
    skills = await repository.list_for_user(USER_ID)
    assert len(skills) == 1
    assert refreshed.description == "Create and edit documents"
    assert refreshed.skill_dir == "/builtin/documents-v2"
    assert refreshed.group == "builtin"
    assert refreshed.source == "local"
    assert refreshed.source_uri == "app://documents-v2"

    # Check 3: Refreshing preserves the user's disabled switch and the Skill's stable id.
    assert refreshed.id == original.id
    assert refreshed.enabled is False


async def test_delete(initialized_store: None) -> None:
    """Final database state:

    {
      "skills": [
        {
          "name": "documents",
          "group": "builtin"
        }
      ],
      "removed_skill": "imported-writer"
    }

    Checks:
    1. Deleting an imported Skill removes it from direct and catalogue reads.
    2. Deleting the same imported Skill again reports that nothing was removed.
    3. A built-in Skill cannot be deleted and remains available.
    """
    repository = SkillRepository()
    imported = await repository.create(
        USER_ID,
        name="imported-writer",
        description="Write documents",
        skill_dir="/skills/imported-writer",
        group="imported",
        source="github",
        source_uri="https://github.com/example/writer",
    )
    builtin = await repository.ensure_builtin(
        USER_ID,
        name="documents",
        description="Create documents",
        skill_dir="/builtin/documents",
        source="local",
        source_uri="app://documents",
    )
    assert imported.id is not None
    assert builtin.id is not None

    # Check 1: Deleting an imported Skill removes it from direct and catalogue reads.
    deleted = await repository.delete(USER_ID, imported.id)
    assert deleted is True
    assert await repository.get(USER_ID, imported.id) is None
    assert await repository.get_by_name(USER_ID, "imported-writer") is None

    # Check 2: Deleting the same imported Skill again reports that nothing was removed.
    assert await repository.delete(USER_ID, imported.id) is False

    # Check 3: A built-in Skill cannot be deleted and remains available.
    assert await repository.delete(USER_ID, builtin.id) is False
    remaining = await repository.list_for_user(USER_ID)
    assert [skill.id for skill in remaining] == [builtin.id]
