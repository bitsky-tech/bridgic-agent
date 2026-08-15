"""Long-term memory recall ranking — ``_rank_memories`` / ``_tokenize``.

Unit tests on the keyword ranking behind ``MemoryRepository.recall``: overlap
gating, overlap-then-recency ordering, and the limit cap, on ``Memory`` rows
directly (no DB, no HTTP).

The chat-injection E2E (a stored memory surfacing in the system prompt of a
later chat) is deferred until the memory loop is re-wired through the two-loop
chat path; the /me/memories CRUD surface is covered by ``test_me``.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from src.amphi_store._memory import Memory, _rank_memories, _tokenize


def _mem(content: str, day: int) -> Memory:
    return Memory(
        user_id="u",
        content=content,
        source="manual",
        created_at=datetime(2026, 1, 1) + timedelta(days=day),
    )


def test_recall_ranking() -> None:
    """The whole keyword ranking in one pass: tokenize lowercases and drops <3-char
    terms; no overlap (or a query of only short terms) recalls nothing; rows order by
    distinct-term overlap then recency (ties → newest first); and the limit caps the
    returned count."""
    # tokenize lowercases + drops <3-char terms.
    assert _tokenize("Go to the DB now") == ["the", "now"]

    # no overlap, or a query of only short terms → nothing.
    assert _rank_memories([_mem("prefers tabs over spaces", day=1)],
                          "what is the deploy command", limit=5) == []
    assert _rank_memories([_mem("anything at all", day=1)], "a is to", limit=5) == []

    # overlap-then-recency ordering: 2-term overlap wins; ties break newest first.
    both = _mem("deploy command is make prod", day=1)   # overlap 2
    older_one = _mem("deploy notes", day=2)             # overlap 1
    newer_one = _mem("deploy notes copy", day=3)        # overlap 1
    ranked = _rank_memories([both, older_one, newer_one], "deploy command", limit=5)
    assert ranked[0] is both           # 2-term overlap wins
    assert ranked[1] is newer_one      # tie on overlap → newest first
    assert ranked[2] is older_one

    # the limit caps the returned count.
    many = [_mem(f"deploy item {i}", day=i) for i in range(10)]
    assert len(_rank_memories(many, "deploy", limit=3)) == 3
