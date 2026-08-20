"""Prompt-caching prerequisite: a byte-stable request prefix.

Anthropic (and OpenAI) prompt caching is a prefix match over tools → system →
messages. The SYSTEM block used to embed live state — the Workspace
"Changed files" lines (git status, changes after every file write) and the
browser tab list — so every tool round that touched a file invalidated the
whole cached prefix. That live state now rides in a ``<runtime_state>`` USER
tail appended by ``thinking()`` to the END of each request (never persisted),
keeping SYSTEM and the replayed history byte-stable within a turn.
"""

from __future__ import annotations

from types import SimpleNamespace

from bridgic.core.model.types import Message, Role

from src.amphi_agent import AmphiContext, AmphiOTAContext
from src.amphi_agent._cognitive import VOLATILE_TAIL_EXTRA, MainThink


def _fake_workspace(changed: list[str]) -> SimpleNamespace:
    """Checkpoints surface for ``runtime_state_block`` plus the stable attributes
    ``workspace_block`` renders into SYSTEM (dirs, mounts, environment)."""
    return SimpleNamespace(
        checkpoints=SimpleNamespace(
            changed_files_context_lines=lambda **_kw: list(changed),
            checkpoint_context_lines=lambda **_kw: [],
        ),
        work_dir=SimpleNamespace(is_dir=lambda: False),
        mount_roots=lambda: [],
        build=None,
        run_workflow=None,
        build_checkpoint=lambda: None,
        run_workflow_checkpoint=lambda: None,
        environment=SimpleNamespace(
            os_name="Darwin", os_release="25.0.0", architecture="arm64",
            python_executable=None, python_version=None,
            node_executable=None, node_version=None,
        ),
    )


class _FakeTab(SimpleNamespace):
    pass


def _fake_browser(title: str) -> SimpleNamespace:
    tab = _FakeTab(title=title, url="https://example.com/")

    async def state():
        return SimpleNamespace(tabs=[tab], active_tab=tab)

    return SimpleNamespace(state=state)


def _context(**kw) -> AmphiContext:
    return AmphiContext.model_construct(**kw)


async def test_system_contains_no_live_state() -> None:
    """Changed-files and browser tabs must not appear in SYSTEM — they change
    mid-turn and would invalidate the cached prefix on every file write."""
    worker = MainThink()
    ota = AmphiOTAContext(user_input="test")
    context = _context(browser=_fake_browser("Cache Docs"))

    system = (await worker.assemble_messages(ota, context))[0].content

    assert "<Workspace>" in system
    assert "Changed files" not in system
    # The persona legitimately mentions the literal "<browser>" tag in its
    # instructions — assert on the LIVE data instead (tab title / tab list).
    assert "Cache Docs" not in system and "tab=1" not in system


async def test_runtime_state_block_carries_changed_files_and_browser() -> None:
    worker = MainThink()
    ota = AmphiOTAContext(user_input="test")
    context = _context(
        workspace=_fake_workspace(["- Changed files:", "  - Modified: a.txt (+1 lines, -0 lines)"]),
        browser=_fake_browser("Cache Docs"),
    )

    block = await worker.runtime_state_block(ota, context)

    assert block.startswith("<runtime_state>") and block.endswith("</runtime_state>")
    assert "Modified: a.txt" in block
    assert "Cache Docs" in block


async def test_runtime_state_block_empty_without_live_state() -> None:
    worker = MainThink()
    ota = AmphiOTAContext(user_input="test")
    assert await worker.runtime_state_block(ota, _context()) == ""


async def test_append_runtime_state_adds_volatile_user_tail() -> None:
    """The tail is a USER message flagged ``volatile_tail`` so the adapters can
    keep it out of the cached prefix; nothing is appended when state is empty."""
    worker = MainThink()
    ota = AmphiOTAContext(user_input="test")
    base = [Message.from_text("sys", role=Role.SYSTEM), Message.from_text("go", role=Role.USER)]

    with_state = await worker.append_runtime_state(
        list(base), ota, _context(workspace=_fake_workspace(["- Changed files:", "  - New File: x"]))
    )
    assert len(with_state) == len(base) + 1
    tail = with_state[-1]
    assert tail.role == Role.USER
    assert (tail.extras or {}).get(VOLATILE_TAIL_EXTRA) is True
    assert "New File: x" in tail.content

    without = await worker.append_runtime_state(list(base), ota, _context())
    assert len(without) == len(base)


async def test_system_is_byte_stable_while_live_state_changes() -> None:
    """Two rounds of the same turn with different changed-files / browser state
    must produce the identical SYSTEM text — only the volatile tail may differ."""
    worker = MainThink()
    ota = AmphiOTAContext(user_input="test")
    round1 = _context(
        workspace=_fake_workspace(["- Changed files: none"]),
        browser=_fake_browser("Round One"),
    )
    round2 = _context(
        workspace=_fake_workspace(["- Changed files:", "  - New File: notes.txt (+3 lines, -0 lines)"]),
        browser=_fake_browser("Round Two"),
    )

    system1 = (await worker.assemble_messages(ota, round1))[0].content
    system2 = (await worker.assemble_messages(ota, round2))[0].content
    assert system1 == system2

    tail1 = await worker.runtime_state_block(ota, round1)
    tail2 = await worker.runtime_state_block(ota, round2)
    assert tail1 != tail2


def test_usage_pair_counts_anthropic_cache_tokens() -> None:
    """Anthropic's ``input_tokens`` EXCLUDES cache reads/writes; the meter must
    fold them in so turn totals stay comparable once caching is live."""
    usage = SimpleNamespace(
        input_tokens=14,
        output_tokens=9,
        cache_creation_input_tokens=200,
        cache_read_input_tokens=8000,
    )
    assert MainThink._usage_pair(usage) == (14 + 200 + 8000, 9)
    # OpenAI shape: prompt_tokens already includes cached tokens — unchanged.
    assert MainThink._usage_pair({"prompt_tokens": 50, "completion_tokens": 5}) == (50, 5)


def test_volatile_tail_constant_is_consistent_across_layers() -> None:
    """The adapters duplicate the marker value to avoid importing the agent
    layer — a drift would silently break cache placement / wire stripping."""
    from src.amphi_service.protocol.llms.anthropic_llm import _VOLATILE_TAIL_EXTRA as anth
    from src.amphi_service.protocol.llms.openai_llm import _VOLATILE_TAIL_EXTRA as oai

    assert anth == oai == VOLATILE_TAIL_EXTRA
