"""``SkillLibrary`` runtime loading — the agent-facing catalogue.

Distinct from ``test_skills.py`` (which covers the ``/skills`` management API):
here we assert what the *agent runtime* actually loads. The management list
shows every skill including disabled ones, but a disabled skill MUST NOT reach
the agent — it should not be advertised in the prompt nor be loadable via
``load_skill``. That filtering lives in ``SkillLibrary.load()``.
"""

from __future__ import annotations

from src.amphi_agent import AmphiContext, AmphiOTAContext, SkillLibrary
from src.amphi_agent._cognitive import ExploreThink, MainThink
from src.amphi_store import SkillRepository

USER_ID = "local"
BUILTIN_NAMES = set(SkillLibrary.builtin_names())


async def test_load_excludes_disabled_skills(service_app) -> None:
    """A disabled skill is absent from the loaded runtime catalogue."""
    _ = service_app  # drives the lifespan that calls Repository.connect()
    repo = SkillRepository()
    enabled = await repo.create(
        USER_ID,
        name="web-scraper",
        description="Scrape and clean web pages.",
        skill_dir="/skills/web-scraper",
        group="imported",
        source="github",
        source_uri="https://github.com/example/web-scraper",
    )
    disabled = await repo.create(
        USER_ID,
        name="feishu-bot",
        description="Feishu messaging and bot management.",
        skill_dir="/skills/feishu-bot",
        group="imported",
        source="github",
        source_uri="https://github.com/example/feishu-bot",
    )
    await repo.set_enabled(USER_ID, id=disabled.id, enabled=False)

    lib = await SkillLibrary(USER_ID).load()
    loaded = lib.data()

    assert set(loaded) == BUILTIN_NAMES | {enabled.name}
    assert loaded[enabled.name].skill_id == enabled.id
    assert disabled.name not in loaded


async def test_explore_worker_alone_selects_disabled_how_to(service_app) -> None:
    _ = service_app
    repo = SkillRepository()
    lib = await SkillLibrary(USER_ID).load()
    builtin = await repo.get_by_name(USER_ID, "how-to")
    assert builtin is not None and builtin.id is not None
    other = await repo.create(
        USER_ID,
        name="future-builtin",
        description="A future product Skill.",
        skill_dir="/skills/future-builtin",
        group="builtin",
        source="local",
        source_uri="builtin://future-builtin",
    )

    await repo.set_enabled(USER_ID, id=builtin.id, enabled=False)
    await repo.set_enabled(USER_ID, id=other.id, enabled=False)
    lib = await SkillLibrary(USER_ID).load()
    context = AmphiContext(skills=lib)
    ota_context = AmphiOTAContext()

    assert "how-to" not in lib.data()
    assert {"how-to", "future-builtin"}.issubset(lib.all_data())
    assert "how-to" not in MainThink().select_skills(ota_context, context)
    explore = ExploreThink().select_skills(ota_context, context)
    assert "how-to" in explore
    assert "future-builtin" not in explore
