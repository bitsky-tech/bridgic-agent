"""``/skills/import/scan`` — local-path skill import preview.

Deep-scans a daemon-side directory and returns the metadata of every skill
(a directory holding a ``SKILL.md``) found under it. Read-only: nothing is
written to the store. Driven through the production HTTP API like a real
client (per the conftest philosophy), with a tmp skills tree on disk.
"""

from __future__ import annotations

import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from src.amphi_agent import SkillLibrary

# ``updated_at`` is a UTC ISO-8601 timestamp, e.g. ``2026-06-28T12:34:56.789+00:00``.
_ISO_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$")
BUILTIN_NAMES = set(SkillLibrary.builtin_names())


def _make_skill(
    root: Path,
    rel_dir: str,
    *,
    name: str | None = "demo",
    description: str = "A demo skill",
    body: str = "# Demo\n\nbody",
    files: dict[str, str] | None = None,
) -> Path:
    """Create ``<root>/<rel_dir>/SKILL.md`` and return its directory.

    ``name``/``description`` go into YAML frontmatter (pass ``name=None`` for
    a SKILL.md with no frontmatter). ``files`` maps skill-relative paths to
    contents for supporting files.
    """
    skill_dir = root / rel_dir
    skill_dir.mkdir(parents=True, exist_ok=True)
    fm = "" if name is None else f"---\nname: {name}\ndescription: {description}\n---\n"
    (skill_dir / "SKILL.md").write_text(fm + body, encoding="utf-8")
    for rel, content in (files or {}).items():
        target = skill_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return skill_dir


@pytest.fixture
def scan_root(tmp_path: Path) -> Path:
    """A fresh tmp directory to drop a skills tree into and scan."""
    root = tmp_path / "import-src"
    root.mkdir()
    return root


async def test_scan_lists_nested_skills(
    client: httpx.AsyncClient, scan_root: Path,
) -> None:
    """A top-level and a deeply nested skill are both discovered, each with its
    frontmatter name/description, ``source=local``, the skill dir as
    ``source_uri`` / ``local_path`` and a populated ``updated_at``."""
    top = _make_skill(scan_root, "airtable", name="airtable", description="Airtable ops.")
    nested = _make_skill(
        scan_root, "productivity/github-pr", name="github-pr", description="Open PRs.",
    )

    rows = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()

    by_name = {r["name"]: r for r in rows}
    assert set(by_name) == {"airtable", "github-pr"}
    assert by_name["airtable"]["description"] == "Airtable ops."
    assert by_name["airtable"]["source"] == "local"
    assert by_name["airtable"]["source_uri"] == str(top)
    assert by_name["airtable"]["local_path"] == str(top)
    assert by_name["github-pr"]["source_uri"] == str(nested)
    assert by_name["github-pr"]["local_path"] == str(nested)

    # ``updated_at`` is a UTC ISO-8601 string that round-trips to the actual
    # SKILL.md mtime — not merely "some non-null value".
    updated_at = by_name["airtable"]["updated_at"]
    assert _ISO_UTC.match(updated_at), updated_at
    assert datetime.fromisoformat(updated_at) == datetime.fromtimestamp(
        (top / "SKILL.md").stat().st_mtime, tz=timezone.utc,
    )


async def test_scan_github_url_downloads_then_scans_with_github_metadata(
    client: httpx.AsyncClient,
    scan_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A github.com URL is downloaded to a temporary local directory, scanned via
    the normal local scan logic, then surfaced as a GitHub-sourced skill."""
    skill_dir = _make_skill(
        scan_root,
        "team/demo",
        name="demo-github",
        description="Downloaded from GitHub.",
    )
    requested_url = "https://github.com/acme/skills/tree/main/team/demo"
    canonical_source_uri = "https://github.com/acme/skills/tree/main/team/demo"

    def fake_download(url: str) -> SimpleNamespace:
        assert url == requested_url
        return SimpleNamespace(
            skill_dir=skill_dir,
            source_uri=canonical_source_uri,
        )

    monkeypatch.setattr(
        "src.amphi_service.handler._skills_import_handler._download_skill_from_github_url",
        fake_download,
    )

    resp = await client.get("/skills/import/scan", params={"path": requested_url})

    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["name"] == "demo-github"
    assert rows[0]["description"] == "Downloaded from GitHub."
    assert rows[0]["source"] == "github"
    assert rows[0]["source_uri"] == canonical_source_uri
    assert rows[0]["source_uri"] != str(skill_dir)
    assert rows[0]["local_path"] == str(skill_dir)
    assert datetime.fromisoformat(rows[0]["updated_at"]) == datetime.fromtimestamp(
        (skill_dir / "SKILL.md").stat().st_mtime,
        tz=timezone.utc,
    )


async def test_scan_skills_sh_url_reads_page_downloads_repository_and_filters_skill(
    client: httpx.AsyncClient,
    scan_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A skills.sh page resolves its repository and filters the downloaded skills."""
    requested_url = "https://www.skills.sh/vercel-labs/agent-skills/vercel-react-best-practices"
    repository_url = "https://github.com/vercel-labs/agent-skills"
    wanted = _make_skill(
        scan_root,
        "skills/wanted",
        name="vercel-react-best-practices",
        description="React guidance.",
    )
    _make_skill(scan_root, "skills/other", name="other-skill")

    def page_metadata(url: str) -> SimpleNamespace:
        assert url == requested_url
        return SimpleNamespace(
            skill_name="vercel-react-best-practices",
            repository_url=repository_url,
        )

    def downloaded_repository(url: str) -> SimpleNamespace:
        assert url == repository_url
        return SimpleNamespace(
            skill_dir=scan_root,
            source_uri="https://github.com/vercel-labs/agent-skills/tree/main",
        )

    monkeypatch.setattr(
        "src.amphi_service.handler._skills_import_handler._fetch_skills_sh_page_metadata",
        page_metadata,
    )
    monkeypatch.setattr(
        "src.amphi_service.handler._skills_import_handler._download_skill_from_github_url",
        downloaded_repository,
    )

    resp = await client.get("/skills/import/scan", params={"path": requested_url})

    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["name"] == "vercel-react-best-practices"
    assert rows[0]["source"] == "skills.sh"
    assert rows[0]["source_uri"] == "https://github.com/vercel-labs/agent-skills/tree/main"
    assert rows[0]["local_path"] == str(wanted)
    assert _ISO_UTC.match(rows[0]["updated_at"]), rows[0]["updated_at"]


async def test_import_github_scan_result_copies_from_local_path_and_keeps_source_uri(
    client: httpx.AsyncClient,
    scan_root: Path,
    managed_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GitHub scan results keep remote provenance in source_uri while import
    copies from the downloaded local_path."""
    skill_dir = _make_skill(
        scan_root,
        "team/demo",
        name="demo-github",
        description="Downloaded from GitHub.",
        files={"references/usage.md": "use it"},
    )
    requested_url = "https://github.com/acme/skills/tree/main/team/demo"
    canonical_source_uri = "https://github.com/acme/skills/tree/main/team/demo"

    monkeypatch.setattr(
        "src.amphi_service.handler._skills_import_handler._download_skill_from_github_url",
        lambda url: SimpleNamespace(skill_dir=skill_dir, source_uri=canonical_source_uri),
    )

    scanned = (await client.get("/skills/import/scan", params={"path": requested_url})).json()
    assert scanned[0]["source_uri"] == canonical_source_uri
    assert scanned[0]["local_path"] == str(skill_dir)

    summary = (await client.post("/skills/import", json=scanned)).json()

    assert summary["succeeded"] == 1
    imported = summary["imported_skills"][0]
    assert imported["source"] == "github"
    assert imported["source_uri"] == canonical_source_uri
    dest = managed_root / "demo"
    assert imported["skill_dir"] == str(dest)
    assert (dest / "SKILL.md").is_file()
    assert (dest / "references" / "usage.md").read_text(encoding="utf-8") == "use it"


async def test_scan_name_falls_back_to_folder(
    client: httpx.AsyncClient, scan_root: Path,
) -> None:
    """A SKILL.md with no frontmatter still surfaces: name is the folder name,
    description is empty."""
    skill_dir = _make_skill(scan_root, "plain", name=None, body="just body")

    rows = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()

    assert len(rows) == 1
    assert rows[0]["name"] == "plain"
    assert rows[0]["description"] == ""
    assert rows[0]["source_uri"] == str(skill_dir)
    assert rows[0]["local_path"] == str(skill_dir)


async def test_scan_resolves_frontmatter_name_over_folder(
    client: httpx.AsyncClient, scan_root: Path,
) -> None:
    """``name`` comes from frontmatter even when it differs from the folder."""
    _make_skill(scan_root, "category/short-alias", name="fancy-name")

    rows = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()

    assert [r["name"] for r in rows] == ["fancy-name"]


async def test_scan_skips_support_dirs_and_vcs(
    client: httpx.AsyncClient, scan_root: Path,
) -> None:
    """An archived SKILL.md under a skill's ``references/`` is not its own
    skill, and a ``.git`` metadata directory is never descended into."""
    _make_skill(
        scan_root, "airtable", name="airtable",
        files={"references/old/SKILL.md": "---\nname: legacy\n---\nold"},
    )
    git_dir = scan_root / ".git" / "weird"
    git_dir.mkdir(parents=True)
    (git_dir / "SKILL.md").write_text("---\nname: nope\n---\n", encoding="utf-8")

    rows = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()

    assert [r["name"] for r in rows] == ["airtable"]


async def test_scan_empty_dir_returns_empty(
    client: httpx.AsyncClient, scan_root: Path,
) -> None:
    resp = await client.get("/skills/import/scan", params={"path": str(scan_root)})
    assert resp.status_code == 200
    assert resp.json() == []


async def test_scan_nonexistent_path_404(
    client: httpx.AsyncClient, tmp_path: Path,
) -> None:
    missing = tmp_path / "does-not-exist"
    resp = await client.get("/skills/import/scan", params={"path": str(missing)})
    assert resp.status_code == 404


async def test_scan_file_path_404(
    client: httpx.AsyncClient, scan_root: Path,
) -> None:
    """A path that exists but is a file, not a directory, is rejected."""
    a_file = scan_root / "note.txt"
    a_file.write_text("hi", encoding="utf-8")
    resp = await client.get("/skills/import/scan", params={"path": str(a_file)})
    assert resp.status_code == 404


async def test_scan_relative_path_400(client: httpx.AsyncClient) -> None:
    resp = await client.get("/skills/import/scan", params={"path": "relative/dir"})
    assert resp.status_code == 400


async def test_scan_malformed_url_400(client: httpx.AsyncClient) -> None:
    """Malformed URLs that make ``urlparse`` raise are treated like invalid
    scan paths instead of surfacing as an unhandled server error."""
    resp = await client.get("/skills/import/scan", params={"path": "https://[::1"})
    assert resp.status_code == 400


async def test_scan_missing_path_param_422(client: httpx.AsyncClient) -> None:
    """``path`` is a required query parameter."""
    resp = await client.get("/skills/import/scan")
    assert resp.status_code == 422


async def test_scan_does_not_persist(
    client: httpx.AsyncClient, scan_root: Path,
) -> None:
    """Scanning is a preview — the installed-skills list stays empty."""
    _make_skill(scan_root, "airtable", name="airtable")

    scanned = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()
    assert len(scanned) == 1

    listed = (await client.get("/skills")).json()
    assert {row["name"] for row in listed} == BUILTIN_NAMES
    assert all(row["group"] == "builtin" for row in listed)


# ---------------------------------------------------------------------------
# POST /skills/import/check + POST /skills/import — conflict check + install
# ---------------------------------------------------------------------------


@pytest.fixture
def managed_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the managed skills root (the import destination) at a tmp dir.

    The import handlers resolve their root from ``$BRIDGIC_AGENT_SKILLS_ROOT``
    at request time, so setting it here keeps every install inside pytest's
    ``tmp_path`` instead of the developer's real ``~/.bridgic`` tree.
    """
    root = tmp_path / "managed"
    monkeypatch.setenv("BRIDGIC_AGENT_SKILLS_ROOT", str(root))
    return root.resolve()


async def test_check_no_conflict_when_root_empty(
    client: httpx.AsyncClient, scan_root: Path, managed_root: Path,
) -> None:
    """With an empty managed root, every scanned skill checks clean: no
    conflict, no ``existing`` record, and the ``incoming`` block echoes the
    scanned metadata field-for-field."""
    airtable_dir = _make_skill(
        scan_root, "airtable", name="airtable", description="Airtable ops.",
    )
    github_pr_dir = _make_skill(
        scan_root, "productivity/github-pr", name="github-pr", description="Open PRs.",
    )
    scanned = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()

    results = (await client.post("/skills/import/check", json=scanned)).json()

    assert len(results) == 2
    # Each result is conflict-free with no existing record, and its incoming
    # block round-trips the scanned metadata verbatim (every field, in order).
    for result, source in zip(results, scanned):
        assert result["conflict"] is False
        assert result["existing"] is None
        assert result["incoming"] == source

    # Pin the full field set for each skill against concrete values, so a shape
    # regression is caught even if scan and check ever drift together.
    by_name = {r["incoming"]["name"]: r["incoming"] for r in results}

    def assert_incoming(
        incoming: dict, *, name: str, description: str, skill_dir: Path,
    ) -> None:
        # The incoming (to-be-imported) skill is unidentified — no store id yet.
        assert "skill_id" not in incoming
        assert incoming["name"] == name
        assert incoming["description"] == description
        assert incoming["source"] == "local"
        assert incoming["source_uri"] == str(skill_dir)
        assert incoming["local_path"] == str(skill_dir)
        # ``updated_at`` is the real SKILL.md mtime carried through, not just
        # some ISO-shaped string.
        assert _ISO_UTC.match(incoming["updated_at"]), incoming["updated_at"]
        assert datetime.fromisoformat(incoming["updated_at"]) == datetime.fromtimestamp(
            (skill_dir / "SKILL.md").stat().st_mtime, tz=timezone.utc,
        )
        assert set(incoming) == {
            "name", "description", "source", "source_uri", "local_path", "updated_at",
        }

    assert_incoming(
        by_name["airtable"], name="airtable",
        description="Airtable ops.", skill_dir=airtable_dir,
    )
    assert_incoming(
        by_name["github-pr"], name="github-pr",
        description="Open PRs.", skill_dir=github_pr_dir,
    )


async def test_check_empty_list_returns_empty(
    client: httpx.AsyncClient, managed_root: Path,
) -> None:
    assert (await client.post("/skills/import/check", json=[])).json() == []


async def test_import_added_persists_and_copies(
    client: httpx.AsyncClient, scan_root: Path, managed_root: Path,
) -> None:
    """A clean import deep-copies each skill as a direct child of the managed
    root (nested sources flattened), upserts a store row, and reports them as
    ``added``."""
    _make_skill(
        scan_root, "airtable", name="airtable", description="Airtable ops.",
        files={"references/api.md": "ref"},
    )
    _make_skill(scan_root, "productivity/github-pr", name="github-pr", description="PRs.")
    scanned = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()

    summary = (await client.post("/skills/import", json=scanned)).json()

    assert summary["total"] == 2
    assert summary["succeeded"] == 2
    assert summary["added"] == 2
    assert summary["overwritten"] == 0
    assert summary["failed"] == 0
    assert summary["failed_skills"] == []

    by_name = {s["name"]: s for s in summary["imported_skills"]}
    assert set(by_name) == {"airtable", "github-pr"}
    for s in by_name.values():
        assert s["action"] == "added"
        assert s["skill_id"] is not None
        assert s["group"] == "imported"
        assert s["source"] == "local"

    # Each skill's description is carried through onto its store row.
    assert by_name["airtable"]["description"] == "Airtable ops."
    assert by_name["github-pr"]["description"] == "PRs."

    # Flattened to a direct child of the managed root.
    assert by_name["airtable"]["skill_dir"] == str(managed_root / "airtable")
    assert by_name["github-pr"]["skill_dir"] == str(managed_root / "github-pr")

    # Files were deep-copied, including the support folder.
    assert (managed_root / "airtable" / "SKILL.md").is_file()
    assert (managed_root / "airtable" / "references" / "api.md").read_text() == "ref"

    # GET /skills now lists exactly the two installed skills.
    listed = (await client.get("/skills")).json()
    assert {s["name"] for s in listed} == BUILTIN_NAMES | {"airtable", "github-pr"}


async def test_import_cannot_overwrite_builtin(
    client: httpx.AsyncClient, scan_root: Path,
) -> None:
    _make_skill(
        scan_root, "replacement", name="how-to",
        description="Untrusted replacement.", body="# replacement",
    )
    scanned = (await client.get(
        "/skills/import/scan", params={"path": str(scan_root)},
    )).json()

    summary = (await client.post("/skills/import", json=scanned)).json()

    assert summary["succeeded"] == 0
    assert summary["failed"] == 1
    assert "cannot be overwritten" in summary["failed_skills"][0]["reason"]
    stored = next(
        row for row in (await client.get("/skills")).json()
        if row["name"] == "how-to"
    )
    assert stored["group"] == "builtin"
    assert stored["source_uri"] == "builtin://how-to"


async def test_import_mixed_overwrite_and_add(
    client: httpx.AsyncClient, scan_root: Path, managed_root: Path,
) -> None:
    """One batch mixing a conflicting skill and a fresh one: airtable is
    overwritten (same ``skill_id``, replaced content, stale files cleared) while
    a brand-new github-pr is added — both succeed in a single import call."""
    # Seed: only airtable is installed (v1, with a stale support file).
    _make_skill(
        scan_root, "airtable", name="airtable", description="v1", body="# v1",
        files={"references/old.md": "old"},
    )
    scanned1 = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()
    summary1 = (await client.post("/skills/import", json=scanned1)).json()
    first_id = summary1["imported_skills"][0]["skill_id"]
    assert (managed_root / "airtable" / "references" / "old.md").is_file()

    # Rebuild airtable as v2 (stale file gone) and add a skill the managed root
    # has never seen, so the next batch carries one conflict + one non-conflict.
    shutil.rmtree(scan_root / "airtable")
    _make_skill(scan_root, "airtable", name="airtable", description="v2", body="# v2")
    _make_skill(scan_root, "github-pr", name="github-pr", description="Open PRs.")
    scanned2 = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()

    # Check flags airtable as a conflict (carrying its id) and github-pr as
    # clean; neither incoming side carries a skill_id.
    check = {r["incoming"]["name"]: r for r in (
        await client.post("/skills/import/check", json=scanned2)
    ).json()}
    assert check["airtable"]["conflict"] is True
    assert check["airtable"]["existing"]["skill_id"] == first_id
    assert check["airtable"]["existing"]["skill_dir"] == str(managed_root / "airtable")
    assert "skill_id" not in check["airtable"]["incoming"]
    assert check["github-pr"]["conflict"] is False
    assert check["github-pr"]["existing"] is None

    # Import: airtable overwritten (same id, replaced body, stale gone), github-pr
    # added (a fresh id) — both succeed in one call.
    summary2 = (await client.post("/skills/import", json=scanned2)).json()
    assert summary2["total"] == 2
    assert summary2["succeeded"] == 2
    assert summary2["failed"] == 0
    assert summary2["added"] == 1
    assert summary2["overwritten"] == 1

    rows = {s["name"]: s for s in summary2["imported_skills"]}
    assert rows["airtable"]["action"] == "overwritten"
    assert rows["airtable"]["skill_id"] == first_id
    assert rows["airtable"]["description"] == "v2"
    assert rows["github-pr"]["action"] == "added"
    assert rows["github-pr"]["skill_id"] != first_id

    # The remaining store-row fields land as expected on both skills: imported
    # group, local source, the original source dir kept as provenance, and a
    # store-set ``updated_at`` (a parseable ISO string — the SQLite round-trip
    # drops the tz suffix, so it isn't the ``+00:00`` scan shape).
    for name in ("airtable", "github-pr"):
        assert rows[name]["group"] == "imported"
        assert rows[name]["source"] == "local"
        # Both land flattened as a direct child of the managed root (the
        # overwritten one keeps its slot, the new one gets a fresh child).
        assert rows[name]["skill_dir"] == str(managed_root / name)
        assert rows[name]["source_uri"] == str(scan_root / name)
        assert datetime.fromisoformat(rows[name]["updated_at"])

    assert (managed_root / "airtable" / "SKILL.md").read_text().endswith("# v2")
    assert not (managed_root / "airtable" / "references" / "old.md").exists()
    assert (managed_root / "github-pr" / "SKILL.md").is_file()

    # Two skills installed now: the overwritten one + the newly added one.
    listed = {s["name"] for s in (await client.get("/skills")).json()}
    assert listed == BUILTIN_NAMES | {"airtable", "github-pr"}


async def test_import_rejects_directory_collision_with_different_name(
    client: httpx.AsyncClient, scan_root: Path, managed_root: Path,
) -> None:
    """Conflict is keyed on the skill *name*, not the directory. A source whose
    directory matches an installed skill but whose declared name differs is NOT a
    conflict — and importing it is refused (an unexpected directory collision),
    so the unrelated same-directory skill is left untouched."""
    # Target: a standard ``lark-doc`` skill installed, with a support file.
    _make_skill(
        scan_root, "lark-doc", name="lark-doc", description="v1", body="# v1",
        files={"references/keep.md": "keep"},
    )
    scanned1 = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()
    summary1 = (await client.post("/skills/import", json=scanned1)).json()
    target_id = summary1["imported_skills"][0]["skill_id"]
    assert summary1["imported_skills"][0]["name"] == "lark-doc"

    # Source: same directory name, but the SKILL.md declares a *different* name —
    # the skill name comes from frontmatter, not the path.
    shutil.rmtree(scan_root / "lark-doc")
    _make_skill(scan_root, "lark-doc", name="feishu-doc", description="v2", body="# v2")
    scanned2 = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()
    assert scanned2[0]["name"] == "feishu-doc"                  # name from frontmatter
    assert Path(scanned2[0]["source_uri"]).name == "lark-doc"   # ...not the folder

    # Check: NOT a conflict — the incoming name (feishu-doc) differs from the
    # installed lark-doc, so it isn't an overwrite; no existing record surfaces.
    check = (await client.post("/skills/import/check", json=scanned2)).json()
    assert check[0]["conflict"] is False
    assert check[0]["existing"] is None
    assert check[0]["incoming"]["name"] == "feishu-doc"

    # Import: refused — 0 imported, 1 failed, the reason naming the directory
    # collision with the differently-named installed skill.
    summary2 = (await client.post("/skills/import", json=scanned2)).json()
    assert summary2["total"] == 1
    assert summary2["succeeded"] == 0
    assert summary2["added"] == 0
    assert summary2["overwritten"] == 0
    assert summary2["failed"] == 1
    assert summary2["imported_skills"] == []
    fail = summary2["failed_skills"][0]
    assert fail["name"] == "feishu-doc"
    assert "skill_id" not in fail  # a failed skill was never installed
    assert fail["source_uri"] == str(scan_root / "lark-doc")
    # The failed entry echoes the incoming skill's metadata verbatim.
    assert fail["description"] == scanned2[0]["description"]
    assert fail["source"] == scanned2[0]["source"]
    assert fail["updated_at"] == scanned2[0]["updated_at"]
    assert "occupied" in fail["reason"]
    assert "lark-doc" in fail["reason"]

    # The installed lark-doc is untouched: same id, original body + file intact.
    assert (managed_root / "lark-doc" / "SKILL.md").read_text().endswith("# v1")
    assert (managed_root / "lark-doc" / "references" / "keep.md").read_text() == "keep"
    listed = (await client.get("/skills")).json()
    assert len(listed) == len(BUILTIN_NAMES) + 1
    target = next(row for row in listed if row["name"] == "lark-doc")
    assert target["skill_id"] == target_id
    assert any(row["name"] == "how-to" for row in listed)


async def test_import_overwrite_when_source_dir_differs_from_installed(
    client: httpx.AsyncClient, scan_root: Path, managed_root: Path,
) -> None:
    """A same-named conflict overwrites even when the source sits in a *different*
    directory than the installed skill: it's still a conflict (by name), the new
    directory is created, the old one removed, and the store row (same id) follows
    to the new location — the skill moves, not duplicates."""
    # Target: lark-doc installed at .../lark-doc, with a stale support file.
    _make_skill(
        scan_root, "lark-doc", name="lark-doc", description="v1", body="# v1",
        files={"references/old.md": "stale"},
    )
    scanned1 = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()
    summary1 = (await client.post("/skills/import", json=scanned1)).json()
    target_id = summary1["imported_skills"][0]["skill_id"]
    assert (managed_root / "lark-doc" / "references" / "old.md").is_file()

    # Source: a *different* directory (feishu) whose SKILL.md declares the same
    # name (lark-doc) — so it lands at .../feishu but conflicts with lark-doc.
    shutil.rmtree(scan_root / "lark-doc")
    _make_skill(scan_root, "feishu", name="lark-doc", description="v2", body="# v2")
    scanned2 = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()
    assert scanned2[0]["name"] == "lark-doc"
    assert Path(scanned2[0]["source_uri"]).name == "feishu"

    # Check: a conflict by name, despite the differing directory; existing points
    # at the installed lark-doc's current (old) directory.
    check = (await client.post("/skills/import/check", json=scanned2)).json()
    assert check[0]["conflict"] is True
    assert check[0]["existing"]["skill_id"] == target_id
    assert check[0]["existing"]["skill_dir"] == str(managed_root / "lark-doc")

    # Import: overwrites — same id, lands at the new dir, old dir removed.
    summary2 = (await client.post("/skills/import", json=scanned2)).json()
    assert summary2["overwritten"] == 1
    assert summary2["added"] == 0
    assert summary2["failed"] == 0
    row = summary2["imported_skills"][0]
    assert row["action"] == "overwritten"
    assert row["skill_id"] == target_id
    assert row["name"] == "lark-doc"
    assert row["skill_dir"] == str(managed_root / "feishu")

    # The new directory holds the v2 content; the old directory (and its stale
    # file) is gone — the skill moved rather than being duplicated.
    assert (managed_root / "feishu" / "SKILL.md").read_text().endswith("# v2")
    assert not (managed_root / "lark-doc").exists()

    # Still exactly one installed skill, same id, now at the new location.
    listed = (await client.get("/skills")).json()
    assert len(listed) == len(BUILTIN_NAMES) + 1
    target = next(row for row in listed if row["name"] == "lark-doc")
    assert target["skill_id"] == target_id
    assert target["skill_dir"] == str(managed_root / "feishu")


async def test_import_fails_when_dest_dir_holds_a_different_skill(
    client: httpx.AsyncClient, scan_root: Path, managed_root: Path,
) -> None:
    """A same-named conflict that *also* lands on a directory occupied by an
    unrelated skill is refused: the name conflict alone would overwrite, but the
    directory collision with a different skill makes the import fail — both
    installed skills are left untouched."""
    # Install two skills: lark-doc lives in .../old-lark, github-pr in .../feishu.
    _make_skill(scan_root, "old-lark", name="lark-doc", description="A", body="# A")
    _make_skill(scan_root, "feishu", name="github-pr", description="B", body="# B")
    scanned1 = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()
    summary1 = (await client.post("/skills/import", json=scanned1)).json()
    installed = {s["name"]: s for s in summary1["imported_skills"]}
    lark_id = installed["lark-doc"]["skill_id"]
    gh_id = installed["github-pr"]["skill_id"]

    # Source: directory ``feishu`` (already taken by github-pr) but declaring the
    # name ``lark-doc`` (which conflicts with the skill over in .../old-lark).
    shutil.rmtree(scan_root / "old-lark")
    shutil.rmtree(scan_root / "feishu")
    _make_skill(scan_root, "feishu", name="lark-doc", description="v2", body="# v2")
    scanned2 = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()
    assert scanned2[0]["name"] == "lark-doc"
    assert Path(scanned2[0]["source_uri"]).name == "feishu"

    # Check: it IS a name conflict — against the lark-doc in .../old-lark.
    check = (await client.post("/skills/import/check", json=scanned2)).json()
    assert check[0]["conflict"] is True
    assert check[0]["existing"]["skill_id"] == lark_id
    assert check[0]["existing"]["skill_dir"] == str(managed_root / "old-lark")

    # Import: refused — the destination dir (feishu) is held by github-pr, a
    # different skill. 0 imported, 1 failed with a directory-collision reason.
    summary2 = (await client.post("/skills/import", json=scanned2)).json()
    assert summary2["total"] == 1
    assert summary2["succeeded"] == 0
    assert summary2["overwritten"] == 0
    assert summary2["added"] == 0
    assert summary2["failed"] == 1
    assert summary2["imported_skills"] == []
    fail = summary2["failed_skills"][0]
    assert fail["name"] == "lark-doc"
    assert "skill_id" not in fail  # a failed skill was never installed
    assert fail["source_uri"] == str(scan_root / "feishu")
    # The failed entry echoes the incoming skill's metadata verbatim.
    assert fail["description"] == scanned2[0]["description"]
    assert fail["source"] == scanned2[0]["source"]
    assert fail["updated_at"] == scanned2[0]["updated_at"]
    assert "occupied" in fail["reason"]
    assert "github-pr" in fail["reason"]

    # Both installed skills are untouched (content + ids).
    assert (managed_root / "old-lark" / "SKILL.md").read_text().endswith("# A")
    assert (managed_root / "feishu" / "SKILL.md").read_text().endswith("# B")
    listed = {s["name"]: s for s in (await client.get("/skills")).json()}
    assert set(listed) == BUILTIN_NAMES | {"lark-doc", "github-pr"}
    assert listed["lark-doc"]["skill_id"] == lark_id
    assert listed["github-pr"]["skill_id"] == gh_id


async def test_import_reports_per_skill_failure(
    client: httpx.AsyncClient, scan_root: Path, managed_root: Path,
) -> None:
    """A bad item (source dir gone) is captured in ``errors`` with a reason and
    does not abort the rest of the batch."""
    _make_skill(scan_root, "ok-skill", name="ok-skill")
    scanned = (await client.get("/skills/import/scan", params={"path": str(scan_root)})).json()
    scanned.append({
        "name": "ghost",
        "description": "",
        "source": "local",
        "source_uri": str(scan_root / "does-not-exist"),
        "local_path": str(scan_root / "does-not-exist"),
        "updated_at": None,
    })

    summary = (await client.post("/skills/import", json=scanned)).json()

    assert summary["total"] == 2
    assert summary["succeeded"] == 1
    assert summary["added"] == 1
    assert summary["failed"] == 1
    assert {s["name"] for s in summary["imported_skills"]} == {"ok-skill"}
    err = summary["failed_skills"][0]
    assert err["name"] == "ghost"
    assert "skill_id" not in err  # a failed skill was never installed
    assert err["source_uri"] == str(scan_root / "does-not-exist")
    assert err["local_path"] == str(scan_root / "does-not-exist")
    # The failed entry echoes the incoming skill's metadata verbatim.
    assert err["description"] == scanned[-1]["description"]
    assert err["source"] == scanned[-1]["source"]
    assert err["updated_at"] == scanned[-1]["updated_at"]
    assert err["reason"]
