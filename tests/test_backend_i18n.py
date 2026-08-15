"""Backend-owned localization policy and transport integration coverage."""

from __future__ import annotations

import httpx
import pytest

from src.amphi_agent._agent import AmphiAgent
from src.amphi_agent._context import AmphiContext, AmphiOTAContext
from src.amphi_agent._session import Session
from src.amphi_agent._workflows import WorkflowLibrary
from src.amphi_service.i18n import (
    BackendI18n,
    backend_i18n,
    detect_locale,
    locale_from_accept_language,
    use_locale,
)
from src.amphi_agent.tools._request_human import RequestHumanChoice


class _NullStream:
    """``init_state`` publishes stage events; the tests only care about the locale."""

    def publish(self, event: str, **payload: object) -> None:
        pass


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("en-US,en;q=0.9,zh-CN;q=0.8", "en"),
        ("zh-TW,zh;q=0.9,en;q=0.8", "zh"),
        ("fr-FR,fr;q=0.9", "zh"),
        (None, "zh"),
        # RFC 9110: q=0 means "not acceptable". Ranking without dropping those picks the
        # one language the client explicitly refused.
        ("fr, en;q=0", "zh"),
        ("fr, zh;q=0, en;q=0.5", "en"),
        # RFC 9110 allows optional whitespace around ';' — the tag itself must be
        # trimmed or 'en ' fails the supported-locale check and the entry is lost.
        ("en ;q=0.9", "en"),
        ("en ; q=0.9, fr", "en"),
        # A malformed q must not inherit the default 1.0 and outrank a well-formed
        # entry; it ranks below every valid one, keeping its source order.
        ("en;q=0.9, zh;q=bad", "en"),
        ("zh;q=bad, en;q=bad", "zh"),
        # q is 0..1 by RFC; inf/nan/1e5 are malformed, not super-priorities.
        ("zh, en;q=1e5", "zh"),
        ("zh;q=0.5, en;q=nan", "zh"),
    ],
)
def test_accept_language_selects_a_supported_backend_locale(
    header: str | None,
    expected: str,
) -> None:
    assert locale_from_accept_language(header) == expected


@pytest.mark.parametrize(
    ("texts", "expected"),
    [
        (("汇总昨天的 pull request",), "zh"),
        (("Summarise yesterday's pull requests",), "en"),
        # Any Chinese at all means the author reads Chinese; a mostly-English body does not
        # change that, which is why this is a presence test rather than a ratio.
        (("每天跑一次 `git log --oneline --since=yesterday` 并汇总",), "zh"),
        # Fenced English embedded in a Chinese task must not flip the result.
        (("整理下面这段的输出\n```\nERROR: build failed on linux-amd64\n```\n",), "zh"),
        # Chinese inside a code fence is not the author writing Chinese — the fence is data.
        (("Summarise this\n```\n错误：构建失败\n```\n",), "en"),
        # No signal at all → None, so the caller can fall back to its own default rather
        # than having one silently baked in here.
        (("/Users/foo/reports/daily.py",), None),
        (("",), None),
        ((None,), None),
        ((), None),
        # Multiple messages: the most recent one carrying a signal wins, so a signal-less
        # latest turn ("/tmp/x") still resolves from what the user said before.
        (("请帮我看看这个", "/Users/foo/x.py"), "zh"),
        (("Take a look at this", "/Users/foo/x.py"), "en"),
        # A later language switch wins over the earlier turns.
        (("请帮我看看这个", "actually, answer in English from now on"), "en"),
        # A one-word acknowledgement is not a language switch. Chinese speakers type these
        # constantly, and treating two Latin letters as "the user writes English" flipped a
        # whole Chinese session's display text the moment someone approved a step.
        (("帮我看看这个中文任务", "ok"), "zh"),
        (("帮我看看这个中文任务", "yes"), "zh"),
        (("帮我看看这个中文任务", "y"), "zh"),
        (("帮我看看这个中文任务", "go"), "zh"),
        # Same rule with nothing earlier to fall back on: no verdict, so the caller keeps
        # whatever language the client stated.
        (("ok",), None),
        # Chinese needs no such threshold — a CJK character is unambiguous evidence, while
        # Latin letters show up in commands, identifiers and loanwords.
        (("好的",), "zh"),
        (("嗯",), "zh"),
        # Chinese glues to paths without whitespace, so the CJK check must run BEFORE
        # path stripping — otherwise the whole sentence is one path-like token and the
        # only evidence is deleted (worst case: the leftover Latin words flip it to en).
        (("帮我看下src/main.py有什么问题",), "zh"),
        (("跑一下tests/unit里的用例 as soon as possible",), "zh"),
        (("备份/Users/nice/照片到网盘",), "zh"),
        # Deliberate consequence of CJK-before-paths: CJK inside a quoted path counts
        # as evidence, consistent with the single-character rule above.
        (("see src/报告/notes.md",), "zh"),
        # Residual limitation, pinned: a path-heavy English phrase still loses its
        # two-word quorum. Callers fall back to the declared connection locale.
        (("Sync notes/todo.md",), None),
    ],
)
def test_detect_locale_reads_the_language_the_user_wrote_in(
    texts: tuple[str | None, ...],
    expected: str | None,
) -> None:
    assert detect_locale(*texts) == expected


def test_render_input_intent_sentence_is_deterministic_over_persisted_blocks() -> None:
    """The /build intent sentence feeds the model prompt and is re-rendered on every
    resume of the same persisted turn. Its language derives from the turn's own text —
    a pure function of the persisted blocks — so a locale change between the original
    turn and a later resume can never re-render the same turn differently."""
    from src.amphi_agent._cognitive import render_input

    zh_build = {
        "input": "/build 抓取每日汇率",
        "blocks": [
            {"type": "slash", "id": "build", "label": "构建"},
            {"type": "text", "value": " 抓取每日汇率"},
        ],
    }
    en_build = {
        "input": "/build fetch daily fx rates",
        "blocks": [
            {"type": "slash", "id": "build", "label": "Build"},
            {"type": "text", "value": " fetch daily fx rates"},
        ],
    }
    with use_locale("en"):
        zh_rendered = render_input(zh_build)
    with use_locale("zh"):
        zh_rendered_again = render_input(zh_build)
        en_rendered = render_input(en_build)

    assert zh_rendered == zh_rendered_again
    assert zh_rendered.startswith("我明确要求")
    assert en_rendered.startswith("I explicitly request")


def test_backend_catalog_closure_covers_every_static_id_in_both_locales() -> None:
    """Backend twin of the desktop's i18n-coverage test: every statically-written
    message id in src/** must resolve in BOTH locales, and every catalog entry
    must carry both — the id domain (e.g. _classify._label) and the catalog live
    in different packages with nothing but convention tying them together, and a
    drift crashes the permission gate at runtime instead of failing here."""
    import re as _re
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent / "src"
    used: set[str] = set()
    for path in root.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        used.update(_re.findall(r"backend_i18n\.text\(\s*['\"]([a-z0-9_.]+)['\"]", text))
        used.update(_re.findall(r"['\"](security\.label\.[a-z0-9_]+)['\"]", text))
    assert used, "the scan itself must find call sites — an empty set means the regex broke"

    catalog = BackendI18n._messages
    missing = sorted(mid for mid in used if mid not in catalog)
    assert not missing, f"ids used in src/** but absent from the catalog: {missing}"
    incomplete = sorted(mid for mid, variants in catalog.items() if set(variants) != {"zh", "en"})
    assert not incomplete, f"catalog entries missing a locale: {incomplete}"


def test_label_text_fails_soft_on_an_unknown_id() -> None:
    """The permission gate must degrade, not die: an out-of-catalog label id
    renders as the id itself instead of raising KeyError through evaluate →
    permission_check → the whole turn."""
    from src.amphi_agent.security._classify import label_text

    assert label_text("security.label.does_not_exist") == "security.label.does_not_exist"


def test_backend_catalog_is_private_and_renders_each_locale() -> None:
    i18n = BackendI18n()

    assert i18n.text("provider.api_key_required", locale="zh") == "API Key 不能为空"
    assert i18n.text("provider.api_key_required", locale="en") == "API key is required."


def test_default_empty_choice_label_follows_the_active_backend_locale() -> None:
    with use_locale("en"):
        question = RequestHumanChoice.normalize_questions({
            "questions": [{
                "question": "Choose applicable items",
                "multiSelect": True,
                "allowEmpty": True,
                "options": [{"label": "A"}, {"label": "B"}],
            }],
        })[0]

    assert question["emptyLabel"] == "Select none"


async def test_rest_error_uses_accept_language_without_changing_its_payload(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post(
        "/me/providers/test",
        headers={"Accept-Language": "en-US,en;q=0.9"},
        json={
            "provider_id": "openai",
            "protocol": "openai",
            "api_key": "   ",
            "model": "gpt-4o",
        },
    )

    assert response.status_code == 200
    assert response.json() == {"ok": False, "error": "API key is required."}


async def test_input_language_outranks_the_connection_locale() -> None:
    """The UI language setting is the fallback, not the authority.

    Everything the model writes already follows the user's input language
    (``_prompt.py``'s CRITICAL language rule). The backend's own display text —
    security labels, conflict cards, tool returns — has to follow the same signal, or a
    single approval card ends up carrying an English reason next to a Chinese label.
    """
    with use_locale("zh"):
        await AmphiAgent().init_state(
            AmphiOTAContext(user_input="Please delete /tmp/report.csv", stream=_NullStream()),
            AmphiContext(session=Session(), workflows=WorkflowLibrary("user")),
        )
        assert backend_i18n.current_locale() == "en"


async def test_connection_locale_survives_a_signal_less_request() -> None:
    """A bare path carries no language, so the client's stated language still decides."""
    with use_locale("zh"):
        await AmphiAgent().init_state(
            AmphiOTAContext(user_input="/tmp/report.csv", stream=_NullStream()),
            AmphiContext(session=Session(), workflows=WorkflowLibrary("user")),
        )
        assert backend_i18n.current_locale() == "zh"
