"""``/skills/import/scan`` + ``/skills/import`` — skill import.

The skill-import feature lives here. It owns three steps, in order:

1. ``GET /skills/import/scan?path=`` — the deep scan that, given a daemon-side
   directory or GitHub URL, discovers every skill under it and returns
   lightweight metadata. Read-only.
2. ``POST /skills/import/check`` — given a scanned skill list, report for each
   whether importing it would **conflict** with a skill already installed
   under the managed root (and, when it would, the existing record it would
   overwrite). Read-only.
3. ``POST /skills/import`` — actually install the scanned skills: deep-copy
   each skill directory under the managed root (overwriting any conflicting
   one whole) and upsert its store row. Returns an import summary.

The managed root every install lands under is
``~/.bridgic/AmphiAgent/skills/local`` — the same root the agent's
``view_skill`` tool reads from — overridable for tests via
``$BRIDGIC_AGENT_SKILLS_ROOT``.

A *skill* is a directory holding a ``SKILL.md``; its ``name`` and
``description`` come from that file's YAML frontmatter (``name`` falls back
to the folder name). The scan (:func:`scan_skills`) recurses arbitrarily
deep, reads the declared frontmatter name, and never descends into VCS /
cache metadata directories or a skill's progressive-disclosure support
folders (``references/`` etc.), whose nested ``SKILL.md`` files are archived
data, not standalone skills. The agent ``view_skill`` tool later resolves an
installed skill by name straight from its store row (no rescan).
"""

from __future__ import annotations

import html
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, Response, status
from pydantic import BaseModel

from ...amphi_agent import SkillGroup, SkillSource
from ...amphi_store import Skill as SkillRow, SkillRepository
from ._base import BaseHandler

# The managed root every imported skill is installed under (a direct child per
# skill). Each install records the resulting directory on its store row, which
# is what the agent ``view_skill`` tool reads back; overridable for tests via
# this env var, like the Sessions root.
_SKILLS_ROOT_ENV_VAR = "BRIDGIC_AGENT_SKILLS_ROOT"
_IS_WINDOWS = os.name == "nt"
_WINDOWS_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)


def _skills_local_root() -> Path:
    configured = os.getenv(_SKILLS_ROOT_ENV_VAR)
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".bridgic" / "AmphiAgent" / "skills" / "local").resolve()

# Directories never scanned for skills (VCS / virtualenv / cache metadata).
_EXCLUDED_DIRS = frozenset({
    ".git", ".github", ".hub", ".archive", ".venv", "venv", "node_modules",
    "site-packages", "__pycache__", ".tox", ".nox", ".pytest_cache",
    ".mypy_cache", ".ruff_cache",
})
# Progressive-disclosure support folders. When they sit directly inside a
# skill directory their contents (including any archived ``SKILL.md``) are
# that skill's data, never standalone skills.
_SUPPORT_DIRS = frozenset({"references", "templates", "assets", "scripts"})


class _SkillDownloadError(Exception):
    """Raised when downloading or preparing a GitHub skill repo fails."""


class _SkillRefNotFoundError(_SkillDownloadError):
    """Raised when a GitHub ref is known not to exist."""


_GITHUB_USER_AGENT = "AmphiAgent-skill-download"

def _validate_github_segment(value: str, field_name: str) -> str:
    candidate = (value or "").strip()
    if field_name == "repo":
        candidate = candidate.removesuffix(".git")
    if not candidate:
        raise _SkillDownloadError(f"{field_name} is required.")
    if "/" in candidate or "\\" in candidate or candidate in {".", ".."}:
        raise _SkillDownloadError(f"{field_name} must be a single GitHub path segment.")
    return candidate


def _validate_github_ref(ref: str) -> str:
    candidate = (ref or "main").strip()
    if not candidate:
        raise _SkillDownloadError("ref is required.")
    if candidate.startswith("-") or "\x00" in candidate or ".." in Path(candidate).parts:
        raise _SkillDownloadError("ref is invalid.")
    return candidate


def _validate_repo_relative_dir(path: str) -> str:
    raw = (path or "").strip()
    if not raw:
        return ""
    if os.path.isabs(raw):
        raise _SkillDownloadError("path must be a relative directory path inside the repo.")
    raw = raw.strip("/")
    if not raw:
        return ""
    normalized = os.path.normpath(raw).replace(os.sep, "/")
    if normalized == ".":
        return ""
    if normalized.startswith("../") or normalized == ".." or ".." in Path(normalized).parts:
        raise _SkillDownloadError("path cannot contain '..' traversal components.")
    return normalized


def _github_repo_url(owner: str, repo: str) -> str:
    return f"https://github.com/{owner}/{repo}.git"


def _github_tree_url(owner: str, repo: str, ref: str, path: str) -> str:
    quoted_ref = urllib.parse.quote(ref, safe="")
    if not path:
        return f"https://github.com/{owner}/{repo}/tree/{quoted_ref}"
    quoted_path = "/".join(urllib.parse.quote(part, safe="") for part in path.split("/"))
    return f"https://github.com/{owner}/{repo}/tree/{quoted_ref}/{quoted_path}"


def _looks_like_missing_ref_error(message: str, ref: str) -> bool:
    lower_message = message.lower()
    lower_ref = ref.lower()
    quoted_ref = repr(ref).lower()
    return (
        (
            "remote branch" in lower_message
            and lower_ref in lower_message
            and "not found" in lower_message
        )
        or f"couldn't find remote ref {lower_ref}" in lower_message
        or f"could not find remote branch {lower_ref}" in lower_message
        or (
            "pathspec" in lower_message
            and quoted_ref in lower_message
            and "did not match any file(s) known to git" in lower_message
        )
        or (
            lower_ref in lower_message
            and "is not a valid branch or tag" in lower_message
        )
    )


def _missing_ref_error(ref: str, detail: str) -> _SkillRefNotFoundError:
    return _SkillRefNotFoundError(f"GitHub ref not found: {ref!r}. {detail}")


def _run_git_command(args: List[str], *, ref: Optional[str] = None) -> None:
    spawn_options = (
        {"creationflags": _WINDOWS_CREATE_NO_WINDOW} if _IS_WINDOWS else {}
    )
    result = subprocess.run(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        # See _workspace._run_uv: locale decoding is GBK on a Chinese Windows system.
        encoding="utf-8",
        errors="replace",
        **spawn_options,
    )
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or "Git command failed."
        if ref and _looks_like_missing_ref_error(message, ref):
            raise _missing_ref_error(ref, message)
        raise _SkillDownloadError(message)


def _git_sparse_checkout(repo_url: str, ref: str, path: str, work_root: Path) -> Path:
    repo_dir = work_root / "repo"
    if not path:
        # Full clone — sparse checkout is unnecessary and can cause
        # missing files when combined with --filter=blob:none.
        clone_cmd = [
            "git", "clone", "--depth", "1",
            "--single-branch", "--branch", ref, repo_url, str(repo_dir),
        ]
    else:
        clone_cmd = [
            "git", "clone", "--filter=blob:none", "--depth", "1", "--sparse",
            "--single-branch", "--branch", ref, repo_url, str(repo_dir),
        ]
    try:
        _run_git_command(clone_cmd, ref=ref)
    except _SkillRefNotFoundError:
        raise
    except _SkillDownloadError:
        # Tags or unusual refs can fail with --branch plus --single-branch on some
        # Git versions. Fall back to a shallow clone and checkout the ref.
        if repo_dir.exists():
            shutil.rmtree(repo_dir, ignore_errors=True)
        if not path:
            _run_git_command(["git", "clone", "--depth", "1", repo_url, str(repo_dir)])
        else:
            _run_git_command([
                "git", "clone", "--filter=blob:none", "--depth", "1", "--sparse",
                repo_url, str(repo_dir),
            ])
        _run_git_command(["git", "-C", str(repo_dir), "checkout", ref], ref=ref)
    if path:
        _run_git_command(["git", "-C", str(repo_dir), "sparse-checkout", "set", path])
    return repo_dir


def _dulwich_clone(repo_url: str, ref: str, path: str, work_root: Path) -> Path:
    """Clone one ref with Dulwich, preserving shallow/partial/sparse semantics.

    ``dulwich.porcelain.checkout(paths=...)`` cannot materialize a partial
    clone: the blobs omitted by ``blob:none`` are not fetched on demand.  For a
    directory URL, use protocol-v2 filtering, fetch only checkout blobs, and
    maintain a cone-mode sparse worktree explicitly.  A regular shallow clone
    remains the compatibility fallback for unsupported refs or servers.
    """
    try:
        from dulwich import porcelain  # noqa: PLC0415
        from dulwich.client import get_transport_and_path  # noqa: PLC0415
        from dulwich.config import ConfigDict  # noqa: PLC0415
        from dulwich.index import (  # noqa: PLC0415
            Index, IndexEntry, build_file_from_blob, index_entry_from_stat,
            iter_tree_contents,
        )
        from dulwich.objects import S_ISGITLINK, Blob, Commit  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        raise _SkillDownloadError(f"dulwich is not available: {type(exc).__name__}: {exc}") from exc

    partial_filter = "blob:none"

    def isolated_transport(*, operation: str, thin_packs: bool = True):
        return get_transport_and_path(
            repo_url, config=ConfigDict(), operation=operation, thin_packs=thin_packs,
        )

    def fetch_missing_blobs(repository: Any, object_ids: List[bytes]) -> None:
        missing = sorted({object_id for object_id in object_ids if object_id not in repository.object_store})
        if not missing:
            return

        def determine_wants(_remote_refs: Dict[bytes, bytes], depth: Optional[int] = None) -> List[bytes]:
            del depth
            return missing

        class NoHaveGraphWalker:
            shallow: set[bytes] = set()

            def __next__(self) -> None:
                return None

            def ack(self, _sha: bytes) -> None:
                pass

        client, remote_path = isolated_transport(operation="fetch", thin_packs=False)
        pack_file, commit_pack, abort_pack = repository.object_store.add_pack()
        try:
            client.fetch_pack(
                remote_path, determine_wants, NoHaveGraphWalker(), pack_file.write,
                protocol_version=2,
            )
        except BaseException:
            abort_pack()
            raise
        else:
            commit_pack()
        still_missing = [object_id for object_id in missing if object_id not in repository.object_store]
        if still_missing:
            raise _SkillDownloadError("Dulwich remote did not provide required sparse-checkout blobs.")

    def is_in_sparse_cone(file_path: str, directory: str) -> bool:
        if "/" not in file_path:
            return True
        if file_path == directory or file_path.startswith(directory + "/"):
            return True
        parent = file_path.rsplit("/", 1)[0]
        ancestor = directory
        while "/" in ancestor:
            ancestor = ancestor.rsplit("/", 1)[0]
            if parent == ancestor:
                return True
        return False

    def materialize_sparse_checkout(repository: Any, directory: str) -> None:
        commit = repository[repository.head()]
        if not isinstance(commit, Commit):
            raise _SkillDownloadError("Dulwich clone HEAD does not point to a commit.")
        entries = list(iter_tree_contents(repository.object_store, commit.tree))
        included: Dict[bytes, bool] = {}
        for entry in entries:
            if entry.path is None:
                continue
            decoded_path = entry.path.decode("utf-8", "surrogateescape")
            included[entry.path] = is_in_sparse_cone(decoded_path, directory)
        fetch_missing_blobs(repository, [
            entry.sha for entry in entries
            if entry.path is not None and entry.sha is not None
            and included[entry.path] and not S_ISGITLINK(entry.mode or 0)
        ])

        index = Index(repository.index_path(), read=False)
        root = os.fsencode(repository.path)
        for entry in entries:
            if entry.path is None or entry.mode is None or entry.sha is None:
                continue
            if included[entry.path]:
                full_path = os.path.join(root, entry.path)
                os.makedirs(os.path.dirname(full_path), exist_ok=True)
                if S_ISGITLINK(entry.mode):
                    os.makedirs(full_path, exist_ok=True)
                    file_stat = os.lstat(full_path)
                else:
                    blob = repository.object_store[entry.sha]
                    if not isinstance(blob, Blob):
                        raise _SkillDownloadError(f"Dulwich checkout object for {entry.path!r} is not a blob.")
                    file_stat = build_file_from_blob(blob, entry.mode, full_path)
                index[entry.path] = index_entry_from_stat(file_stat, entry.sha, mode=entry.mode)
            else:
                skipped = IndexEntry(ctime=0, mtime=0, dev=0, ino=0, mode=entry.mode,
                                     uid=0, gid=0, size=0, sha=entry.sha)
                skipped.set_skip_worktree(True)
                index[entry.path] = skipped
        index.write()
        config = repository.get_config()
        config.set((b"core",), b"sparseCheckout", True)
        config.set((b"core",), b"sparseCheckoutCone", True)
        repository.get_worktree().set_cone_mode_patterns([directory])
        config.write_to_path()

    sparse_dir = work_root / "repo-dulwich-sparse"
    if path:
        try:
            branch_ref = b"refs/heads/" + ref.encode("utf-8")
            client, remote_path = isolated_transport(operation="clone")
            repo_obj = client.clone(
                remote_path, str(sparse_dir), checkout=False, depth=1, branch=ref,
                ref_prefix=[b"HEAD", branch_ref], filter_spec=partial_filter.encode("ascii"),
                protocol_version=2,
            )
            try:
                if not repo_obj.get_shallow():
                    raise _SkillDownloadError("Dulwich did not create a shallow repository.")
                config = repo_obj.get_config()
                config.set((b"remote", b"origin"), b"promisor", True)
                config.set((b"remote", b"origin"), b"partialCloneFilter", partial_filter.encode("ascii"))
                config.set((b"remote", b"origin"), b"fetch", b"+" + branch_ref + b":refs/remotes/origin/" + ref.encode("utf-8"))
                config.write_to_path()
                materialize_sparse_checkout(repo_obj, path)
            finally:
                repo_obj.close()
            return sparse_dir
        except Exception as exc:  # noqa: BLE001 - compatibility fallback below
            detail = f"{type(exc).__name__}: {exc}"
            if _looks_like_missing_ref_error(detail, ref):
                raise _missing_ref_error(ref, detail) from exc
            shutil.rmtree(sparse_dir, ignore_errors=True)

    repo_dir = work_root / "repo-dulwich"
    try:
        porcelain.clone(
            repo_url, str(repo_dir), checkout=True, depth=1, branch=ref.encode("utf-8"),
            errstream=io.BytesIO(), outstream=io.BytesIO(),
        )
    except Exception as exc:  # noqa: BLE001
        detail = f"{type(exc).__name__}: {exc}"
        if _looks_like_missing_ref_error(detail, ref):
            raise _missing_ref_error(ref, detail) from exc
        raise _SkillDownloadError(f"dulwich clone failed: {type(exc).__name__}: {exc}") from exc
    return repo_dir


def _safe_extract_zip(zip_file: zipfile.ZipFile, dest_dir: Path) -> None:
    dest_root = os.path.realpath(dest_dir)
    for info in zip_file.infolist():
        extracted_path = os.path.realpath(dest_dir / info.filename)
        if extracted_path == dest_root or extracted_path.startswith(dest_root + os.sep):
            continue
        raise _SkillDownloadError("GitHub zip archive contains files outside the destination.")
    zip_file.extractall(dest_dir)


def _download_github_zip(owner: str, repo: str, ref: str, work_root: Path) -> Path:
    api_url = f"https://api.github.com/repos/{owner}/{repo}/zipball/{urllib.parse.quote(ref, safe='')}"
    request = urllib.request.Request(
        api_url,
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": _GITHUB_USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            payload = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        raise _SkillDownloadError(f"GitHub zip download failed: HTTP {exc.code}. {detail}") from exc
    except Exception as exc:  # noqa: BLE001
        raise _SkillDownloadError(f"GitHub zip download failed: {type(exc).__name__}: {exc}") from exc

    zip_path = work_root / "repo.zip"
    zip_path.write_bytes(payload)
    extract_dir = work_root / "zip"
    extract_dir.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(zip_path, "r") as zip_file:
            _safe_extract_zip(zip_file, extract_dir)
            top_levels = {name.split("/")[0] for name in zip_file.namelist() if name}
    except zipfile.BadZipFile as exc:
        raise _SkillDownloadError("GitHub response was not a valid zip archive.") from exc
    if not top_levels:
        raise _SkillDownloadError("GitHub zip archive was empty.")
    if len(top_levels) != 1:
        raise _SkillDownloadError("Unexpected GitHub zip archive layout.")
    return extract_dir / next(iter(top_levels))


def _ensure_downloaded_skill_dir(repo_dir: Path, path: str) -> Path:
    skill_dir = repo_dir / path if path else repo_dir
    if not skill_dir.exists():
        raise _SkillDownloadError(f"Downloaded repo does not contain path: {path or '.'}")
    if not skill_dir.is_dir():
        raise _SkillDownloadError(f"path must point to a directory, but got a file: {path}")
    return skill_dir.resolve()


def _format_download_success(repo_dir: Path, skill_dir: Path, repo_url: str, source_uri: str) -> str:
    return (
        f"Absolute local path to the downloaded repository (repo_dir): {repo_dir.resolve()}\n"
        f"Absolute local path to the selected skill directory (skill_dir): {skill_dir}\n"
        f"GitHub repository clone URL used as the download source (repo_url): {repo_url}\n"
        f"Remote GitHub URL for the selected skill directory (source_uri): {source_uri}"
    )


@dataclass(frozen=True)
class _DownloadedGithubSkill:
    owner: str
    repo: str
    ref: str
    path: str
    repo_dir: Path
    skill_dir: Path
    repo_url: str
    source_uri: str


# GitHub downloads are staged under ``$TMPDIR/amphi-skill-*``. A staging's
# lifetime must span the scan request and the *separate* import request that
# copies from it, so it can't be cleaned inline — instead each new download first
# sweeps stagings older than the TTL (a scan→import round is seconds; an hour is
# ample slack) so they don't accumulate across a long-running daemon.
_SKILL_DOWNLOAD_PREFIX = "amphi-skill-"
_SKILL_DOWNLOAD_TTL_SECONDS = 3600


def _sweep_stale_skill_downloads() -> None:
    """Best-effort removal of stale GitHub skill download stagings. Never raises."""
    root = Path(tempfile.gettempdir())
    try:
        entries = [
            entry for entry in root.iterdir()
            if entry.name.startswith(_SKILL_DOWNLOAD_PREFIX)
        ]
    except OSError:
        return
    now = time.time()
    for entry in entries:
        try:
            if now - entry.stat().st_mtime <= _SKILL_DOWNLOAD_TTL_SECONDS:
                continue
        except OSError:
            continue
        shutil.rmtree(entry, ignore_errors=True)


def _download_skill_from_github(
    owner: str,
    repo: str,
    path: Optional[str] = None,
    ref: Optional[str] = None,
) -> _DownloadedGithubSkill:
    """Download or clone a single skill directory from GitHub and return local paths.

    A *single-ref primitive*: it downloads exactly ``ref`` (``None`` → the literal
    branch ``main``, NOT the repo's default branch). Resolving a repo's real
    default branch for bare repository URLs is the caller's responsibility — see
    ``_download_skill_from_github_url`` / ``_github_url_download_candidates``;
    don't rely on this function for that.
    """
    normalized_owner = _validate_github_segment(owner, "owner")
    normalized_repo = _validate_github_segment(repo, "repo")
    normalized_path = _validate_repo_relative_dir(path or "")
    normalized_ref = _validate_github_ref(ref or "main")

    repo_url = _github_repo_url(normalized_owner, normalized_repo)
    source_uri = _github_tree_url(
        normalized_owner, normalized_repo, normalized_ref, normalized_path,
    )
    _sweep_stale_skill_downloads()
    safe_prefix = f"{_SKILL_DOWNLOAD_PREFIX}{normalized_owner}-{normalized_repo}-".replace(os.sep, "-")
    work_root = Path(tempfile.mkdtemp(prefix=safe_prefix))
    errors: List[str] = []

    if shutil.which("git"):
        try:
            repo_dir = _git_sparse_checkout(repo_url, normalized_ref, normalized_path, work_root)
            skill_dir = _ensure_downloaded_skill_dir(repo_dir, normalized_path)
            return _DownloadedGithubSkill(
                normalized_owner, normalized_repo, normalized_ref, normalized_path,
                repo_dir.resolve(), skill_dir, repo_url, source_uri,
            )
        except _SkillRefNotFoundError:
            raise
        except Exception as exc:  # noqa: BLE001
            errors.append(f"git sparse checkout failed: {type(exc).__name__}: {exc}")
    else:
        errors.append("git command is not available in the local execution environment.")

    try:
        repo_dir = _dulwich_clone(repo_url, normalized_ref, normalized_path, work_root)
        skill_dir = _ensure_downloaded_skill_dir(repo_dir, normalized_path)
        return _DownloadedGithubSkill(
            normalized_owner, normalized_repo, normalized_ref, normalized_path,
            repo_dir.resolve(), skill_dir, repo_url, source_uri,
        )
    except _SkillRefNotFoundError:
        raise
    except Exception as exc:  # noqa: BLE001
        errors.append(f"dulwich clone failed: {type(exc).__name__}: {exc}")

    try:
        repo_dir = _download_github_zip(normalized_owner, normalized_repo, normalized_ref, work_root)
        skill_dir = _ensure_downloaded_skill_dir(repo_dir, normalized_path)
        return _DownloadedGithubSkill(
            normalized_owner, normalized_repo, normalized_ref, normalized_path,
            repo_dir.resolve(), skill_dir, repo_url, source_uri,
        )
    except Exception as exc:  # noqa: BLE001
        errors.append(f"GitHub REST zip download failed: {type(exc).__name__}: {exc}")

    raise _SkillDownloadError("; ".join(errors))


def _safe_urlparse(value: str) -> Optional[urllib.parse.ParseResult]:
    try:
        return urllib.parse.urlparse(value)
    except ValueError:
        return None


def _is_github_url(value: str) -> bool:
    parsed = _safe_urlparse(value)
    return (
        parsed is not None
        and parsed.scheme in {"http", "https"}
        and parsed.netloc.lower() == "github.com"
    )


def _is_skills_sh_url(value: str) -> bool:
    parsed = _safe_urlparse(value)
    if parsed is None:
        return False
    host = parsed.netloc.lower()
    return parsed.scheme in {"http", "https"} and host in {"skills.sh", "www.skills.sh"}


def _parse_github_url_base(url: str) -> tuple[str, str, str, List[str]]:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.netloc.lower() != "github.com":
        raise _SkillDownloadError("path must be an absolute local directory or a github.com URL.")
    parts = [urllib.parse.unquote(part) for part in parsed.path.split("/") if part]
    if len(parts) < 2:
        raise _SkillDownloadError("GitHub URL must include owner and repo.")
    owner = _validate_github_segment(parts[0], "owner")
    repo = _validate_github_segment(parts[1], "repo")
    kind = parts[2] if len(parts) > 2 else ""
    return owner, repo, kind, parts[3:]


def _resolve_default_branch(owner: str, repo: str) -> str:
    """Return the repository's default branch via the GitHub REST API.

    Used only for a bare repository URL (no ref in the URL): resolving the real
    default provides the exact ref to download. The REST API is used (not a
    ``git`` subprocess) so this works in environments without the ``git`` CLI —
    matching the zip download fallback, which is also pure HTTP.
    """
    api_url = f"https://api.github.com/repos/{owner}/{repo}"
    request = urllib.request.Request(
        api_url,
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": _GITHUB_USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            data = json.loads(response.read().decode("utf-8", errors="replace"))
    except Exception as exc:  # noqa: BLE001
        raise _SkillDownloadError(
            f"Unable to resolve GitHub default branch for {owner}/{repo}: {exc}"
        ) from exc
    branch = data.get("default_branch") if isinstance(data, dict) else None
    if not isinstance(branch, str) or not branch:
        raise _SkillDownloadError(
            f"Unable to resolve GitHub default branch for {owner}/{repo}."
        )
    return branch


def _github_url_download_candidates(url: str) -> List[tuple[str, str, str, str]]:
    owner, repo, kind, tail = _parse_github_url_base(url)
    if not kind:
        # Bare repo URL — no ref given. Resolve the repo's default branch now;
        # once resolved, it is the exact ref to download.
        ref = _resolve_default_branch(owner, repo)
        return [(owner, repo, ref, "")]
    if kind not in {"tree", "blob"}:
        raise _SkillDownloadError("GitHub URL must point to a repository root, tree, or blob path.")
    if not tail:
        raise _SkillDownloadError(f"GitHub {kind} URL must include a ref.")

    candidates: List[tuple[str, str, str, str]] = []
    for split_at in range(1, len(tail) + 1):
        ref = "/".join(tail[:split_at])
        path_parts = tail[split_at:]
        if kind == "blob" and path_parts and path_parts[-1] == "SKILL.md":
            path_parts = path_parts[:-1]
        candidates.append((owner, repo, ref, "/".join(path_parts)))
    return candidates


def _download_skill_from_github_url(url: str) -> _DownloadedGithubSkill:
    errors: List[str] = []
    for owner, repo, ref, path in _github_url_download_candidates(url):
        try:
            return _download_skill_from_github(owner, repo, path=path, ref=ref)
        except _SkillDownloadError as exc:
            errors.append(f"ref={ref!r}, path={path!r}: {exc}")
    raise _SkillDownloadError("Unable to resolve GitHub URL. Tried: " + "; ".join(errors))


@dataclass(frozen=True)
class _SkillShPageMetadata:
    skill_name: str
    repository_url: str


def _fetch_skills_sh_page(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml",
            "User-Agent": _GITHUB_USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            return response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raise _SkillDownloadError(f"skills.sh page request failed with HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        raise _SkillDownloadError(f"skills.sh page request failed: {exc.reason}") from exc
    except Exception as exc:  # noqa: BLE001
        raise _SkillDownloadError(f"skills.sh page request failed: {exc}") from exc


def _html_text(value: str) -> str:
    return html.unescape(re.sub(r"<[^>]*>", "", value)).strip()


def _extract_skill_name_from_skills_sh_page(page_html: str) -> Optional[str]:
    h1_match = re.search(r"<h1\b[^>]*>(.*?)</h1>", page_html, flags=re.IGNORECASE | re.DOTALL)
    if h1_match:
        name = _html_text(h1_match.group(1))
        if name:
            return name

    for json_ld_match in re.finditer(
        r"<script\b[^>]*type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
        page_html,
        flags=re.IGNORECASE | re.DOTALL,
    ):
        try:
            data = json.loads(html.unescape(json_ld_match.group(1)))
        except json.JSONDecodeError:
            continue
        objects = data if isinstance(data, list) else [data]
        for obj in objects:
            if not isinstance(obj, dict):
                continue
            if obj.get("@type") == "SoftwareApplication" and isinstance(obj.get("name"), str):
                name = obj["name"].strip()
                if name:
                    return name
    return None


def _extract_repository_url_from_skills_sh_page(page_html: str) -> Optional[str]:
    label_match = re.search(r">\s*Repository\s*<", page_html, flags=re.IGNORECASE)
    search_start = label_match.end() if label_match else 0
    href_pattern = re.compile(
        r"<a\b[^>]*\bhref=[\"'](https://github\.com/[^\"'#?\s]+)(?:[?#][^\"']*)?[\"'][^>]*>",
        flags=re.IGNORECASE,
    )
    match = href_pattern.search(page_html, search_start)
    if not match and search_start:
        match = href_pattern.search(page_html)
    if not match:
        return None
    return html.unescape(match.group(1)).rstrip("/")


def _parse_skills_sh_page_metadata(page_html: str) -> _SkillShPageMetadata:
    skill_name = _extract_skill_name_from_skills_sh_page(page_html)
    repository_url = _extract_repository_url_from_skills_sh_page(page_html)
    missing = []
    if not skill_name:
        missing.append("skill name")
    if not repository_url:
        missing.append("Repository GitHub URL")
    if missing:
        raise _SkillDownloadError(
            "Unable to read skills.sh page metadata: missing " + " and ".join(missing) + "."
        )
    return _SkillShPageMetadata(skill_name=skill_name, repository_url=repository_url)


def _fetch_skills_sh_page_metadata(url: str) -> _SkillShPageMetadata:
    return _parse_skills_sh_page_metadata(_fetch_skills_sh_page(url))


@dataclass(frozen=True)
class ScannedSkill:
    """One skill discovered by a local-path scan — not yet installed.

    Carries the subset of :class:`amphi_agent.Skill` metadata a scan can
    determine, with no store-assigned identity (no ``skill_id`` / ``group``
    until imported): ``source_uri`` identifies the original source, while
    ``local_path`` is the skill's on-disk directory used as the copy source,
    and ``updated_at`` is its ``SKILL.md`` modification time.
    """

    name: str
    description: str
    source: SkillSource
    source_uri: str
    local_path: str
    updated_at: Optional[datetime] = None


def _parse_frontmatter(content: str) -> Dict[str, Any]:
    """Parse a SKILL.md's leading ``--- … ---`` YAML frontmatter to a dict.

    Returns ``{}`` when there is no frontmatter or it doesn't parse to a
    mapping. (Models the agent tool's frontmatter reader.)
    """
    if not content.startswith("---"):
        return {}
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    closing = next(
        (i for i in range(1, len(lines)) if lines[i].strip() == "---"), None
    )
    if closing is None:
        return {}
    try:
        import yaml

        parsed = yaml.safe_load("\n".join(lines[1:closing]))
    except Exception:  # noqa: BLE001 — frontmatter is best-effort metadata
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _iter_skill_md_files(root: Path) -> List[Path]:
    """Walk *root*, returning every skill's ``SKILL.md`` path, sorted.

    Excludes VCS / cache metadata directories and, inside a skill, its
    support folders (``references/`` etc.). (Models the agent tool's
    discovery walk.)
    """
    matches: List[Path] = []
    if not root.is_dir():
        return matches
    for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
        has_skill_md = "SKILL.md" in filenames
        dirnames[:] = [
            d for d in dirnames
            if d not in _EXCLUDED_DIRS
            and not (has_skill_md and d in _SUPPORT_DIRS)
        ]
        if has_skill_md:
            matches.append(Path(dirpath) / "SKILL.md")
    return sorted(matches)


def scan_skills(root: Path) -> List[ScannedSkill]:
    """Deep-scan *root*, returning the metadata of every skill found under it.

    For each ``SKILL.md`` directory: ``name`` / ``description`` come from the
    file's frontmatter (``name`` falls back to the folder name), ``source`` is
    :attr:`SkillSource.LOCAL`, ``source_uri`` and ``local_path`` are the skill
    directory, and ``updated_at`` is the ``SKILL.md`` mtime (UTC).
    """
    skills: List[ScannedSkill] = []
    for skill_md in _iter_skill_md_files(root):
        skill_dir = skill_md.parent
        try:
            content = skill_md.read_text(encoding="utf-8")
        except OSError:
            content = ""
        frontmatter = _parse_frontmatter(content)
        name = str(frontmatter.get("name") or skill_dir.name)
        description = str(frontmatter.get("description") or "")
        try:
            updated_at: Optional[datetime] = datetime.fromtimestamp(
                skill_md.stat().st_mtime, tz=timezone.utc,
            )
        except OSError:
            updated_at = None
        skills.append(
            ScannedSkill(
                name=name,
                description=description,
                source=SkillSource.LOCAL,
                source_uri=str(skill_dir),
                local_path=str(skill_dir),
                updated_at=updated_at,
            )
        )
    return skills


def _scanned_skill_detail(skill: ScannedSkill) -> dict:
    """Map a :class:`ScannedSkill` to its ``/skills/import/scan`` wire shape."""
    return {
        "name": skill.name,
        "description": skill.description,
        "source": skill.source.value,
        "source_uri": skill.source_uri,
        "local_path": skill.local_path,
        "updated_at": skill.updated_at.isoformat() if skill.updated_at else None,
    }


class SkillsImportScanHandler(BaseHandler):
    """Bind: ``GET /skills/import/scan?path=`` — discover importable skills.

    Deep-scans the given **daemon-side** directory, or first downloads a
    github.com URL / skills.sh page's Repository URL to a temporary local
    directory, and returns the metadata of every skill found (a directory holding
    a ``SKILL.md``), so a client can preview an import. Read-only: nothing is
    written to the store.

    Local ``path`` values are validated on the daemon side — they must be
    absolute (else 400) and an existing directory (else 404). GitHub URLs may
    point at a repository root, tree directory, or ``SKILL.md`` blob. skills.sh
    URLs are resolved by reading the page skill name and Repository field.
    """

    tags = ["skills"]

    async def get(self, path: str) -> Response:
        raw = (path or "").strip()
        if not raw:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Query parameter 'path' is required.",
            )

        source_override: Optional[SkillSource] = None
        source_uri: Optional[str] = None
        skill_name_filter: Optional[str] = None
        if _is_github_url(raw):
            try:
                downloaded = _download_skill_from_github_url(raw)
            except _SkillDownloadError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"GitHub skill download failed: {exc}",
                ) from exc
            root = downloaded.skill_dir
            source_override = SkillSource.GITHUB
            source_uri = downloaded.source_uri
        elif _is_skills_sh_url(raw):
            try:
                page_metadata = _fetch_skills_sh_page_metadata(raw)
                downloaded = _download_skill_from_github_url(page_metadata.repository_url)
            except _SkillDownloadError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"skills.sh skill download failed: {exc}",
                ) from exc
            root = downloaded.skill_dir
            source_override = SkillSource.SKILLS_SH
            source_uri = downloaded.source_uri
            skill_name_filter = page_metadata.skill_name
        else:
            if not os.path.isabs(raw):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        "Scan path must be absolute, a github.com URL, "
                        f"or a skills.sh URL: {raw!r}."
                    ),
                )
            root = Path(raw)
            if not root.is_dir():
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"No such directory on the agent host: {raw!r}.",
                )

        skills = scan_skills(root)
        if skill_name_filter is not None:
            skills = [skill for skill in skills if skill.name == skill_name_filter]
            if not skills:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Downloaded repository does not contain skill {skill_name_filter!r}.",
                )
        if source_override is not None or source_uri is not None:
            skills = [
                ScannedSkill(
                    name=skill.name,
                    description=skill.description,
                    source=source_override or skill.source,
                    source_uri=source_uri or skill.source_uri,
                    local_path=skill.local_path,
                    updated_at=skill.updated_at,
                )
                for skill in skills
            ]
        return self.response([_scanned_skill_detail(s) for s in skills])


################################################################################
# Conflict check + import — POST /skills/import/check and POST /skills/import
################################################################################


class SkillImportItem(BaseModel):
    """One entry of the import payload — a skill the client picked to import.

    Mirrors the ``/skills/import/scan`` wire shape (so a client can hand the scan
    result straight back). Only ``name`` + ``local_path`` (the on-disk skill
    directory, the copy source) are load-bearing for the filesystem copy;
    ``source_uri`` records the original source and is stored unchanged.
    """

    name: str
    source_uri: str
    local_path: str
    description: str = ""
    source: str = SkillSource.LOCAL.value
    updated_at: Optional[str] = None


@dataclass(frozen=True)
class _ImportPlan:
    """A single skill's resolved import situation, shared by check + import.

    Conflicts and collisions are resolved purely against the **store** (no
    filesystem scan of the managed root — every install registers a row, so the
    store is authoritative). ``same_name_row`` is the already-installed skill
    sharing the incoming skill's name — the one an import overwrites, wherever it
    currently lives (:attr:`existing_dir`); its presence is the :attr:`conflict`.

    ``dest_dir`` is where the incoming skill *would* land (a direct child of the
    managed root, named after the source directory). ``occupant_row`` is the
    store row (if any) registered at ``dest_dir``; it matters only for
    :attr:`directory_collision`, where that slot belongs to a *differently-named*
    skill the import must not clobber.
    """

    incoming: SkillImportItem
    dest_dir: Path
    same_name_row: Optional[SkillRow]
    occupant_row: Optional[SkillRow]

    @property
    def conflict(self) -> bool:
        """A same-named skill is already installed → an overwrite."""
        return self.same_name_row is not None

    @property
    def existing_dir(self) -> Optional[Path]:
        """Directory the same-named skill currently lives in, or ``None``."""
        if self.same_name_row is not None and self.same_name_row.skill_dir:
            return Path(self.same_name_row.skill_dir)
        return None

    @property
    def occupant_name(self) -> Optional[str]:
        """Name of the skill registered at ``dest_dir``, or ``None``."""
        return self.occupant_row.name if self.occupant_row is not None else None

    @property
    def directory_collision(self) -> bool:
        """``dest_dir`` is registered to a *differently-named* skill, so importing
        here would clobber an unrelated skill — refused at import time."""
        return (
            self.occupant_row is not None
            and self.occupant_row.name != self.incoming.name
        )


async def _plan_import(
    items: List[SkillImportItem], user_id: str, root: Path,
) -> List[_ImportPlan]:
    """Resolve each incoming skill against the user's installed skills.

    Reads the user's store rows once and indexes them by **name** (to find the
    same-named skill an import would overwrite, wherever it lives) and by
    **directory** (to find whatever is registered at each incoming skill's
    destination, for collision detection). The managed root is *not* scanned —
    every install registers a store row, so the store is authoritative. This is
    the shared step both ``/skills/import/check`` and ``/skills/import`` run
    first.
    """
    rows_by_dir: Dict[Path, SkillRow] = {}
    rows_by_name: Dict[str, SkillRow] = {}
    for row in await SkillRepository().list_for_user(user_id):
        if row.skill_dir:
            rows_by_dir.setdefault(Path(row.skill_dir), row)
        rows_by_name.setdefault(row.name, row)

    plans: List[_ImportPlan] = []
    for item in items:
        basename = Path(item.local_path).name if item.local_path else ""
        dest_dir = root / basename if basename else root
        plans.append(
            _ImportPlan(
                incoming=item,
                dest_dir=dest_dir,
                same_name_row=rows_by_name.get(item.name),
                occupant_row=rows_by_dir.get(dest_dir),
            )
        )
    return plans


def _row_detail(row: SkillRow) -> dict:
    """Map a store skill row to the installed-skill wire shape (with id)."""
    return {
        "skill_id": row.id,
        "name": row.name,
        "description": row.description,
        "skill_dir": row.skill_dir,
        "group": row.group,
        "source": row.source,
        "source_uri": row.source_uri,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _imported_skill_detail(item: SkillImportItem) -> dict:
    """Map a :class:`SkillImportItem` to its ``/skills/import/check`` wire shape.

    The incoming skill isn't installed yet, so this is a verbatim echo of the
    posted item (no ``skill_id``) — the scan/check wire shapes round-trip.
    """
    return {
        "name": item.name,
        "description": item.description,
        "source": item.source,
        "source_uri": item.source_uri,
        "local_path": item.local_path,
        "updated_at": item.updated_at,
    }


def _check_result(plan: _ImportPlan) -> dict:
    """One ``/skills/import/check`` row: conflict flag + incoming + existing.

    ``existing`` is surfaced only for a genuine (same-name) conflict — the skill
    an import would overwrite (``conflict`` is exactly ``same_name_row is not
    None``). A directory occupied by a differently-named skill is *not* a
    conflict here; it surfaces as a failure at import time instead.
    """
    return {
        "conflict": plan.conflict,
        "incoming": _imported_skill_detail(plan.incoming),
        "existing": _row_detail(plan.same_name_row) if plan.conflict else None,
    }


def _replace_dir(src: Path, dest: Path) -> None:
    """Deep-copy *src* onto *dest*, removing whatever *dest* was first.

    The whole destination is deleted before the copy (not merged) so an
    overwrite never leaves stale files from the previous skill behind.
    """
    if dest.is_symlink() or dest.is_file():
        dest.unlink()
    elif dest.is_dir():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dest)


async def _execute_one(
    plan: _ImportPlan, user_id: str, repo: SkillRepository,
) -> Tuple[SkillRow, str]:
    """Install one planned skill, returning its store row and ``"added"`` /
    ``"overwritten"``. Raises on any failure so the caller can record it."""
    item = plan.incoming
    src = Path(item.local_path)
    if not item.local_path or not Path(item.local_path).name:
        raise ValueError("local_path is empty or has no final path component")
    if not src.is_dir():
        raise FileNotFoundError(
            f"source skill directory does not exist: {item.local_path}"
        )
    if plan.same_name_row is not None and plan.same_name_row.group == SkillGroup.BUILTIN.value:
        raise ValueError(
            f"built-in Skill {item.name!r} cannot be overwritten by an import"
        )

    # Refuse to clobber an unrelated skill: the destination directory is taken by
    # a differently-named skill. Raise BEFORE any filesystem change so the
    # existing skills are left fully intact.
    if plan.directory_collision:
        raise FileExistsError(
            f"target directory {str(plan.dest_dir)!r} is already occupied by a "
            f"different skill {plan.occupant_name!r}; refusing to overwrite an "
            f"unrelated skill"
        )

    dest = plan.dest_dir
    # Guard the degenerate case where the source already *is* the destination
    # (re-importing a skill from the managed root): a deep-copy would delete
    # the source before copying it. Skip the filesystem step, just upsert.
    try:
        same = src.resolve() == dest.resolve()
    except OSError:
        same = False
    if not same:
        _replace_dir(src, dest)

    # On overwrite, if the same-named skill currently lives in a *different*
    # directory, remove that stale directory so the skill moves to ``dest``
    # rather than being left duplicated under its old location.
    if plan.conflict:
        old_dir = plan.existing_dir
        if old_dir is not None and old_dir.is_dir():
            try:
                stale = old_dir.resolve() not in (dest.resolve(), src.resolve())
            except OSError:
                stale = old_dir not in (dest, src)
            if stale:
                shutil.rmtree(old_dir)

    group = SkillGroup.IMPORTED.value
    try:  # normalise the wire string to a known source, defaulting to LOCAL
        source = SkillSource(item.source).value
    except ValueError:
        source = SkillSource.LOCAL.value
    row: Optional[SkillRow] = None
    if plan.conflict:
        # Overwrite the same-named skill's row in place, keeping its id (and
        # moving its ``skill_dir`` to ``dest`` when the source dir differed).
        row = await repo.update(
            user_id, plan.same_name_row.id,
            name=item.name, description=item.description,
            skill_dir=str(dest), group=group, source=source,
            source_uri=item.source_uri,
        )
    if row is None:  # a fresh add (or the row to overwrite vanished mid-flight)
        row = await repo.create(
            user_id, name=item.name, description=item.description,
            skill_dir=str(dest), group=group, source=source,
            source_uri=item.source_uri,
        )
    return row, ("overwritten" if plan.conflict else "added")


class SkillsImportCheckHandler(BaseHandler):
    """Bind: ``POST /skills/import/check`` — conflict-check a scanned list.

    Body is the ``/skills/import/scan`` result (a list of skill metadata).
    Returns one result per item, in order, each carrying ``conflict`` plus the
    ``incoming`` skill and — for a genuine conflict — the ``existing`` record
    (with its ``skill_id``). A *conflict* means a **same-named** skill is already
    installed (anywhere under the managed root) and the import would overwrite
    it. A destination directory taken by a differently-named skill is *not* a
    conflict here (it fails at import time). Read-only: nothing is copied or
    persisted.
    """

    tags = ["skills"]

    async def post(self, items: List[SkillImportItem]) -> Response:
        user = await self.require_user()
        root = _skills_local_root()
        plans = await _plan_import(items, user.id, root)
        return self.response([_check_result(p) for p in plans])


class SkillsImportExecuteHandler(BaseHandler):
    """Bind: ``POST /skills/import`` — install a scanned skill list.

    Runs the same conflict check, then for each skill deep-copies its directory
    under the managed root and upserts its store row. A same-named skill already
    installed (anywhere) is overwritten — reusing its ``skill_id`` and moving it
    to the new directory when the source dir differs (its old directory is
    removed); an empty destination is a fresh add; a destination held by a
    **differently-named** skill is refused (counted as a failure with a
    directory-collision reason), leaving existing skills untouched. A per-skill
    failure is captured, never aborting the batch. Returns a summary: ``total`` /
    ``succeeded`` / ``failed`` / ``added`` / ``overwritten`` with an
    ``imported_skills`` list (each row + ``action``) and a ``failed_skills`` list
    (each echoing the incoming skill — name / description / source / source_uri /
    local_path / updated_at — plus a ``reason``).
    """

    tags = ["skills"]

    async def post(self, items: List[SkillImportItem]) -> Response:
        user = await self.require_user()
        root = _skills_local_root()
        plans = await _plan_import(items, user.id, root)

        repo = SkillRepository()
        imported_skills: List[dict] = []
        failed_skills: List[dict] = []
        added = overwritten = 0
        for plan in plans:
            try:
                row, action = await _execute_one(plan, user.id, repo)
            except Exception as exc:  # noqa: BLE001 — one bad skill ≠ batch fail
                detail = _imported_skill_detail(plan.incoming)
                detail["reason"] = f"{type(exc).__name__}: {exc}"
                failed_skills.append(detail)
                continue
            detail = _row_detail(row)
            detail["action"] = action
            imported_skills.append(detail)
            if action == "overwritten":
                overwritten += 1
            else:
                added += 1

        return self.response({
            "total": len(plans),
            "succeeded": len(imported_skills),
            "failed": len(failed_skills),
            "added": added,
            "overwritten": overwritten,
            "imported_skills": imported_skills,
            "failed_skills": failed_skills,
        })


__all__ = [
    "SkillsImportScanHandler",
    "SkillsImportCheckHandler",
    "SkillsImportExecuteHandler",
    "ScannedSkill",
    "scan_skills",
]
