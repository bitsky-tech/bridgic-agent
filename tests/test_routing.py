"""_routing.py 单测:三分类映射、JSONL 追加、汇总渲染、perm_dir 缺失容错。"""

from __future__ import annotations

from pathlib import Path

from src.amphi_agent.security._routing import (
    AUTO_PASS,
    CLASSIFIED,
    RULE_TERMINAL,
    append_routing,
    render_summary,
    routing_category,
)
from src.amphi_service.i18n import use_locale


def test_routing_category_maps_three_buckets() -> None:
    assert routing_category(True, "allow") == CLASSIFIED
    assert routing_category(True, "ask") == CLASSIFIED
    assert routing_category(False, "allow") == AUTO_PASS
    assert routing_category(False, "ask") == RULE_TERMINAL
    assert routing_category(False, "deny") == RULE_TERMINAL


def _rec(tool: str, category: str, verdict: str, ms: float | None = None) -> dict:
    return {
        "tool": tool,
        "summary": f"{tool} call",
        "capability": "execute",
        "boundary": "none",
        "category": category,
        "verdict": verdict,
        "batch_elapsed_ms": ms,
    }


def test_append_then_render_summary(tmp_path: Path) -> None:
    append_routing(tmp_path, [
        _rec("web_fetch", CLASSIFIED, "allow", ms=1200),
        _rec("read_file", AUTO_PASS, "allow"),
    ])
    append_routing(tmp_path, [_rec("bash", RULE_TERMINAL, "deny")])

    jsonl = tmp_path / "_routing.jsonl"
    assert jsonl.is_file()
    assert len(jsonl.read_text(encoding="utf-8").splitlines()) == 3

    out = render_summary(tmp_path)
    assert out is not None and out.name == "_routing_summary.md"
    text = out.read_text(encoding="utf-8")
    assert "Total calls: 3" in text
    assert "Model review (classified): 1" in text
    assert "No approval needed (auto_pass): 1" in text
    assert "Rule-layer decision (rule_terminal): 1" in text
    assert "web_fetch" in text and "read_file" in text and "bash" in text


def test_none_perm_dir_is_noop(tmp_path: Path) -> None:
    append_routing(None, [_rec("x", CLASSIFIED, "allow")])
    assert render_summary(None) is None
    # 无日志文件时 render 返回 None,不抛。
    assert render_summary(tmp_path) is None


def test_new_routing_summary_follows_the_active_backend_locale(tmp_path: Path) -> None:
    append_routing(tmp_path, [_rec("web_fetch", CLASSIFIED, "allow", ms=1200)])

    with use_locale("en"):
        out = render_summary(tmp_path)

    assert out is not None
    text = out.read_text(encoding="utf-8")
    assert "# Permission routing summary (session)" in text
    assert "- Total calls: 1" in text
    assert "## Model review (classified): 1" in text
