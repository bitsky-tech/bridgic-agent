"""Local-first PowerPoint template indexing and retrieval contracts."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Protocol, Sequence
from xml.etree import ElementTree


PPT_RAG_SCHEMA_VERSION = 3
PPT_RAG_INDEXER_VERSION = 6
PPT_RAG_PREVIEW_LIMIT = 6
PPT_RAG_INDEX_ENV = "BRIDGIC_PPT_RAG_INDEX"
PPT_RAG_DEFAULT_INDEX = Path("~/.bridgic/AmphiAgent/ppt-rag/index.json")
_PPTX_SUFFIXES = frozenset({".pptx", ".potx"})
_SLIDE_RE = re.compile(r"^ppt/slides/slide(\d+)\.xml$")
_TOKEN_RE = re.compile(r"[a-z0-9]+|[\u4e00-\u9fff]{2,}", re.IGNORECASE)
_YEAR_RE = re.compile(r"(?:19|20)\d{2}")

_PML = "http://schemas.openxmlformats.org/presentationml/2006/main"
_DML = "http://schemas.openxmlformats.org/drawingml/2006/main"
_REL = "http://schemas.openxmlformats.org/package/2006/relationships"

_SEMANTIC_TAGS = {
    "peking-university": ("北京大学", "北大", "pku", "peking university"),
    "academic": ("学术", "研究", "课题", "论文", "答辩", "教育", "教学", "academic", "research", "thesis"),
    "thesis-defense": ("论文答辩", "毕业答辩", "开题", "中期", "答辩", "thesis", "defense"),
    "chinese": ("中国风", "国风", "古风", "传统", "水墨", "山水", "书法", "chinese"),
    "business": ("商务", "商业", "公司", "产品", "市场", "汇报", "business", "corporate", "product"),
    "minimal": ("简约", "极简", "留白", "minimal", "clean"),
    "technology": ("科技", "技术", "人工智能", "数字", "technology", "tech", "ai"),
}

_TAXONOMY_BLUEPRINT = (
    {
        "id": "academic-education",
        "name": "Academic & Education",
        "description": "Research, teaching, thesis defense, and university-facing presentations.",
        "subcategories": (
            {"id": "thesis-defense", "name": "Thesis Defense", "description": "Defense, proposal, review, and graduation presentations.", "semantic_tags": ("thesis-defense",)},
            {"id": "academic-research", "name": "Academic Research", "description": "Research reports, lectures, and scholarly communication.", "semantic_tags": ("academic",)},
            {"id": "university-branded", "name": "University Branded", "description": "Institutional decks carrying a university visual identity.", "semantic_tags": ("peking-university",)},
        ),
    },
    {
        "id": "culture-storytelling",
        "name": "Culture & Storytelling",
        "description": "Narrative-led presentations with cultural or editorial visual language.",
        "subcategories": (
            {"id": "traditional-chinese", "name": "Traditional Chinese", "description": "Chinese ink, heritage, calligraphy, and classical aesthetics.", "semantic_tags": ("chinese",)},
        ),
    },
    {
        "id": "business-technology",
        "name": "Business & Technology",
        "description": "Corporate reporting, product communication, and technology topics.",
        "subcategories": (
            {"id": "business-reporting", "name": "Business Reporting", "description": "Business plans, company updates, product, and market reports.", "semantic_tags": ("business",)},
            {"id": "technology-innovation", "name": "Technology & Innovation", "description": "Technology, digital transformation, and AI presentations.", "semantic_tags": ("technology",)},
        ),
    },
    {
        "id": "general-visual",
        "name": "General Visual Systems",
        "description": "Broadly reusable visual systems selected mainly by tone and layout flexibility.",
        "subcategories": (
            {"id": "minimal-clean", "name": "Minimal & Clean", "description": "Restrained, spacious, and low-decoration visual systems.", "semantic_tags": ("minimal",)},
            {"id": "general-purpose", "name": "General Purpose", "description": "Neutral templates for topics without a specialist visual requirement.", "semantic_tags": ("general",)},
        ),
    },
)


def default_ppt_rag_index_path() -> Path:
    """Return the local index path, honoring a test or deployment override."""
    override = os.environ.get(PPT_RAG_INDEX_ENV)
    return Path(override).expanduser() if override else PPT_RAG_DEFAULT_INDEX.expanduser()


def _natural_key(value: str) -> List[Any]:
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", value)]


def _contains_semantic_keyword(text: str, keyword: str) -> bool:
    """Match short Latin tags as complete tokens while retaining CJK phrase matching."""
    if re.fullmatch(r"[a-z0-9]+", keyword, flags=re.IGNORECASE):
        return re.search(rf"(?<![a-z0-9]){re.escape(keyword)}(?![a-z0-9])", text, flags=re.IGNORECASE) is not None
    return keyword.casefold() in text.casefold()


def _read_xml(archive: zipfile.ZipFile, name: str) -> Optional[ElementTree.Element]:
    try:
        return ElementTree.fromstring(archive.read(name))
    except (KeyError, ElementTree.ParseError):
        return None


def _text(root: ElementTree.Element) -> str:
    parts = [node.text.strip() for node in root.iter(f"{{{_DML}}}t") if node.text and node.text.strip()]
    return " ".join(parts)


def _classify_slide(text: str, slide_number: int, slide_count: int, pictures: int, tables: int, charts: int) -> str:
    lowered = text.casefold()
    if any(token in lowered for token in ("谢谢", "感谢", "thank you", "questions", "q&a")):
        return "closing"
    if slide_number == 1:
        return "cover"
    if any(token in lowered for token in ("目录", "议程", "contents", "agenda")):
        return "agenda"
    if tables:
        return "table"
    if charts:
        return "data"
    if len(_YEAR_RE.findall(text)) >= 2 or any(token in lowered for token in ("时间线", "历程", "里程碑", "timeline", "milestone")):
        return "timeline"
    if any(token in lowered for token in ("对比", "比较", "vs", "versus", "优劣", "差异")):
        return "comparison"
    if pictures >= 2 and len(text) <= 140:
        return "image"
    if len(text) <= 70 and any(token in lowered for token in ("章", "篇", "part", "section")):
        return "section"
    if slide_number == slide_count and len(text) <= 100:
        return "closing"
    return "content"


def _aspect_ratio(presentation: Optional[ElementTree.Element]) -> str:
    if presentation is None:
        return "unknown"
    size = presentation.find(f".//{{{_PML}}}sldSz")
    if size is None:
        return "unknown"
    try:
        ratio = int(size.attrib["cx"]) / int(size.attrib["cy"])
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return "unknown"
    for label, expected in (("16:9", 16 / 9), ("16:10", 16 / 10), ("4:3", 4 / 3)):
        if math.isclose(ratio, expected, abs_tol=0.025):
            return label
    return f"{ratio:.3f}:1"


def _theme_metadata(archive: zipfile.ZipFile) -> tuple[List[str], List[str]]:
    colors: List[str] = []
    fonts: List[str] = []
    for name in sorted((item for item in archive.namelist() if item.startswith("ppt/theme/theme") and item.endswith(".xml")), key=_natural_key):
        root = _read_xml(archive, name)
        if root is None:
            continue
        for node in root.iter():
            tag = node.tag.rsplit("}", maxsplit=1)[-1]
            if tag in {"srgbClr", "sysClr"}:
                value = node.attrib.get("val") or node.attrib.get("lastClr")
                if value and re.fullmatch(r"[0-9a-fA-F]{6}", value):
                    colors.append("#" + value.upper())
            typeface = node.attrib.get("typeface")
            if typeface and not typeface.startswith("+"):
                fonts.append(typeface)
    return list(dict.fromkeys(colors))[:12], list(dict.fromkeys(fonts))[:12]


def _relationship_target(archive: zipfile.ZipFile, name: str, relationship_suffix: str) -> Optional[str]:
    root = _read_xml(archive, name)
    if root is None:
        return None
    for node in root.iter(f"{{{_REL}}}Relationship"):
        if node.attrib.get("Type", "").endswith(relationship_suffix):
            target = node.attrib.get("Target")
            return Path(target).stem if target else None
    return None


def _presentation_structure(archive: zipfile.ZipFile) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    master_names = sorted((name for name in archive.namelist() if re.fullmatch(r"ppt/slideMasters/slideMaster\d+\.xml", name)), key=_natural_key)
    layout_names = sorted((name for name in archive.namelist() if re.fullmatch(r"ppt/slideLayouts/slideLayout\d+\.xml", name)), key=_natural_key)
    masters: List[Dict[str, Any]] = []
    for name in master_names:
        root = _read_xml(archive, name)
        common = root.find(f".//{{{_PML}}}cSld") if root is not None else None
        masters.append({"id": Path(name).stem, "name": common.attrib.get("name") if common is not None else None})
    layouts: List[Dict[str, Any]] = []
    for name in layout_names:
        root = _read_xml(archive, name)
        common = root.find(f".//{{{_PML}}}cSld") if root is not None else None
        placeholders = Counter(
            node.attrib.get("type") or "body"
            for node in (root.findall(f".//{{{_PML}}}ph") if root is not None else [])
        )
        relationship_name = str(Path(name).parent / "_rels" / f"{Path(name).name}.rels")
        layouts.append({
            "id": Path(name).stem,
            "name": common.attrib.get("name") if common is not None else None,
            "master_id": _relationship_target(archive, relationship_name, "/slideMaster"),
            "placeholder_counts": dict(placeholders),
        })
    return masters, layouts


def _path_tags(relative_path: Path) -> tuple[List[str], List[str]]:
    searchable = " ".join(relative_path.parts).casefold()
    categories: List[str] = []
    styles: List[str] = []
    for tag, keywords in _SEMANTIC_TAGS.items():
        if any(_contains_semantic_keyword(searchable, keyword) for keyword in keywords):
            (categories if tag in {"peking-university", "academic", "thesis-defense", "business"} else styles).append(tag)
    return categories, styles


def _matched_semantic_tags(values: Iterable[str]) -> List[str]:
    combined = " ".join(value for value in values if value).casefold()
    return sorted(
        tag
        for tag, keywords in _SEMANTIC_TAGS.items()
        if any(_contains_semantic_keyword(combined, keyword) for keyword in keywords)
    )


def _template_search_profile(template: Dict[str, Any]) -> Dict[str, Any]:
    slide_examples = template.get("slide_examples") or []
    semantic_tags = sorted(
        set(template.get("category_tags") or [])
        | set(template.get("style_tags") or [])
        | set(_matched_semantic_tags([str(template.get("brand_scope") or "")]))
        | set(_matched_semantic_tags(str(slide.get("title") or "") for slide in slide_examples))
    )
    average_text = sum(int(slide.get("text_length") or 0) for slide in slide_examples) / max(1, len(slide_examples))
    density_level = "low" if average_text < 90 else "medium" if average_text < 220 else "high"
    role_counts = Counter(template.get("role_counts") or {})
    average_pictures = sum(int(slide.get("picture_count") or 0) for slide in slide_examples) / max(1, len(slide_examples))
    strengths: List[str] = []
    if len(role_counts) >= 5:
        strengths.append("role-diverse")
    if average_pictures >= 1:
        strengths.append("image-forward")
    if role_counts.get("data") or role_counts.get("table"):
        strengths.append("data-ready")
    if role_counts.get("timeline"):
        strengths.append("timeline-ready")
    if role_counts.get("comparison"):
        strengths.append("comparison-ready")
    if len(template.get("layout_catalog") or []) >= 6:
        strengths.append("layout-variety")
    if template.get("masters") and template.get("layout_catalog"):
        strengths.append("master-backed")

    representative: List[Dict[str, Any]] = []
    seen_slides: set[int] = set()
    for role in ("cover", "agenda", "section", "timeline", "data", "comparison", "image", "closing", "content"):
        slide = next((item for item in slide_examples if item.get("role") == role and item.get("slide_number") not in seen_slides), None)
        if slide is None:
            continue
        slide_number = int(slide.get("slide_number") or 0)
        seen_slides.add(slide_number)
        representative.append({
            "slide_number": slide_number,
            "role": slide.get("role"),
            "title": slide.get("title"),
            "layout_id": slide.get("layout_id"),
            "picture_count": slide.get("picture_count") or 0,
            "chart_count": slide.get("chart_count") or 0,
            "table_count": slide.get("table_count") or 0,
        })
        if len(representative) == 8:
            break

    subcategory_ids: List[str] = []
    tag_set = set(semantic_tags)
    for category in _TAXONOMY_BLUEPRINT:
        for subcategory in category["subcategories"]:
            if subcategory["id"] == "general-purpose":
                continue
            if tag_set.intersection(subcategory["semantic_tags"]):
                subcategory_ids.append(subcategory["id"])
    specialist_ids = {"thesis-defense", "academic-research", "traditional-chinese", "business-reporting", "technology-innovation", "minimal-clean"}
    if not set(subcategory_ids).intersection(specialist_ids):
        subcategory_ids.append("general-purpose")
    return {
        "semantic_tags": semantic_tags,
        "subcategory_ids": list(dict.fromkeys(subcategory_ids)),
        "density_level": density_level,
        "strengths": strengths,
        "representative_slides": representative,
        "layout_summary": {
            "master_count": len(template.get("masters") or []),
            "layout_count": len(template.get("layout_catalog") or []),
            "named_layouts": [str(item.get("name")) for item in (template.get("layout_catalog") or []) if item.get("name")][:12],
        },
    }


def _template_description(template: Dict[str, Any]) -> Dict[str, Any]:
    """Build a factual prose overview that an LLM can compare without reading JSON."""
    profile = template.get("search_profile") or _template_search_profile(template)
    semantic_tags = [str(value) for value in profile.get("semantic_tags") or [] if value]
    role_counts = Counter(template.get("role_counts") or {})
    ordered_roles = sorted(role_counts.items(), key=lambda item: (-int(item[1]), str(item[0])))
    best_for = [f"{role} pages ({count})" for role, count in ordered_roles[:6]]
    colors = [str(value) for value in template.get("colors") or [] if value][:6]
    fonts = [str(value) for value in template.get("fonts") or [] if value][:6]
    layout_summary = profile.get("layout_summary") or {}
    named_layouts = [str(value) for value in layout_summary.get("named_layouts") or [] if value][:8]
    representative_titles = [
        str(slide.get("title"))
        for slide in profile.get("representative_slides") or []
        if isinstance(slide, dict) and slide.get("title")
    ][:6]

    signature_elements: List[str] = []
    if colors:
        signature_elements.append("theme palette " + ", ".join(colors))
    if fonts:
        signature_elements.append("font families " + ", ".join(fonts))
    if named_layouts:
        signature_elements.append("named layouts " + ", ".join(named_layouts))
    if template.get("preview_paths"):
        signature_elements.append(f"{len(template['preview_paths'])} indexed preview asset(s)")

    aspect_ratio = str(template.get("aspect_ratio") or "unknown aspect ratio")
    slide_count = int(template.get("slide_count") or 0)
    density = str(profile.get("density_level") or "unknown")
    overview_parts = [
        f"A {aspect_ratio} PowerPoint template with {slide_count} slides and {density}-density text.",
    ]
    if semantic_tags:
        overview_parts.append("Indexed visual and subject signals: " + ", ".join(semantic_tags) + ".")
    if best_for:
        overview_parts.append("Its page inventory is concentrated in " + ", ".join(best_for) + ".")
    if representative_titles:
        overview_parts.append("Representative page text includes: " + " / ".join(representative_titles) + ".")

    return {
        "overview": " ".join(overview_parts),
        "visual_style": semantic_tags,
        "best_for": best_for,
        "signature_elements": signature_elements,
        "overview_source": "structural_index",
    }


def _build_taxonomy(templates: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    counts = Counter(
        subcategory_id
        for template in templates
        for subcategory_id in (template.get("search_profile") or {}).get("subcategory_ids", [])
    )
    categories: List[Dict[str, Any]] = []
    for category in _TAXONOMY_BLUEPRINT:
        subcategories = [
            {**subcategory, "semantic_tags": list(subcategory["semantic_tags"]), "template_count": counts[subcategory["id"]]}
            for subcategory in category["subcategories"]
            if counts[subcategory["id"]]
        ]
        if not subcategories:
            continue
        categories.append({
            "id": category["id"],
            "name": category["name"],
            "description": category["description"],
            "template_count": len({template["id"] for template in templates if set((template.get("search_profile") or {}).get("subcategory_ids", [])).intersection(item["id"] for item in subcategories)}),
            "subcategories": subcategories,
        })
    return {"categories": categories}


def _preview_paths(path: Path, generated_root: Optional[Path] = None, template_id: Optional[str] = None) -> List[str]:
    preview_root = path.parent / "预览"
    direct = [
        candidate
        for candidate in preview_root.iterdir()
        if candidate.is_file()
        and candidate.stem.casefold() == path.stem.casefold()
        and candidate.suffix.casefold() in {".png", ".jpg", ".jpeg", ".webp"}
    ] if preview_root.is_dir() else []
    nested_root = preview_root / path.stem
    nested = list(nested_root.rglob("*")) if nested_root.is_dir() else []
    manual = direct + [candidate for candidate in nested if candidate.is_file() and candidate.suffix.casefold() in {".png", ".jpg", ".jpeg", ".webp"}]
    generated: List[Path] = []
    if generated_root is not None and template_id and generated_root.is_dir():
        generated = [
            candidate
            for candidate in generated_root.iterdir()
            if candidate.is_file()
            and candidate.stem.startswith(f"{template_id}-slide-")
            and candidate.suffix.casefold() in {".png", ".jpg", ".jpeg", ".webp"}
        ]
    generated = sorted(set(generated), key=lambda item: _natural_key(str(item)))
    generated_cover = [candidate for candidate in generated if "-slide-001" in candidate.stem]
    generated_representatives = [candidate for candidate in generated if candidate not in generated_cover]
    ordered = [
        *generated_cover,
        *sorted(set(manual), key=lambda item: _natural_key(str(item))),
        *generated_representatives,
    ]
    return [
        str(candidate)
        for candidate in dict.fromkeys(item.resolve() for item in ordered)
    ][:PPT_RAG_PREVIEW_LIMIT]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _index_template(path: Path, source_root: Path, source_id: str, brand_scope: Optional[str], license_scope: str, generated_preview_root: Path) -> Dict[str, Any]:
    relative_path = path.relative_to(source_root)
    stat = path.stat()
    content_hash = _sha256(path)
    template_id = "ppt-" + hashlib.sha256(f"{source_id}:{relative_path.as_posix()}".encode("utf-8")).hexdigest()[:16]

    def write_generated_preview(data: bytes, slide_number: int, suffix: str) -> Optional[Path]:
        if not data:
            return None
        try:
            generated_preview_root.mkdir(parents=True, exist_ok=True)
            target = generated_preview_root / f"{template_id}-slide-{slide_number:03d}{suffix}"
            if not target.is_file() or target.read_bytes() != data:
                temporary = target.with_name(target.name + ".tmp")
                temporary.write_bytes(data)
                temporary.replace(target)
            for sibling in generated_preview_root.glob(f"{template_id}-slide-{slide_number:03d}.*"):
                if sibling != target and sibling.suffix.casefold() in {".png", ".jpg", ".jpeg", ".webp"}:
                    sibling.unlink(missing_ok=True)
            if slide_number == 1:
                for legacy_preview in generated_preview_root.glob(f"{template_id}.*"):
                    if legacy_preview.suffix.casefold() in {".png", ".jpg", ".jpeg", ".webp"}:
                        legacy_preview.unlink(missing_ok=True)
            return target.resolve()
        except OSError:
            return None

    def extract_embedded_preview(archive: zipfile.ZipFile) -> Optional[Path]:
        names = {
            name.casefold(): name
            for name in archive.namelist()
            if name.casefold().startswith("docprops/thumbnail.")
        }
        for suffix in (".png", ".jpg", ".jpeg", ".webp"):
            name = names.get(f"docprops/thumbnail{suffix}")
            if name:
                return write_generated_preview(archive.read(name), 1, suffix)
        return None

    def render_preview_slides(slide_numbers: Sequence[int]) -> List[Path]:
        soffice = shutil.which("soffice")
        pdftoppm = shutil.which("pdftoppm")
        if not soffice or not pdftoppm:
            return []
        try:
            with tempfile.TemporaryDirectory(prefix="bridgic-ppt-preview-") as temporary_directory:
                temporary_root = Path(temporary_directory)
                profile_root = temporary_root / "libreoffice-profile"
                converted = subprocess.run(
                    [soffice, f"-env:UserInstallation={profile_root.as_uri()}", "--headless", "--convert-to", "pdf", "--outdir", str(temporary_root), str(path)],
                    capture_output=True,
                    timeout=90,
                )
                pdf_path = temporary_root / f"{path.stem}.pdf"
                if converted.returncode != 0 or not pdf_path.is_file():
                    return []
                previews: List[Path] = []
                for slide_number in slide_numbers:
                    output_prefix = temporary_root / f"slide-{slide_number:03d}"
                    rendered = subprocess.run(
                        [pdftoppm, "-f", str(slide_number), "-l", str(slide_number), "-singlefile", "-jpeg", "-r", "96", str(pdf_path), str(output_prefix)],
                        capture_output=True,
                        timeout=30,
                    )
                    image_path = output_prefix.with_suffix(".jpg")
                    if rendered.returncode != 0 or not image_path.is_file():
                        continue
                    target = write_generated_preview(image_path.read_bytes(), slide_number, ".jpg")
                    if target is not None:
                        previews.append(target)
                return previews
        except (OSError, subprocess.SubprocessError):
            return []

    manual_previews = _preview_paths(path)
    previews = list(manual_previews)
    embedded_preview: Optional[Path] = None
    renderable = False
    with zipfile.ZipFile(path) as archive:
        renderable = "[Content_Types].xml" in archive.namelist() and "_rels/.rels" in archive.namelist()
        embedded_preview = extract_embedded_preview(archive)
        if embedded_preview is not None:
            previews = list(dict.fromkeys([str(embedded_preview), *manual_previews]))[:PPT_RAG_PREVIEW_LIMIT]
        slide_names = sorted((name for name in archive.namelist() if _SLIDE_RE.match(name)), key=_natural_key)
        if not slide_names:
            raise ValueError("presentation contains no readable slides")
        slide_count = len(slide_names)
        presentation = _read_xml(archive, "ppt/presentation.xml")
        colors, fonts = _theme_metadata(archive)
        masters, layout_catalog = _presentation_structure(archive)
        slide_examples: List[Dict[str, Any]] = []
        for index, name in enumerate(slide_names, start=1):
            root = _read_xml(archive, name)
            if root is None:
                continue
            text = _text(root)
            pictures = len(root.findall(f".//{{{_PML}}}pic"))
            shapes = len(root.findall(f".//{{{_PML}}}sp"))
            tables = len(root.findall(f".//{{{_DML}}}tbl"))
            charts = sum(1 for node in root.findall(f".//{{{_DML}}}graphicData") if "chart" in node.attrib.get("uri", "").casefold())
            relationship_name = str(Path(name).parent / "_rels" / f"{Path(name).name}.rels")
            slide_examples.append({
                "id": f"slide-{index:03d}",
                "slide_number": index,
                "layout_id": _relationship_target(archive, relationship_name, "/slideLayout"),
                "role": _classify_slide(text, index, slide_count, pictures, tables, charts),
                "title": text[:160] or None,
                "text_length": len(text),
                "picture_count": pictures,
                "shape_count": shapes,
                "chart_count": charts,
                "table_count": tables,
            })
    role_counts = dict(Counter(slide["role"] for slide in slide_examples))
    categories, styles = _path_tags(Path(source_root.name) / relative_path)
    if not categories:
        categories = ["general"]
    coverage = min(1.0, len(role_counts) / 7)
    preview_score = 1.0 if previews else 0.0
    size_score = 1.0 if 5 <= slide_count <= 60 else 0.65
    quality_score = round(0.45 + 0.25 * coverage + 0.15 * preview_score + 0.15 * size_score, 4)
    title = path.stem if not path.stem.isdigit() else f"{relative_path.parent.name if relative_path.parent != Path('.') else '北京大学'}模板 {path.stem}"
    template = {
        "id": template_id,
        "source_id": source_id,
        "version": content_hash[:16],
        "content_hash": content_hash,
        "local_path": str(path.resolve()),
        "relative_path": relative_path.as_posix(),
        "title": title,
        "format": path.suffix.casefold().lstrip("."),
        "brand_scope": brand_scope,
        "license_scope": license_scope,
        "file_size": stat.st_size,
        "modified_ns": stat.st_mtime_ns,
        "aspect_ratio": _aspect_ratio(presentation),
        "slide_count": slide_count,
        "category_tags": categories,
        "style_tags": styles,
        "colors": colors,
        "fonts": fonts,
        "role_counts": role_counts,
        "preview_paths": previews,
        "quality_score": quality_score,
        "masters": masters,
        "layout_catalog": layout_catalog,
        "slide_examples": slide_examples,
    }
    template["search_profile"] = _template_search_profile(template)
    if renderable:
        representative_numbers = [
            int(slide["slide_number"])
            for slide in template["search_profile"]["representative_slides"]
            if slide.get("slide_number")
        ]
        preview_slide_numbers = sorted(
            list(dict.fromkeys([1, *representative_numbers]))[:PPT_RAG_PREVIEW_LIMIT],
        )
        rendered_previews = render_preview_slides(preview_slide_numbers)
        if rendered_previews:
            retained_generated = {
                item.resolve()
                for item in [embedded_preview, *rendered_previews]
                if item is not None and item.is_file()
            }
            for stale_preview in generated_preview_root.glob(f"{template_id}-slide-*.*"):
                if stale_preview.resolve() not in retained_generated and stale_preview.suffix.casefold() in {".png", ".jpg", ".jpeg", ".webp"}:
                    stale_preview.unlink(missing_ok=True)
            generated_cover = next(
                (item for item in rendered_previews if "-slide-001" in item.stem),
                embedded_preview if embedded_preview is not None and embedded_preview.is_file() else None,
            )
            generated_representatives = [item for item in rendered_previews if item != generated_cover]
            previews = [
                *([str(generated_cover)] if generated_cover is not None else []),
                *manual_previews,
                *(str(item) for item in generated_representatives),
            ]
            previews = list(dict.fromkeys(previews))[:PPT_RAG_PREVIEW_LIMIT]
            template["preview_paths"] = previews
    template["description"] = _template_description(template)
    return template


def build_ppt_template_index(source_root: Path, output_path: Optional[Path] = None, source_id: str = "local-seed", brand_scope: Optional[str] = None, license_scope: str = "local_test_only") -> Dict[str, Any]:
    """Build or incrementally refresh one local PPT template catalogue."""
    source_root = source_root.expanduser().resolve()
    if not source_root.is_dir():
        raise ValueError(f"PPT template source does not exist or is not a directory: {source_root}")
    output_path = output_path.expanduser() if output_path is not None else default_ppt_rag_index_path()
    generated_preview_root = output_path.parent / f"{output_path.stem}.assets" / "previews"
    previous: Dict[str, Dict[str, Any]] = {}
    if output_path.is_file():
        try:
            old_index = json.loads(output_path.read_text(encoding="utf-8"))
            if old_index.get("schema_version") == PPT_RAG_SCHEMA_VERSION and old_index.get("indexer_version") == PPT_RAG_INDEXER_VERSION:
                previous = {item["relative_path"]: item for item in old_index.get("templates", []) if isinstance(item, dict) and item.get("relative_path")}
        except (OSError, ValueError, TypeError):
            previous = {}

    templates_by_relative: Dict[str, Dict[str, Any]] = {}
    errors: List[Dict[str, str]] = []
    reused = 0
    pending_paths: List[Path] = []
    paths = sorted((path for path in source_root.rglob("*") if path.is_file() and path.suffix.casefold() in _PPTX_SUFFIXES), key=lambda item: _natural_key(item.relative_to(source_root).as_posix()))
    for path in paths:
        relative = path.relative_to(source_root).as_posix()
        stat = path.stat()
        cached = previous.get(relative)
        template_id = "ppt-" + hashlib.sha256(f"{source_id}:{relative}".encode("utf-8")).hexdigest()[:16]
        preview_paths = _preview_paths(path, generated_preview_root, template_id)
        cache_valid = (
            cached is not None
            and cached.get("file_size") == stat.st_size
            and cached.get("modified_ns") == stat.st_mtime_ns
            and cached.get("source_id") == source_id
            and cached.get("brand_scope") == brand_scope
            and cached.get("license_scope") == license_scope
            and cached.get("preview_paths") == preview_paths
        )
        if cache_valid:
            templates_by_relative[relative] = cached
            reused += 1
            continue
        pending_paths.append(path)

    def index_path(path: Path) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
        try:
            return _index_template(path, source_root, source_id, brand_scope, license_scope, generated_preview_root), None
        except (OSError, ValueError, KeyError, zipfile.BadZipFile) as exc:
            return None, str(exc)

    if pending_paths:
        with ThreadPoolExecutor(max_workers=min(4, len(pending_paths)), thread_name_prefix="ppt-index") as executor:
            for path, (template, error) in zip(pending_paths, executor.map(index_path, pending_paths)):
                relative = path.relative_to(source_root).as_posix()
                if template is not None:
                    templates_by_relative[relative] = template
                else:
                    errors.append({"relative_path": relative, "error": error or "unknown indexing error"})

    templates = [
        templates_by_relative[path.relative_to(source_root).as_posix()]
        for path in paths
        if path.relative_to(source_root).as_posix() in templates_by_relative
    ]

    generated_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "schema_version": PPT_RAG_SCHEMA_VERSION,
        "indexer_version": PPT_RAG_INDEXER_VERSION,
        "index_id": hashlib.sha256(f"{source_id}:{source_root}".encode("utf-8")).hexdigest()[:16],
        "generated_at": generated_at,
        "sources": [{
            "id": source_id,
            "kind": "local_directory",
            "root": str(source_root),
            "brand_scope": brand_scope,
            "license_scope": license_scope,
            "template_count": len(templates),
        }],
        "taxonomy": _build_taxonomy(templates),
        "templates": templates,
        "errors": errors,
        "stats": {"discovered": len(paths), "indexed": len(templates), "reused": reused, "failed": len(errors)},
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(output_path.name + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(output_path)
    return payload


def _tokens(values: Iterable[str]) -> set[str]:
    result: set[str] = set()
    combined = " ".join(values).casefold()
    result.update(_TOKEN_RE.findall(combined))
    for tag, keywords in _SEMANTIC_TAGS.items():
        if any(_contains_semantic_keyword(combined, keyword) for keyword in keywords):
            result.add(tag)
    return result


def infer_page_roles(values: Iterable[str]) -> Counter[str]:
    """Infer the layout roles needed by an outline or free-form query."""
    items = [value for value in values if value.strip()]
    roles: Counter[str] = Counter()
    for index, value in enumerate(items):
        lowered = value.casefold()
        role = "content"
        if len(items) >= 3 and index == 0:
            role = "cover"
        elif len(items) >= 3 and index == len(items) - 1:
            role = "closing"
        elif any(token in lowered for token in ("目录", "议程", "agenda", "contents")):
            role = "agenda"
        elif any(token in lowered for token in ("时间线", "历程", "里程碑", "timeline", "milestone")) or len(_YEAR_RE.findall(value)) >= 2:
            role = "timeline"
        elif any(token in lowered for token in ("数据", "趋势", "增长", "占比", "chart", "data")):
            role = "data"
        elif any(token in lowered for token in ("表格", "清单", "table")):
            role = "table"
        elif any(token in lowered for token in ("对比", "比较", "差异", "versus", " vs ")):
            role = "comparison"
        elif any(token in lowered for token in ("图片", "照片", "画廊", "image", "photo")):
            role = "image"
        elif any(token in lowered for token in ("章节", "章", "篇", "part", "section")):
            role = "section"
        roles[role] += 1
    roles["cover"] = max(1, roles["cover"])
    roles["content"] = max(1, roles["content"])
    roles["closing"] = max(1, roles["closing"])
    return roles


def build_ppt_search_profile(state: Any, preferences: Optional[str] = None) -> Dict[str, Any]:
    """Project presentation state into the provider-neutral retrieval request."""
    def requested_aspect_ratio(value: Optional[str]) -> Optional[str]:
        if not value:
            return None
        normalized = value.replace("：", ":")
        for aspect in ("16:9", "16:10", "4:3"):
            if re.search(rf"(?<!\d){re.escape(aspect)}(?!\d)", normalized.replace(" ", "")):
                return aspect
        return None

    values: List[str] = []
    goal = str(getattr(state, "goal", "") or "").strip()
    if goal:
        values.append(goal)
    outline = getattr(state, "outline", None) or []
    slide_count = 0
    slide_descriptions: List[str] = []
    for chapter in outline:
        for value in (getattr(chapter, "title", None), getattr(chapter, "summary", None)):
            if value:
                values.append(str(value))
        for slide in getattr(chapter, "slides", None) or []:
            slide_count += 1
            description_parts: List[str] = []
            for value in (getattr(slide, "title", None), getattr(slide, "purpose", None), getattr(slide, "key_message", None)):
                if value:
                    values.append(str(value))
                    description_parts.append(str(value))
            content_outline = [str(item) for item in (getattr(slide, "content_outline", None) or []) if item]
            values.extend(content_outline)
            description_parts.extend(content_outline)
            slide_descriptions.append(" ".join(description_parts))
    query_tags = sorted(_tokens(values))
    preference_tags = sorted(_tokens([preferences.strip()])) if preferences and preferences.strip() else []
    if preferences and preferences.strip():
        values.append(preferences.strip())
    return {
        "goal": goal or None,
        "preferences": preferences.strip() if preferences and preferences.strip() else None,
        "slide_count": slide_count or None,
        "aspect_ratio": requested_aspect_ratio(preferences),
        "query_text": "\n".join(values),
        "query_tags": query_tags,
        "preference_tags": preference_tags,
        "required_roles": dict(infer_page_roles(slide_descriptions or values)),
    }


class PPTTemplateCatalog(Protocol):
    """Provider boundary shared by local and future remote catalogues."""

    def taxonomy(self) -> Dict[str, Any]:
        """Return the compact routing taxonomy without template manifests."""
        ...

    def list_candidates(self, subcategory_ids: Optional[Sequence[str]] = None) -> Dict[str, Any]:
        """Return every template overview in an optional classified subset."""
        ...

    def details(self, template_ids: Sequence[str]) -> Dict[str, Any]:
        """Return bounded structural manifests for selected templates."""
        ...


class LocalPPTTemplateCatalog:
    """Local implementation of the future PPT template catalogue provider."""

    def __init__(self, index_path: Optional[Path] = None) -> None:
        self.index_path = (index_path or default_ppt_rag_index_path()).expanduser()

    def load(self) -> Dict[str, Any]:
        if not self.index_path.is_file():
            raise RuntimeError(
                f"PPT template index is missing: {self.index_path}. "
                "Build it with `python -m src.amphi_ppt_rag index --source <template-directory>`."
            )
        try:
            payload = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"PPT template index cannot be read: {self.index_path}: {exc}") from exc
        if payload.get("schema_version") != PPT_RAG_SCHEMA_VERSION or not isinstance(payload.get("templates"), list):
            raise RuntimeError(f"PPT template index has an unsupported schema: {self.index_path}")
        return payload

    def taxonomy(self) -> Dict[str, Any]:
        index = self.load()
        return {
            "provider": "local",
            "schema_version": index["schema_version"],
            "indexer_version": index.get("indexer_version"),
            "index_id": index.get("index_id"),
            "generated_at": index.get("generated_at"),
            "categories": (index.get("taxonomy") or {}).get("categories") or [],
        }

    def list_candidates(self, subcategory_ids: Optional[Sequence[str]] = None) -> Dict[str, Any]:
        index = self.load()
        templates = index["templates"]
        routed_ids = set(subcategory_ids or [])
        if routed_ids:
            routed_templates = [item for item in templates if routed_ids.intersection((item.get("search_profile") or {}).get("subcategory_ids") or [])]
            if routed_templates:
                templates = routed_templates
        candidates: List[Dict[str, Any]] = []
        for template in templates:
            search_profile = template.get("search_profile") or {}
            description = _template_description(template)
            if isinstance(template.get("description"), dict):
                description.update(template["description"])
            path = Path(str(template.get("local_path") or ""))
            available = path.is_file()
            stale = False
            if available:
                stat = path.stat()
                stale = stat.st_size != template.get("file_size") or stat.st_mtime_ns != template.get("modified_ns")
            warnings: List[str] = []
            if not available:
                warnings.append("the indexed template file is unavailable")
            elif stale:
                warnings.append("the template changed after indexing and should be re-indexed")
            if template.get("license_scope") == "local_test_only":
                warnings.append("local test asset; distribution rights are not verified")
            candidates.append({
                "template_id": template["id"],
                "version": template["version"],
                "title": template["title"],
                "available": available,
                "stale": stale,
                "aspect_ratio": template.get("aspect_ratio"),
                "slide_count": template.get("slide_count"),
                "brand_scope": template.get("brand_scope"),
                "license_scope": template.get("license_scope"),
                "semantic_tags": search_profile.get("semantic_tags") or [],
                "subcategory_ids": search_profile.get("subcategory_ids") or [],
                "density_level": search_profile.get("density_level"),
                "strengths": search_profile.get("strengths") or [],
                "overview": description["overview"],
                "visual_style": description["visual_style"],
                "best_for": description["best_for"],
                "signature_elements": description["signature_elements"],
                "overview_source": description["overview_source"],
                "colors": (template.get("colors") or [])[:6],
                "fonts": (template.get("fonts") or [])[:6],
                "role_counts": template.get("role_counts") or {},
                "layout_summary": search_profile.get("layout_summary") or {},
                "representative_slides": (search_profile.get("representative_slides") or [])[:8],
                "warnings": warnings,
                "preview_paths": (template.get("preview_paths") or [])[:PPT_RAG_PREVIEW_LIMIT],
                "materialize_ref": {"provider": "local", "template_id": template["id"], "version": template["version"], "path": template["local_path"]},
            })
        return {
            "provider": "local",
            "schema_version": index["schema_version"],
            "indexer_version": index.get("indexer_version"),
            "index_id": index.get("index_id"),
            "generated_at": index.get("generated_at"),
            "routed_subcategory_ids": sorted(routed_ids),
            "candidates": candidates,
        }

    def details(self, template_ids: Sequence[str]) -> Dict[str, Any]:
        index = self.load()
        requested = list(dict.fromkeys(template_ids))[:8]
        by_id = {item.get("id"): item for item in index["templates"]}
        templates: List[Dict[str, Any]] = []
        for template_id in requested:
            template = by_id.get(template_id)
            if template is None:
                continue
            path = Path(str(template.get("local_path") or ""))
            available = path.is_file()
            stale = False
            if available:
                stat = path.stat()
                stale = stat.st_size != template.get("file_size") or stat.st_mtime_ns != template.get("modified_ns")
            search_profile = template.get("search_profile") or {}
            description = _template_description(template)
            if isinstance(template.get("description"), dict):
                description.update(template["description"])
            warnings: List[str] = []
            if not available:
                warnings.append("the indexed template file is unavailable")
            elif stale:
                warnings.append("the template changed after indexing and should be re-indexed")
            if template.get("license_scope") == "local_test_only":
                warnings.append("local test asset; distribution rights are not verified")
            templates.append({
                "template_id": template["id"],
                "version": template["version"],
                "title": template["title"],
                "available": available,
                "stale": stale,
                "aspect_ratio": template.get("aspect_ratio"),
                "slide_count": template.get("slide_count"),
                "brand_scope": template.get("brand_scope"),
                "license_scope": template.get("license_scope"),
                "semantic_tags": search_profile.get("semantic_tags") or [],
                "subcategory_ids": search_profile.get("subcategory_ids") or [],
                "density_level": search_profile.get("density_level"),
                "strengths": search_profile.get("strengths") or [],
                "overview": description["overview"],
                "visual_style": description["visual_style"],
                "best_for": description["best_for"],
                "signature_elements": description["signature_elements"],
                "overview_source": description["overview_source"],
                "role_counts": template.get("role_counts") or {},
                "colors": (template.get("colors") or [])[:8],
                "fonts": (template.get("fonts") or [])[:8],
                "layout_summary": search_profile.get("layout_summary") or {},
                "representative_slides": (search_profile.get("representative_slides") or [])[:8],
                "preview_paths": (template.get("preview_paths") or [])[:PPT_RAG_PREVIEW_LIMIT],
                "preview_available": bool(template.get("preview_paths")),
                "warnings": warnings,
                "materialize_ref": {"provider": "local", "template_id": template["id"], "version": template["version"], "path": template["local_path"]},
            })
        return {
            "provider": "local",
            "schema_version": index["schema_version"],
            "indexer_version": index.get("indexer_version"),
            "index_id": index.get("index_id"),
            "templates": templates,
        }


def get_ppt_template_catalog() -> PPTTemplateCatalog:
    """Resolve the active catalogue provider for the current deployment."""
    return LocalPPTTemplateCatalog()


def ppt_rag_cli(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Build the local PPT template RAG index.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("index", help="Index a local directory of PPTX/POTX templates.")
    build.add_argument("--source", type=Path, required=True)
    build.add_argument("--output", type=Path, default=None)
    build.add_argument("--source-id", default="local-seed")
    build.add_argument("--brand-scope", default=None)
    build.add_argument("--license-scope", default="local_test_only")
    args = parser.parse_args(argv)
    payload = build_ppt_template_index(args.source, args.output, args.source_id, args.brand_scope, args.license_scope)
    print(json.dumps({"output": str((args.output or default_ppt_rag_index_path()).expanduser()), **payload["stats"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(ppt_rag_cli())


__all__ = [
    "LocalPPTTemplateCatalog",
    "PPTTemplateCatalog",
    "PPT_RAG_INDEXER_VERSION",
    "PPT_RAG_SCHEMA_VERSION",
    "build_ppt_search_profile",
    "build_ppt_template_index",
    "default_ppt_rag_index_path",
    "get_ppt_template_catalog",
    "infer_page_roles",
    "ppt_rag_cli",
]
