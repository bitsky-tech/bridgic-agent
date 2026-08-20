import zipfile
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from src.amphi_service.handler import _skills_import_handler as skills_import_handler
from tests._support.sandbox import IsolatedPaths


async def test_builtin_skill(service_client: httpx.AsyncClient) -> None:
    """Final service state:

    {
      "skills": [
        {
          "group": "builtin",
          "enabled": false,
          "deletable": false
        }
      ]
    }

    Checks:
    1. Built-in Skills are available through the Handler API.
    2. Toggling a built-in Skill changes its persisted API projection.
    3. Built-in Skills remain installed when deletion is requested.
    """
    # Check 1: Built-in Skills are available through the Handler API.
    response = await service_client.get("/skills")
    assert response.status_code == 200
    builtins = [skill for skill in response.json() if skill["group"] == "builtin"]
    assert builtins
    selected = builtins[0]
    assert selected["enabled"] is True
    detail = await service_client.get(f"/skill/{selected['skill_id']}")
    assert detail.status_code == 200
    assert detail.json() == selected

    # Check 2: Toggling a built-in Skill changes its persisted API projection.
    response = await service_client.post(
        f"/skill/{selected['skill_id']}/toggle",
        json={"enabled": False},
    )
    assert response.status_code == 200
    assert response.json()["enabled"] is False
    detail = await service_client.get(f"/skill/{selected['skill_id']}")
    assert detail.json()["enabled"] is False

    # Check 3: Built-in Skills remain installed when deletion is requested.
    response = await service_client.delete(f"/skill/{selected['skill_id']}")
    assert response.status_code == 409
    assert "cannot be deleted" in response.json()["detail"]
    detail = await service_client.get(f"/skill/{selected['skill_id']}")
    assert detail.status_code == 200


async def test_import_skill(service_client: httpx.AsyncClient, test_sandbox: IsolatedPaths) -> None:
    """Final service state:

    {
      "skills": [
        {
          "name": "research-helper",
          "description": "Organize research notes.",
          "group": "imported",
          "source": "local",
          "enabled": true,
          "skill_dir": "<sandbox>/skills/research-helper"
        }
      ],
      "installed_file": "<sandbox>/skills/research-helper/SKILL.md"
    }

    Checks:
    1. Scanning an absolute local directory returns importable Skill metadata.
    2. Conflict checking reports that the new Skill can be added safely.
    3. Importing copies the Skill into managed storage and returns an added result.
    4. The regular Skill endpoints expose the installed record.
    """
    source = test_sandbox.root / "incoming" / "research-helper"
    source.mkdir(parents=True)
    skill_content = (
        "---\n"
        "name: research-helper\n"
        "description: Organize research notes.\n"
        "---\n"
        "# Research Helper\n"
    )
    (source / "SKILL.md").write_text(skill_content, encoding="utf-8")

    # Check 1: Scanning an absolute local directory returns importable Skill metadata.
    response = await service_client.get("/skills/import/scan", params={"path": str(source)})
    assert response.status_code == 200
    scanned = response.json()
    assert len(scanned) == 1
    assert scanned[0]["name"] == "research-helper"
    assert scanned[0]["description"] == "Organize research notes."
    assert scanned[0]["source"] == "local"
    assert scanned[0]["source_uri"] == str(source)
    assert scanned[0]["local_path"] == str(source)
    assert scanned[0]["updated_at"] is not None

    # Check 2: Conflict checking reports that the new Skill can be added safely.
    response = await service_client.post("/skills/import/check", json=scanned)
    assert response.status_code == 200
    assert response.json() == [
        {
            "conflict": False,
            "incoming": scanned[0],
            "existing": None,
        }
    ]

    # Check 3: Importing copies the Skill into managed storage and returns an added result.
    response = await service_client.post("/skills/import", json=scanned)
    assert response.status_code == 200
    result = response.json()
    assert result["total"] == 1
    assert result["succeeded"] == 1
    assert result["failed"] == 0
    assert result["added"] == 1
    assert result["overwritten"] == 0
    assert result["failed_skills"] == []
    assert len(result["imported_skills"]) == 1
    imported = result["imported_skills"][0]
    installed_dir = test_sandbox.skills / "research-helper"
    assert imported["action"] == "added"
    assert imported["name"] == "research-helper"
    assert imported["skill_dir"] == str(installed_dir)
    assert (installed_dir / "SKILL.md").read_text(encoding="utf-8") == skill_content

    # Check 4: The regular Skill endpoints expose the installed record.
    response = await service_client.get(f"/skill/{imported['skill_id']}")
    assert response.status_code == 200
    detail = response.json()
    assert detail["name"] == "research-helper"
    assert detail["description"] == "Organize research notes."
    assert detail["skill_dir"] == str(installed_dir)
    assert detail["group"] == "imported"
    assert detail["source"] == "local"
    assert detail["source_uri"] == str(source)
    assert detail["enabled"] is True


async def test_import_github_skill(service_client: httpx.AsyncClient, test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """A downloaded GitHub Skill keeps its remote identity through installation."""
    source = test_sandbox.root / "downloaded" / "research-helper"
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text(
        "---\nname: github-helper\ndescription: Imported from GitHub\n---\n# GitHub Helper\n",
        encoding="utf-8",
    )
    remote_url = "https://github.com/acme/skills/tree/main/research-helper"

    def download(owner: str, repo: str, path: str | None = None, ref: str | None = None) -> SimpleNamespace:
        assert (owner, repo, ref, path) == ("acme", "skills", "main", "research-helper")
        return SimpleNamespace(skill_dir=source, source_uri=remote_url)

    monkeypatch.setattr(skills_import_handler, "_download_skill_from_github", download)
    response = await service_client.get("/skills/import/scan", params={"path": remote_url})
    assert response.status_code == 200
    scanned = response.json()
    assert len(scanned) == 1
    assert scanned[0]["name"] == "github-helper"
    assert scanned[0]["source"] == "github"
    assert scanned[0]["source_uri"] == remote_url
    assert scanned[0]["local_path"] == str(source)

    response = await service_client.post("/skills/import", json=scanned)
    assert response.status_code == 200
    assert response.json()["succeeded"] == 1
    installed = test_sandbox.skills / "research-helper"
    assert response.json()["imported_skills"][0]["skill_dir"] == str(installed)
    assert (installed / "SKILL.md").is_file()


def test_github_zip_rejects_path_escape(test_sandbox: IsolatedPaths) -> None:
    """GitHub archives cannot write outside their extraction directory."""
    archive_path = test_sandbox.root / "malicious.zip"
    destination = test_sandbox.root / "extracted"
    destination.mkdir()
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("../escaped.txt", "must not escape")

    with zipfile.ZipFile(archive_path) as archive:
        with pytest.raises(
            skills_import_handler._SkillDownloadError,
            match="outside the destination",
        ):
            skills_import_handler._safe_extract_zip(archive, destination)
    assert not (test_sandbox.root / "escaped.txt").exists()
