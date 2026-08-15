#!/usr/bin/env python3
"""Synchronize GitHub-hosted skills into the local AmphiAgent skill catalog."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


UPDATE_THRESHOLD = timedelta(hours=6)
REMOTE_GIT_TIMEOUT_SECONDS = 120
DEFAULT_CATALOG_ROOT = Path.home() / ".bridgic" / "AmphiAgent" / "skills" / "catalog"
DEFAULT_UPDATE_FILE = Path.home() / ".bridgic" / "AmphiAgent" / "skills" / "skills_update.json"


class GitError(RuntimeError):
    """Base error for failures while invoking Git."""


class GitExecutableNotFoundError(GitError):
    """Raised when the Git executable is unavailable."""


class GitCommandError(GitError):
    """Raised when Git starts but the requested command fails."""


class GitCommandTimeoutError(GitError):
    """Raised when a Git command times out."""


@dataclass(frozen=True)
class SkillSpec:
    name: str
    owner: str
    repo: str
    skill_path: str

    @property
    def key(self) -> str:
        return f"{self.name}|{self.owner}|{self.repo}|{self.skill_path}"

    @property
    def repo_key(self) -> tuple[str, str]:
        return self.owner, self.repo

    @property
    def clone_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.repo}/"

    def repository_path(self, catalog_root: Path) -> Path:
        return catalog_root / self.owner / self.repo

    def local_path(self, catalog_root: Path) -> Path:
        repository = self.repository_path(catalog_root)
        return repository.joinpath(*self.skill_path.split("/")) if self.skill_path else repository

    def as_tuple(self) -> list[str]:
        return [self.name, self.owner, self.repo, self.skill_path]


@dataclass(frozen=True)
class SkillRequest:
    index: int
    spec: SkillSpec


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Synchronize GitHub skills into the local AmphiAgent skill catalog.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python sync_skills.py --skill pdf owner repo skills/pdf\n"
            "  python sync_skills.py --skills-file skills.json\n"
            "  python sync_skills.py --skills '[[\"pdf\",\"owner\",\"repo\",\"skills/pdf\"]]'\n\n"
            "The --skill option may be repeated. Input JSON may be a list of "
            "4-item arrays or objects with keys: name, owner, repo, skill_path."
        ),
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--skills", help="JSON list of skill tuples or skill objects.")
    source.add_argument("--skills-file", help="Path to a JSON file containing the skill list.")
    source.add_argument(
        "--skill",
        dest="skill_tuples",
        action="append",
        nargs=4,
        metavar=("NAME", "OWNER", "REPO", "SKILL_PATH"),
        help=(
            "One skill tuple; may be repeated. "
            "Format: --skill NAME OWNER REPO SKILL_PATH."
        ),
    )
    parser.add_argument(
        "--catalog-root",
        default=str(DEFAULT_CATALOG_ROOT),
        help=f"Local catalog root. Default: {DEFAULT_CATALOG_ROOT}",
    )
    parser.add_argument(
        "--update-file",
        default=str(DEFAULT_UPDATE_FILE),
        help=f"Update timestamp JSON file. Default: {DEFAULT_UPDATE_FILE}",
    )
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    return parser.parse_args()


def load_json_text(args: argparse.Namespace) -> Any:
    if args.skills is not None:
        text = args.skills
    else:
        try:
            text = Path(args.skills_file).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise ValueError(f"Unable to read skills file: {exc}") from exc

    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid skills JSON: {exc}") from exc


def normalize_skill(raw: Any, index: int) -> SkillSpec:
    if isinstance(raw, dict):
        missing = [field for field in ("name", "owner", "repo") if field not in raw]
        if missing:
            raise ValueError(f"Skill at index {index} is missing field: {missing[0]}")
        name = raw["name"]
        owner = raw["owner"]
        repo = raw["repo"]
        skill_path = raw.get("skill_path", "")
    elif isinstance(raw, (list, tuple)) and len(raw) == 4:
        name, owner, repo, skill_path = raw
    else:
        raise ValueError(
            f"Skill at index {index} must be a 4-item array or an object with "
            "name, owner, repo, skill_path."
        )

    values = {"name": name, "owner": owner, "repo": repo, "skill_path": skill_path}
    for field_name, value in values.items():
        if not isinstance(value, str):
            raise ValueError(f"Skill at index {index} has non-string field: {field_name}")

    if not name:
        raise ValueError(f"Skill at index {index} has empty name.")
    if not owner:
        raise ValueError(f"Skill at index {index} has empty owner.")
    if not repo:
        raise ValueError(f"Skill at index {index} has empty repo.")
    if any(character in owner or character in repo for character in ("/", "\\", "\0")):
        raise ValueError(f"Skill at index {index} has unsafe owner or repo.")
    if owner in {".", ".."} or repo in {".", ".."}:
        raise ValueError(f"Skill at index {index} has unsafe owner or repo.")

    if skill_path:
        if skill_path.startswith("/") or skill_path.endswith("/"):
            raise ValueError(
                f"Skill at index {index} has non-normalized relative skill_path."
            )
        parts = skill_path.split("/")
        if (
            any(part in {"", ".", ".."} for part in parts)
            or "\\" in skill_path
            or "\0" in skill_path
        ):
            raise ValueError(f"Skill at index {index} has unsafe skill_path.")

    return SkillSpec(name=name, owner=owner, repo=repo, skill_path=skill_path)


def load_skills(args: argparse.Namespace) -> list[SkillRequest]:
    raw = args.skill_tuples if args.skill_tuples is not None else load_json_text(args)
    if not isinstance(raw, list):
        raise ValueError("Skills input must be a list.")
    return [SkillRequest(index, normalize_skill(item, index)) for index, item in enumerate(raw)]


def group_by_repository(
    requests: Iterable[SkillRequest],
) -> dict[tuple[str, str], list[SkillRequest]]:
    groups: dict[tuple[str, str], list[SkillRequest]] = {}
    for request in requests:
        groups.setdefault(request.spec.repo_key, []).append(request)
    return groups


def load_update_data(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise ValueError(f"Unable to read update file: {exc}") from exc
    if not text.strip():
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Update file is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("Update file must contain a JSON object.")
    return data


def write_update_data(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as temporary_file:
            json.dump(data, temporary_file, ensure_ascii=False, indent=2)
            temporary_file.write("\n")
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def should_update(record: Any, current_time: datetime) -> bool:
    if not isinstance(record, dict):
        return True
    last_checked_at = parse_iso_datetime(record.get("last_checked_at"))
    if last_checked_at is None:
        return True
    return current_time - last_checked_at > UPDATE_THRESHOLD


def is_lexically_under(path: Path, parent: Path) -> bool:
    try:
        path.absolute().relative_to(parent.absolute())
        return path.absolute() != parent.absolute()
    except ValueError:
        return False


def remove_repository(path: Path, catalog_root: Path) -> None:
    if not is_lexically_under(path, catalog_root):
        raise RuntimeError(f"Refusing to remove path outside catalog root: {path}")
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def run_git(
    arguments: list[str],
    cwd: Path | None = None,
    timeout_seconds: float | None = None,
) -> str:
    command = ["git", *arguments]
    environment = os.environ.copy()
    environment.update({"LC_ALL": "C", "LANG": "C", "LANGUAGE": "C"})
    try:
        completed = subprocess.run(
            command,
            cwd=str(cwd) if cwd is not None else None,
            check=True,
            text=True,
            capture_output=True,
            env=environment,
            timeout=timeout_seconds,
        )
    except FileNotFoundError as exc:
        raise GitExecutableNotFoundError(
            "Git executable was not found. Install Git or use "
            "sync_skills_dulwich.py."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise GitCommandTimeoutError(
            f"Git command timed out after {timeout_seconds:g} seconds "
            f"({' '.join(command)})."
        ) from exc
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        stdout = (exc.stdout or "").strip()
        detail = stderr or stdout or f"exit code {exc.returncode}"
        raise GitCommandError(
            f"Git command failed ({' '.join(command)}): {detail}"
        ) from exc
    return completed.stdout.strip()


def is_valid_repository(path: Path) -> bool:
    if not path.is_dir() or not (path / ".git").is_dir():
        return False
    try:
        return run_git(["rev-parse", "--is-inside-work-tree"], cwd=path) == "true"
    except GitCommandError:
        return False


def is_sparse_checkout(repository_path: Path) -> bool:
    try:
        return run_git(
            ["config", "--bool", "--get", "core.sparseCheckout"], cwd=repository_path
        ) == "true"
    except GitCommandError:
        return False


def requested_sparse_paths(requests: Iterable[SkillRequest]) -> list[str]:
    paths = {request.spec.skill_path for request in requests if request.spec.skill_path}
    return sorted(paths)


def needs_full_checkout(requests: Iterable[SkillRequest]) -> bool:
    return any(not request.spec.skill_path for request in requests)


def clone_repository(
    requests: list[SkillRequest],
    repository_path: Path,
    catalog_root: Path,
) -> None:
    if not is_lexically_under(repository_path, catalog_root):
        raise RuntimeError(f"Local repository path is outside catalog root: {repository_path}")

    repository_path.parent.mkdir(parents=True, exist_ok=True)
    clone_url = requests[0].spec.clone_url
    sparse_paths: list[str] = []
    command = ["clone", "--depth", "1"]
    if not needs_full_checkout(requests):
        sparse_paths = requested_sparse_paths(requests)
        command.extend(["--filter=blob:none", "--sparse"])
    command.extend([clone_url, str(repository_path)])

    try:
        run_git(command, timeout_seconds=REMOTE_GIT_TIMEOUT_SECONDS)
        if sparse_paths:
            run_git(["sparse-checkout", "set", "--", *sparse_paths], cwd=repository_path)
        if not is_valid_repository(repository_path):
            raise RuntimeError("The cloned directory is not a valid Git repository.")
    except Exception as exc:
        try:
            remove_repository(repository_path, catalog_root)
        except Exception as cleanup_exc:
            raise RuntimeError(f"{exc}; cleanup failed: {cleanup_exc}") from exc
        raise


def prepare_existing_checkout(
    requests: list[SkillRequest],
    repository_path: Path,
    catalog_root: Path,
) -> list[SkillRequest]:
    """Expand an existing checkout without removing paths already present."""
    missing = [
        request
        for request in requests
        if not (request.spec.local_path(catalog_root) / "SKILL.md").is_file()
    ]
    sparse_enabled = is_sparse_checkout(repository_path)
    # A root skill requires the complete repository, even though cone-mode sparse
    # checkout normally leaves root-level files visible.
    if needs_full_checkout(requests) and sparse_enabled:
        run_git(["sparse-checkout", "disable"], cwd=repository_path)
        sparse_enabled = False

    missing_paths = sorted(
        {request.spec.skill_path for request in missing if request.spec.skill_path}
    )
    if missing_paths and sparse_enabled:
        # `add` is intentionally used instead of `set`: it preserves every path
        # selected by earlier runs, including skills not present in this input.
        run_git(["sparse-checkout", "add", "--", *missing_paths], cwd=repository_path)

    return missing


def restore_missing_skill_files(
    missing: Iterable[SkillRequest],
    repository_path: Path,
    catalog_root: Path,
) -> None:
    """Restore only missing SKILL.md files in a non-sparse working tree."""
    if is_sparse_checkout(repository_path):
        return
    for request in missing:
        skill_file = request.spec.local_path(catalog_root) / "SKILL.md"
        if skill_file.is_file():
            continue
        relative_file = (
            "SKILL.md"
            if not request.spec.skill_path
            else f"{request.spec.skill_path}/SKILL.md"
        )
        try:
            run_git(
                ["restore", "--source=HEAD", "--worktree", "--", relative_file],
                cwd=repository_path,
            )
        except GitCommandError:
            # Validation below provides the per-skill error. A path may only
            # become available after a later remote update, or may not exist.
            continue


def parse_front_matter_scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Unable to parse a quoted front matter value.") from exc
        return parsed if isinstance(parsed, str) else str(parsed)
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    for index, character in enumerate(value):
        if character == "#" and index > 0 and value[index - 1].isspace():
            return value[:index].rstrip()
    return value


def parse_block_scalar(lines: list[str], folded: bool) -> str:
    non_empty_indents = [len(line) - len(line.lstrip()) for line in lines if line.strip()]
    indent = min(non_empty_indents) if non_empty_indents else 0
    normalized = [line[indent:] if line.strip() else "" for line in lines]
    if not folded:
        return "\n".join(normalized)

    paragraphs: list[str] = []
    current: list[str] = []
    for line in normalized:
        if line:
            current.append(line)
        else:
            if current:
                paragraphs.append(" ".join(current))
                current = []
            paragraphs.append("")
    if current:
        paragraphs.append(" ".join(current))
    return "\n".join(paragraphs)


def read_skill_metadata(skill_file: Path) -> dict[str, str]:
    try:
        lines = skill_file.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise RuntimeError(f"Unable to read SKILL.md: {exc}") from exc

    if not lines or lines[0].strip() != "---":
        raise RuntimeError("SKILL.md does not start with front matter.")
    try:
        end_index = next(index for index, line in enumerate(lines[1:], 1) if line.strip() == "---")
    except StopIteration as exc:
        raise RuntimeError("SKILL.md front matter is not closed.") from exc

    front_matter = lines[1:end_index]
    metadata: dict[str, str] = {}
    index = 0
    while index < len(front_matter):
        line = front_matter[index]
        if not line.strip() or line.lstrip().startswith("#") or line[:1].isspace():
            index += 1
            continue
        if ":" not in line:
            raise RuntimeError(
                f"Unable to parse SKILL.md front matter at line {index + 2}."
            )
        key, raw_value = line.split(":", 1)
        key = key.strip()
        if not key:
            raise RuntimeError(
                f"Unable to parse SKILL.md front matter at line {index + 2}."
            )
        if key in metadata:
            raise RuntimeError(f"SKILL.md front matter contains duplicate field: {key}")
        raw_value = raw_value.strip()
        if raw_value in {"|", "|-", "|+", ">", ">-", ">+"}:
            block_lines: list[str] = []
            index += 1
            while index < len(front_matter):
                block_line = front_matter[index]
                if block_line and not block_line[:1].isspace():
                    break
                block_lines.append(block_line)
                index += 1
            metadata[key] = parse_block_scalar(block_lines, folded=raw_value.startswith(">"))
            continue
        metadata[key] = parse_front_matter_scalar(raw_value)
        index += 1

    return metadata


def update_record(
    update_data: dict[str, Any],
    skill: SkillSpec,
    checked_at: str,
    synced_at: str | None,
) -> None:
    existing = update_data.get(skill.key)
    previous_synced_at = existing.get("last_synced_at") if isinstance(existing, dict) else ""
    if not isinstance(previous_synced_at, str):
        previous_synced_at = ""
    update_data[skill.key] = {
        "last_checked_at": checked_at,
        "last_synced_at": synced_at if synced_at is not None else previous_synced_at,
    }


def success_result(
    skill: SkillSpec,
    status: str,
    metadata: dict[str, str],
    local_path: Path,
) -> dict[str, Any]:
    return {
        "skill": skill.as_tuple(),
        "status": status,
        "name": metadata["name"],
        "description": metadata["description"],
        "local_path": str(local_path),
    }


def failure_result(skill: SkillSpec, stage: str, reason: str) -> dict[str, Any]:
    return {"skill": skill.as_tuple(), "status": "failed", "stage": stage, "reason": reason}


def validate_skill(skill: SkillSpec, catalog_root: Path) -> dict[str, str]:
    skill_file = skill.local_path(catalog_root) / "SKILL.md"
    if not skill_file.is_file():
        raise RuntimeError(
            f"Local skill path does not contain SKILL.md: {skill.local_path(catalog_root)}"
        )
    metadata = read_skill_metadata(skill_file)
    actual_name = metadata.get("name")
    if actual_name != skill.name:
        raise RuntimeError(
            f"SKILL.md name mismatch: expected {skill.name!r}, got {actual_name!r}."
        )
    if "description" not in metadata:
        raise RuntimeError("SKILL.md front matter does not contain description.")
    return metadata


def fail_group(
    requests: Iterable[SkillRequest], stage: str, reason: str
) -> dict[int, dict[str, Any]]:
    return {request.index: failure_result(request.spec, stage, reason) for request in requests}


def process_repository(
    requests: list[SkillRequest],
    catalog_root: Path,
    update_data: dict[str, Any],
    current_time: datetime,
) -> tuple[dict[int, dict[str, Any]], bool]:
    repository_path = requests[0].spec.repository_path(catalog_root)
    repository_existed = repository_path.exists() or repository_path.is_symlink()
    newly_cloned = False
    remotely_synchronized = False
    status = "local-check-passed"

    if repository_existed:
        try:
            repository_is_valid = is_valid_repository(repository_path)
        except GitExecutableNotFoundError as exc:
            return fail_group(requests, "git-availability", str(exc)), False
        except GitCommandTimeoutError as exc:
            return fail_group(
                requests, "local-repository-validation", str(exc)
            ), False

        if not repository_is_valid:
            reason = f"Local repository is not a valid Git repository: {repository_path}"
            return fail_group(
                requests, "local-repository-validation", reason
            ), False

    if not repository_existed:
        try:
            clone_repository(requests, repository_path, catalog_root)
        except Exception as exc:
            return fail_group(requests, "clone", str(exc)), False
        newly_cloned = True
        remotely_synchronized = True
        status = "newly-synchronized"
        missing_before_update: list[SkillRequest] = []
    else:
        try:
            missing_before_update = prepare_existing_checkout(
                requests, repository_path, catalog_root
            )
        except Exception as exc:
            return fail_group(requests, "checkout-adjustment", str(exc)), False

        update_needed = bool(missing_before_update) or any(
            should_update(update_data.get(request.spec.key), current_time)
            for request in requests
        )
        if update_needed:
            try:
                # Pull from the repository root. Sparse checkout configuration,
                # when still enabled, remains active across the pull.
                run_git(
                    ["pull"],
                    cwd=repository_path,
                    timeout_seconds=REMOTE_GIT_TIMEOUT_SECONDS,
                )
            except Exception as exc:
                return fail_group(requests, "update", str(exc)), False
            remotely_synchronized = True
            status = "updated"

        # A full checkout can contain an intentional local deletion. Restore
        # only the minimum required file, never the whole repository or skill.
        try:
            restore_missing_skill_files(
                missing_before_update, repository_path, catalog_root
            )
        except GitExecutableNotFoundError as exc:
            return fail_group(requests, "git-availability", str(exc)), False
        except GitError as exc:
            return fail_group(
                requests, "skill-file-restoration", str(exc)
            ), False

    metadata_by_index: dict[int, dict[str, str]] = {}
    validation_errors: dict[int, str] = {}
    for request in requests:
        try:
            metadata_by_index[request.index] = validate_skill(request.spec, catalog_root)
        except Exception as exc:
            validation_errors[request.index] = str(exc)

    if validation_errors and newly_cloned and len(validation_errors) == len(requests):
        cleanup_suffix = ""
        try:
            remove_repository(repository_path, catalog_root)
        except Exception as cleanup_exc:
            cleanup_suffix = f"; cleanup failed: {cleanup_exc}"
        results: dict[int, dict[str, Any]] = {}
        for request in requests:
            reason = validation_errors[request.index] + cleanup_suffix
            results[request.index] = failure_result(
                request.spec, "metadata-validation", reason
            )
        return results, False

    checked_at = current_time.isoformat()
    results = {}
    records_changed = False
    for request in requests:
        if request.index in validation_errors:
            results[request.index] = failure_result(
                request.spec, "metadata-validation", validation_errors[request.index]
            )
            continue
        metadata = metadata_by_index[request.index]
        update_record(
            update_data,
            request.spec,
            checked_at=checked_at,
            synced_at=checked_at if remotely_synchronized else None,
        )
        records_changed = True
        results[request.index] = success_result(
            request.spec,
            status,
            metadata,
            request.spec.local_path(catalog_root),
        )
    return results, records_changed


def main() -> int:
    args = parse_args()
    update_file: Path | None = None
    update_file_existed = True
    try:
        requests = load_skills(args)
        catalog_root = Path(args.catalog_root).expanduser()
        update_file = Path(args.update_file).expanduser()
        update_file_existed = update_file.exists()
        update_data = load_update_data(update_file)
    except ValueError as exc:
        print(
            json.dumps({"status": "failed", "reason": str(exc)}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 2

    current_time = datetime.now(timezone.utc)
    results_by_index: dict[int, dict[str, Any]] = {}
    records_changed = False
    for repository_requests in group_by_repository(requests).values():
        repository_results, repository_records_changed = process_repository(
            repository_requests, catalog_root, update_data, current_time
        )
        results_by_index.update(repository_results)
        records_changed = records_changed or repository_records_changed

    if records_changed or not update_file_existed:
        try:
            write_update_data(update_file, update_data)
        except OSError as exc:
            print(
                json.dumps(
                    {"status": "failed", "reason": f"Unable to write update file: {exc}"},
                    ensure_ascii=False,
                ),
                file=sys.stderr,
            )
            return 2

    results = [results_by_index[request.index] for request in requests]
    has_failure = any(result.get("status") == "failed" for result in results)
    output = {"status": "failed" if has_failure else "succeeded", "results": results}
    print(json.dumps(output, ensure_ascii=False, indent=2 if args.pretty else None))
    return 1 if has_failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
