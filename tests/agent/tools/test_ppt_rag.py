import json
import re
import zipfile
from pathlib import Path
from typing import Any

from bridgic.core.model.types import Message, Response, Role

from src.amphi_agent._state import PresentationChapterOutline, PresentationSlideOutline, PresentationStageState
from src.amphi_agent.ppt_rag import LocalPPTTemplateCatalog, build_ppt_search_profile, build_ppt_template_index
from src.amphi_agent.tools._ppt_rag import ppt_rag
from tests.agent.tools._harness import ToolHarness


PRESENTATION_XML = """\
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>
"""

THEME_XML = """\
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements>
    <a:clrScheme name="Test"><a:accent1><a:srgbClr val="9B0000"/></a:accent1></a:clrScheme>
    <a:fontScheme name="Test"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont></a:fontScheme>
  </a:themeElements>
</a:theme>
"""


def _write_deck(path: Path, slide_texts: list[str], thumbnail: bytes | None = None, renderable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("ppt/presentation.xml", PRESENTATION_XML)
        archive.writestr("ppt/theme/theme1.xml", THEME_XML)
        if renderable:
            archive.writestr("[Content_Types].xml", "")
            archive.writestr("_rels/.rels", "")
        if thumbnail is not None:
            archive.writestr("docProps/thumbnail.jpeg", thumbnail)
        for index, text in enumerate(slide_texts, start=1):
            archive.writestr(
                f"ppt/slides/slide{index}.xml",
                f'<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
            )


def _state() -> PresentationStageState:
    slides = [
        PresentationSlideOutline(id="slide-001", title="人工智能研究报告", content_outline=["核心结论"]),
        PresentationSlideOutline(id="slide-002", title="研究议程", content_outline=["目录"]),
        PresentationSlideOutline(id="slide-003", title="2024—2026 研究里程碑", content_outline=["时间线"]),
        PresentationSlideOutline(id="slide-004", title="谢谢", content_outline=["交流"]),
    ]
    return PresentationStageState(
        stage="ppt_plan",
        step_index=2,
        goal="制作一份中国风学术研究汇报",
        outline=[PresentationChapterOutline(id="chapter-001", title="研究", slides=slides)],
        outline_confirmed=True,
    )


def test_local_ppt_index_and_retrieval(tmp_path: Path) -> None:
    """The local catalogue preserves stable ids, page roles, previews, and incremental reuse."""
    source = tmp_path / "templates"
    first = source / "【2】学术主题" / "1.pptx"
    second = source / "【3】绝美中国风" / "1.pptx"
    _write_deck(first, ["学术研究", "目录", "2024 2025 研究历程", "谢谢"], thumbnail=b"embedded-cover")
    _write_deck(second, ["水墨山水", "第一章", "古风图文", "感谢观看"], thumbnail=b"chinese-cover")
    preview = second.parent / "预览" / "1.png"
    preview.parent.mkdir(parents=True)
    preview.write_bytes(b"preview")
    index_path = tmp_path / "index.json"

    initial = build_ppt_template_index(source, index_path, "pku-seed", "北京大学")
    refreshed = build_ppt_template_index(source, index_path, "pku-seed", "北京大学")

    assert initial["stats"] == {"discovered": 2, "indexed": 2, "reused": 0, "failed": 0}
    assert refreshed["stats"]["reused"] == 2
    assert initial["schema_version"] == 3
    assert initial["indexer_version"] == 6
    assert len({item["id"] for item in initial["templates"]}) == 2
    chinese = next(item for item in initial["templates"] if "chinese" in item["style_tags"])
    academic = next(item for item in initial["templates"] if item is not chinese)
    assert chinese["aspect_ratio"] == "16:9"
    assert chinese["colors"] == ["#9B0000"]
    assert chinese["fonts"] == ["Aptos Display"]
    assert chinese["role_counts"]["cover"] == 1
    assert chinese["role_counts"]["closing"] == 1
    assert Path(chinese["preview_paths"][0]).read_bytes() == b"chinese-cover"
    assert chinese["preview_paths"][1] == str(preview)
    assert len(academic["preview_paths"]) == 1
    assert Path(academic["preview_paths"][0]).read_bytes() == b"embedded-cover"
    assert Path(academic["preview_paths"][0]).parent == tmp_path / "index.assets" / "previews"
    assert Path(academic["preview_paths"][0]).name.endswith("-slide-001.jpeg")
    assert len(chinese["slide_examples"]) == 4
    assert "layout_catalog" in chinese
    assert "masters" in chinese
    assert chinese["description"]["overview"]
    assert chinese["description"]["overview_source"] == "structural_index"
    assert chinese["description"]["best_for"]
    assert "traditional-chinese" in chinese["search_profile"]["subcategory_ids"]
    assert chinese["search_profile"]["density_level"] in {"low", "medium", "high"}
    assert chinese["search_profile"]["representative_slides"]
    taxonomy = LocalPPTTemplateCatalog(index_path).taxonomy()
    assert any(item["id"] == "culture-storytelling" for item in taxonomy["categories"])

    profile = build_ppt_search_profile(_state(), "水墨、留白")
    result = LocalPPTTemplateCatalog(index_path).list_candidates(["traditional-chinese"])
    assert result["provider"] == "local"
    assert result["candidates"][0]["template_id"] == chinese["id"]
    assert "score" not in result["candidates"][0]
    assert "PowerPoint template" in result["candidates"][0]["overview"]
    assert profile["required_roles"] == {"cover": 1, "agenda": 1, "timeline": 1, "closing": 1, "content": 1}
    details = LocalPPTTemplateCatalog(index_path).details([chinese["id"]])
    assert details["templates"][0]["available"] is True
    assert details["templates"][0]["preview_available"] is True
    assert details["templates"][0]["representative_slides"]

    legacy = json.loads(index_path.read_text(encoding="utf-8"))
    legacy["indexer_version"] = 2
    for template in legacy["templates"]:
        template.pop("description", None)
    index_path.write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")
    legacy_candidates = LocalPPTTemplateCatalog(index_path).list_candidates(["traditional-chinese"])
    assert legacy_candidates["candidates"][0]["overview"]
    assert legacy_candidates["candidates"][0]["overview_source"] == "structural_index"


def test_local_ppt_index_renders_representative_preview_pages(monkeypatch: Any, tmp_path: Path) -> None:
    """The offline index keeps a cover and a bounded set of structurally varied pages."""
    source = tmp_path / "templates"
    deck = source / "story.pptx"
    _write_deck(
        deck,
        ["封面", "目录", "第一章", "2024 2025 时间线", "A vs B 对比", "普通内容", "谢谢"],
        renderable=True,
    )

    monkeypatch.setattr("src.amphi_agent.ppt_rag.shutil.which", lambda command: f"/tools/{command}")

    def fake_run(arguments: list[str], **_: Any) -> Any:
        class Result:
            returncode = 0

        if "--convert-to" in arguments:
            output_root = Path(arguments[arguments.index("--outdir") + 1])
            output_root.joinpath(f"{deck.stem}.pdf").write_bytes(b"pdf")
        else:
            slide_number = arguments[arguments.index("-f") + 1]
            Path(arguments[-1]).with_suffix(".jpg").write_bytes(f"slide-{slide_number}".encode())
        return Result()

    monkeypatch.setattr("src.amphi_agent.ppt_rag.subprocess.run", fake_run)

    payload = build_ppt_template_index(source, tmp_path / "index.json")
    previews = payload["templates"][0]["preview_paths"]

    assert len(previews) == 6
    assert Path(previews[0]).name.endswith("-slide-001.jpg")
    assert all(Path(path).is_file() for path in previews)
    assert all("-slide-" in Path(path).stem for path in previews)


async def test_ppt_rag_lets_the_model_read_markdown_and_select(tool_harness: ToolHarness, monkeypatch: Any, tmp_path: Path) -> None:
    """The public tool classifies once, then lets the model compare every matching overview."""
    source = tmp_path / "templates"
    _write_deck(source / "【2】学术主题" / "1.pptx", ["研究", "目录", "2024 2025 里程碑", "谢谢"])
    _write_deck(source / "【3】绝美中国风" / "2.pptx", ["水墨", "章节", "山水", "谢谢"])
    preview_root = source / "【3】绝美中国风" / "预览" / "2"
    preview_root.mkdir(parents=True)
    for index in range(1, 7):
        preview_root.joinpath(f"幻灯片{index}.png").write_bytes(f"preview-{index}".encode())
    index_path = tmp_path / "index.json"
    index = build_ppt_template_index(source, index_path, "pku-seed", "北京大学")
    preferred_id = index["templates"][1]["id"]
    calls: list[list[Message]] = []

    class RecordingLlm:
        async def achat(self, messages: list[Message], **_: Any) -> Response:
            calls.append(messages)
            if len(calls) == 1:
                payload = {"subcategory_ids": ["traditional-chinese"]}
            else:
                described_ids = re.findall(r"Template ID: `([^`]+)`", messages[1].content)
                payload = {"template_ids": [preferred_id, *[value for value in described_ids if value != preferred_id]][:2]}
            return Response(message=Message.from_text(json.dumps(payload, ensure_ascii=False), role=Role.AI))

    monkeypatch.setenv("BRIDGIC_PPT_RAG_INDEX", str(index_path))
    tool_harness.ota_context.transition_think(_state())
    tool_harness.agent._llm = RecordingLlm()

    result = json.loads(await ppt_rag("水墨、留白", limit=2))

    assert len(calls) == 2
    assert all([message.role for message in call] == [Role.SYSTEM, Role.USER] for call in calls)
    assert "# Available template taxonomy" in calls[0][1].content
    assert "# Candidate template descriptions" in calls[1][1].content
    assert "## 1." in calls[1][1].content
    assert "- Overview:" in calls[1][1].content
    assert "- Signature elements:" in calls[1][1].content
    assert "- Planned content:" in calls[1][1].content
    assert "核心结论" in calls[1][1].content
    assert '"candidates":[' not in calls[1][1].content
    assert result["retrieval_mode"] == "agentic_category_selection"
    assert result["agentic_trace"]["classification_widened"] is True
    assert result["agentic_trace"]["described_template_count"] == 2
    assert result["agentic_trace"]["selected_template_ids"][0] == preferred_id
    assert result["candidates"][0]["template_id"] == preferred_id
    assert "agentic_reason" not in result["candidates"][0]
    assert "agentic_fit" not in result["candidates"][0]
    assert "agentic_use_for_roles" not in result["candidates"][0]
    assert len(result["candidates"][0]["preview_paths"]) == 6
    assert result["candidates"][0]["structural_evidence"]["representative_slides"]
    assert result["candidates"][0]["materialize_ref"]["provider"] == "local"


async def test_ppt_rag_retries_invalid_model_selection_without_using_rules(tool_harness: ToolHarness, monkeypatch: Any, tmp_path: Path) -> None:
    """An invalid model choice gets one strict retry instead of invoking a custom ranker."""
    source = tmp_path / "templates"
    _write_deck(source / "【3】绝美中国风" / "1.pptx", ["水墨", "章节", "山水", "谢谢"])
    index_path = tmp_path / "index.json"
    build_ppt_template_index(source, index_path, "pku-seed", "北京大学")
    calls: list[list[Message]] = []

    class InvalidLlm:
        async def achat(self, messages: list[Message], **_: Any) -> Response:
            calls.append(messages)
            if len(calls) == 1:
                payload = {"subcategory_ids": ["traditional-chinese"]}
                return Response(message=Message.from_text(json.dumps(payload, ensure_ascii=False), role=Role.AI))
            if len(calls) == 2:
                return Response(message=Message.from_text("not-json", role=Role.AI))
            template_id = re.findall(r"Template ID: `([^`]+)`", messages[1].content)[0]
            return Response(message=Message.from_text(json.dumps({"template_ids": [template_id]}), role=Role.AI))

    monkeypatch.setenv("BRIDGIC_PPT_RAG_INDEX", str(index_path))
    tool_harness.ota_context.transition_think(_state())
    tool_harness.agent._llm = InvalidLlm()

    result = json.loads(await ppt_rag("水墨、留白", limit=1))

    assert result["candidates"][0]["template_id"]
    assert len(calls) == 3
    assert "# Output correction" in calls[2][1].content


async def test_ppt_rag_returns_recoverable_failure_after_retry(tool_harness: ToolHarness, monkeypatch: Any, tmp_path: Path) -> None:
    """Two invalid responses produce a skippable failure instead of an unverified shortlist."""
    source = tmp_path / "templates"
    _write_deck(source / "【3】绝美中国风" / "1.pptx", ["水墨", "章节", "山水", "谢谢"])
    index_path = tmp_path / "index.json"
    build_ppt_template_index(source, index_path, "pku-seed", "北京大学")
    calls: list[list[Message]] = []

    class InvalidLlm:
        async def achat(self, messages: list[Message], **_: Any) -> Response:
            calls.append(messages)
            content = json.dumps({"subcategory_ids": ["traditional-chinese"]}) if len(calls) == 1 else "not-json"
            return Response(message=Message.from_text(content, role=Role.AI))

    monkeypatch.setenv("BRIDGIC_PPT_RAG_INDEX", str(index_path))
    tool_harness.ota_context.transition_think(_state())
    tool_harness.agent._llm = InvalidLlm()

    result = json.loads(await ppt_rag("水墨、留白", limit=1))

    assert len(calls) == 3
    assert "# Output correction" in calls[-1][1].content
    assert result["status"] == "retrieval_failed"
    assert result["failure_code"] == "selection_failed"
    assert result["candidates"] == []
    assert "after one retry" in result["retrieval_error"]


async def test_ppt_rag_moves_past_excluded_candidate_batches(tool_harness: ToolHarness, monkeypatch: Any, tmp_path: Path) -> None:
    """Repeated retrieval advances beyond the original bounded recall window."""
    source = tmp_path / "templates"
    for index in range(28):
        _write_deck(
            source / "【2】学术主题" / f"{index:02d}.pptx",
            [f"研究报告 {index}", "目录", "研究进展", "谢谢"],
        )
    index_path = tmp_path / "index.json"
    build_ppt_template_index(source, index_path, "paging-test", "北京大学")
    monkeypatch.setenv("BRIDGIC_PPT_RAG_INDEX", str(index_path))
    state = _state()
    calls: list[list[Message]] = []

    class PagingLlm:
        async def achat(self, messages: list[Message], **_: Any) -> Response:
            calls.append(messages)
            if len(calls) % 2 == 1:
                payload = {"subcategory_ids": ["academic-research"]}
            else:
                template_ids = re.findall(r"Template ID: `([^`]+)`", messages[1].content)
                payload = {"template_ids": template_ids[:8]}
            return Response(message=Message.from_text(json.dumps(payload, ensure_ascii=False), role=Role.AI))

    tool_harness.agent._llm = PagingLlm()
    seen: set[str] = set()

    for _ in range(3):
        tool_harness.ota_context.transition_think(state)
        result = json.loads(await ppt_rag(limit=8))
        batch = {candidate["template_id"] for candidate in result["candidates"]}
        assert len(batch) == 8
        assert batch.isdisjoint(seen)
        seen.update(batch)
        state = state.model_copy(update={"template_excluded_ids": sorted(seen)})

    tool_harness.ota_context.transition_think(state)
    final = json.loads(await ppt_rag(limit=8))
    final_batch = {candidate["template_id"] for candidate in final["candidates"]}

    assert len(final_batch) == 4
    assert final_batch.isdisjoint(seen)
    assert len(calls) == 8


async def test_ppt_rag_widens_after_the_classified_batch_is_exhausted(tool_harness: ToolHarness, monkeypatch: Any, tmp_path: Path) -> None:
    """A refresh can leave its original category while still excluding prior candidates."""
    source = tmp_path / "templates"
    _write_deck(source / "plain.pptx", ["普通封面", "内容", "谢谢"])
    _write_deck(source / "中国风.pptx", ["水墨山水", "内容", "谢谢"])
    index_path = tmp_path / "index.json"
    index = build_ppt_template_index(source, index_path, "refresh-test", "北京大学")
    plain_template = next(item for item in index["templates"] if item["relative_path"] == "plain.pptx")
    plain_id = plain_template["id"]
    assert "technology" not in plain_template["search_profile"]["semantic_tags"]
    chinese_id = next(item["id"] for item in index["templates"] if item["relative_path"] == "中国风.pptx")
    monkeypatch.setenv("BRIDGIC_PPT_RAG_INDEX", str(index_path))
    tool_harness.ota_context.transition_think(
        _state().model_copy(update={"template_excluded_ids": [plain_id]}),
    )

    class WideningLlm:
        async def achat(self, messages: list[Message], **_: Any) -> Response:
            payload = (
                {"subcategory_ids": ["general-purpose"]}
                if "# Available template taxonomy" in messages[1].content
                else {"template_ids": [chinese_id]}
            )
            return Response(message=Message.from_text(json.dumps(payload, ensure_ascii=False), role=Role.AI))

    tool_harness.agent._llm = WideningLlm()
    result = json.loads(await ppt_rag(limit=1))

    assert result["agentic_trace"]["classification_widened"] is True
    assert result["candidates"][0]["template_id"] == chinese_id
