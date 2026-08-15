import asyncio
import os
import re
import shutil
import stat
import tempfile
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, ClassVar, Dict, Iterator, Optional, Tuple

import yaml
from markdown_it import MarkdownIt
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from yaml.constructor import ConstructorError
from yaml.nodes import MappingNode
from yaml.tokens import AliasToken, AnchorToken

from ..amphi_store import (
    UserInput,
    Workflow as WorkflowRecord,
    WorkflowNameConflictError,
    WorkflowRepository,
)


WORKFLOWS_ROOT_ENV_VAR = "BRIDGIC_AGENT_WORKFLOWS_ROOT"


class _WorkflowMetadata(BaseModel):
    """Validated ``WORKFLOW.md`` frontmatter used by the Build pipeline."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(
        min_length=1,
        max_length=100,
        pattern=r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
    )
    description: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_description(self) -> "_WorkflowMetadata":
        if "\n" in self.description or "\r" in self.description:
            raise ValueError("`description` must fit on one line")
        return self


@dataclass(frozen=True)
class WorkflowPackage:
    """One complete on-disk Workflow artifact package.

    Parameters
    ----------
    root : Path
        Directory containing the Build documents and ``workflow/`` source.
    workflow_id : str, optional
        Stable identity when this package represents a saved or pinned Workflow.
    """

    root: Path
    workflow_id: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    domain: Optional[str] = None
    source_session_id: Optional[str] = None
    source_turn_id: Optional[str] = None

    @dataclass(frozen=True)
    class Step:
        """One ordered section parsed from a Workflow source document."""

        index: int
        title: str
        instruction: str

    ENTRY_NAME: ClassVar[str] = "WORKFLOW.md"
    VALIDATION_NAME: ClassVar[str] = "VALIDATE.md"
    ROOT_ENTRY_NAMES: ClassVar[tuple[str, ...]] = (
        "task.md",
        "explore.md",
        "verify.md",
        "workflow",
    )
    BUILD_DOCUMENT_NAMES: ClassVar[tuple[str, ...]] = ROOT_ENTRY_NAMES[:3]
    _HIDDEN_TREE_NAMES: ClassVar[frozenset[str]] = frozenset({
        ".state.json",
        ".state.json.tmp",
    })
    SCRIPT_PATH_RE: ClassVar[re.Pattern[str]] = re.compile(
        r"(?<![\w.-])((?:(?:[A-Za-z]:)?[/\\])?"
        r"(?:[\w.-]+[/\\])*scripts[/\\][\w./\\-]+\.py)\b"
    )
    GENERIC_HEADING_RE: ClassVar[re.Pattern[str]] = re.compile(
        r"Section\s+\d+", flags=re.IGNORECASE,
    )
    MAX_FRONTMATTER_BYTES: ClassVar[int] = 64 * 1024
    _MARKDOWN: ClassVar[MarkdownIt] = MarkdownIt("commonmark")

    def __post_init__(self) -> None:
        object.__setattr__(self, "root", Path(self.root))

    @property
    def source_root(self) -> Path:
        """Return the executable source directory under this package."""
        return self.root / "workflow"

    @property
    def entry_path(self) -> Path:
        return self.source_root / self.ENTRY_NAME

    @property
    def validation_path(self) -> Path:
        return self.source_root / self.VALIDATION_NAME

    @property
    def scripts_dir(self) -> Path:
        return self.source_root / "scripts"

    @property
    def task_markdown(self) -> Optional[str]:
        """Return the saved task definition used as an edit baseline."""
        return self.read_document("task.md")

    @property
    def is_available(self) -> bool:
        """Return whether the source directory and execution entry are readable."""
        return (
            not self.root.is_symlink()
            and self.root.is_dir()
            and not self.source_root.is_symlink()
            and self.source_root.is_dir()
            and not self.entry_path.is_symlink()
            and self.entry_path.is_file()
        )

    @classmethod
    def _parse_metadata(cls, content: str) -> int:
        lines = content.splitlines()
        if not lines or lines[0].strip() != "---":
            raise ValueError("frontmatter must start with a leading `---` line")
        closing = next(
            (index for index in range(1, len(lines)) if lines[index].strip() == "---"),
            None,
        )
        if closing is None:
            raise ValueError("frontmatter is missing its closing `---` line")
        frontmatter = "\n".join(lines[1:closing])
        if len(frontmatter.encode("utf-8")) > cls.MAX_FRONTMATTER_BYTES:
            raise ValueError("frontmatter exceeds the 64 KiB limit")

        class UniqueKeyLoader(yaml.SafeLoader):
            """Safe YAML loader that refuses silent duplicate-key overwrite."""

        def construct_mapping(loader, node, deep=False):
            if not isinstance(node, MappingNode):
                raise ConstructorError(None, None, "expected a mapping node", node.start_mark)
            loader.flatten_mapping(node)
            mapping = {}
            for key_node, value_node in node.value:
                key = loader.construct_object(key_node, deep=deep)
                try:
                    duplicate = key in mapping
                except TypeError as exc:
                    raise ConstructorError(
                        None,
                        None,
                        "unhashable mapping key",
                        key_node.start_mark,
                    ) from exc
                if duplicate:
                    raise ConstructorError(
                        None,
                        None,
                        "duplicate mapping key",
                        key_node.start_mark,
                    )
                mapping[key] = loader.construct_object(value_node, deep=deep)
            return mapping

        UniqueKeyLoader.add_constructor(
            yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
            construct_mapping,
        )
        try:
            if any(
                isinstance(token, (AliasToken, AnchorToken))
                for token in yaml.scan(frontmatter)
            ):
                raise ValueError("frontmatter cannot use YAML anchors or aliases")
            parsed = yaml.load(frontmatter, Loader=UniqueKeyLoader)
        except ConstructorError as exc:
            raise ValueError(
                "frontmatter contains an invalid or duplicate YAML mapping key",
            ) from exc
        except yaml.YAMLError as exc:
            raise ValueError("frontmatter is not valid YAML") from exc
        if not isinstance(parsed, dict):
            raise ValueError("frontmatter must be a YAML mapping")
        try:
            _WorkflowMetadata.model_validate(parsed)
            return closing
        except ValidationError as exc:
            issue = exc.errors(include_input=False)[0]
            location = ".".join(str(part) for part in issue.get("loc") or ())
            prefix = f"`{location}`: " if location else ""
            raise ValueError(f"{prefix}{issue['msg']}") from exc

    @property
    def execution_steps(self) -> Tuple["WorkflowPackage.Step", ...]:
        """Return non-empty execution sections in document order."""
        content = self._read_document(self.entry_path)
        closing = self._parse_metadata(content)
        body = "\n".join(content.splitlines()[closing + 1 :])
        return tuple(self._parse_steps(body, "execution step"))

    @property
    def validation_steps(self) -> Tuple["WorkflowPackage.Step", ...]:
        """Return validation sections or an empty tuple in execution-only mode."""
        content = self._read_document(self.validation_path)
        if self._is_no_validation_document(content):
            return ()
        return tuple(self._parse_steps(content, "validation check"))

    def steps(self, stage: str) -> Tuple["WorkflowPackage.Step", ...]:
        """Return the ordered sections for one Workflow cognitive stage."""
        if stage == "execute":
            return self.execution_steps
        if stage == "validate":
            return self.validation_steps
        raise ValueError(f"Unsupported Workflow stage: {stage!r}")

    def read_document(self, name: str) -> Optional[str]:
        """Read one non-empty direct UTF-8 artifact document, or return ``None``."""
        candidate = Path(name)
        if not name or candidate.name != name or name in {".", ".."}:
            raise ValueError("Workflow artifact name must be a direct file name")
        path = self.root / name
        if self.root.is_symlink() or not self.root.is_dir() or path.is_symlink():
            return None
        try:
            body = path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError):
            return None
        return body or None

    def tree_lines(self, max_entries: int = 80) -> list[str]:
        """Render a bounded artifact tree without private state files."""
        lines = [f"{self.root.name}/"]
        if self.root.is_symlink() or not self.root.is_dir():
            return lines

        count = 0
        truncated = False

        def visit(directory: Path, depth: int) -> None:
            nonlocal count, truncated
            try:
                children = sorted(directory.iterdir(), key=lambda path: path.name)
            except OSError:
                return
            for path in children:
                if path.name in self._HIDDEN_TREE_NAMES:
                    continue
                if count >= max_entries:
                    truncated = True
                    return
                is_directory = not path.is_symlink() and path.is_dir()
                lines.append(f"{'  ' * depth}{path.name}{'/' if is_directory else ''}")
                count += 1
                if is_directory:
                    visit(path, depth + 1)
                if truncated:
                    return

        visit(self.root, 1)
        if truncated:
            lines.append("  ... (more entries omitted)")
        return lines

    @classmethod
    def _is_no_validation_document(cls, content: str) -> bool:
        return content.strip() == "---\nvalidation: none\n---"

    @property
    def validation_disabled(self) -> bool:
        """Return whether this package explicitly skips result validation."""
        try:
            return self._is_no_validation_document(self._read_document(self.validation_path))
        except ValueError:
            return False

    def _read_document(self, path: Path) -> str:
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"workflow/{path.name} is missing or is not a regular file")
        try:
            return path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise ValueError(f"workflow/{path.name} cannot be read as UTF-8: {exc}") from exc

    @classmethod
    def _parse_steps(cls, body: str, kind: str) -> list["WorkflowPackage.Step"]:
        lines = body.splitlines()
        headings: list[tuple[int, int, str]] = []
        tokens = cls._MARKDOWN.parse(body)
        for position, token in enumerate(tokens):
            if token.type != "heading_open" or token.tag != "h1" or token.map is None:
                continue
            inline = tokens[position + 1]
            title = inline.content.strip() if inline.type == "inline" else ""
            headings.append((token.map[0], token.map[1], title))

        if not headings:
            raise ValueError(f"has no level-one {kind.replace(' ', '-')} heading")

        steps = []
        for index, (_, instruction_start, title) in enumerate(headings, start=1):
            if not title:
                raise ValueError(f"contains an empty level-one {kind.replace(' ', '-')} heading")
            if cls.GENERIC_HEADING_RE.fullmatch(title):
                raise ValueError(
                    f"heading `# {title}` is generic; describe what that {kind} "
                    "does in the Build language"
                )
            instruction_end = headings[index][0] if index < len(headings) else len(lines)
            instruction = "\n".join(lines[instruction_start:instruction_end]).strip()
            if not instruction:
                raise ValueError(f"{kind} `# {title}` has no instructions")
            steps.append(cls.Step(index=index, title=title, instruction=instruction))
        return steps

    def validation_reason(self) -> Optional[str]:
        """Return ``None`` when the package is valid, else a rejection reason."""

        def tree_rejection() -> Optional[str]:
            if self.root.is_symlink():
                return "Workflow package root must be a real directory, not a symbolic link."
            if not self.root.is_dir():
                return "Workflow package root is missing."
            if self.source_root.is_symlink():
                return "workflow/ must be a real directory, not a symbolic link."
            if not self.source_root.is_dir():
                return (
                    "workflow/ is missing; create it with the required WORKFLOW.md and "
                    "VALIDATE.md documents."
                )
            for root, dirs, files in os.walk(
                self.source_root,
                topdown=True,
                followlinks=False,
            ):
                root_path = Path(root)
                for name in sorted(dirs):
                    path = root_path / name
                    if name in {".venv", "node_modules"}:
                        rel = path.relative_to(self.source_root).as_posix()
                        return (
                            f"workflow/{rel} is a local dependency environment; "
                            "Workflow source must use the app-level shared runtime bases."
                        )
                    if path.is_symlink():
                        rel = path.relative_to(self.source_root).as_posix()
                        return f"workflow/{rel} is a symbolic link; workflow artifacts cannot contain links."
                for name in sorted(files):
                    path = root_path / name
                    rel = path.relative_to(self.source_root).as_posix()
                    try:
                        mode = path.lstat().st_mode
                    except OSError as exc:
                        return f"workflow/{rel} cannot be inspected: {exc}."
                    if stat.S_ISLNK(mode):
                        return f"workflow/{rel} is a symbolic link; workflow artifacts cannot contain links."
                    if not stat.S_ISREG(mode):
                        return f"workflow/{rel} is not a regular file."
            return None

        def script_reference_rejection(reference: str, scripts_dir: Path, document_name: str) -> Optional[str]:
            if "\\" in reference or reference.startswith("/"):
                return f"`{reference}` is an invalid script path; use a relative `scripts/...py` path."
            if reference.startswith(".build/workflow/scripts/"):
                replacement = reference.removeprefix(".build/workflow/")
                return (
                    f"`{reference}` references the temporary Build workspace. Paths inside "
                    f"{document_name} are relative to `workflow/`; replace it with `{replacement}`. "
                    "Do not move or copy the on-disk script."
                )
            if reference.startswith("workflow/scripts/"):
                replacement = reference.removeprefix("workflow/")
                return (
                    f"`{reference}` includes the workflow directory itself. Paths inside "
                    f"{document_name} are relative to `workflow/`; replace it with `{replacement}`. "
                    "Do not move or copy the on-disk script."
                )
            parts = reference.split("/")
            if (
                len(parts) < 2
                or parts[0] != "scripts"
                or any(part in {"", ".", ".."} for part in parts)
            ):
                return (
                    f"`{reference}` is an invalid script path; it must stay under "
                    "`workflow/scripts/` and cannot contain `.` or `..`."
                )
            candidate = scripts_dir.parent.joinpath(*parts)
            try:
                candidate.resolve(strict=False).relative_to(scripts_dir.resolve(strict=False))
            except ValueError:
                return f"`{reference}` escapes `workflow/scripts/`."
            return None

        def read_required_document(name: str) -> Tuple[Optional[str], Optional[str]]:
            path = self.source_root / name
            if path.is_symlink() or not path.is_file():
                return None, f"workflow/{name} is missing; create the required entry file."
            try:
                content = path.read_text(encoding="utf-8")
            except (OSError, UnicodeError) as exc:
                return None, f"workflow/{name} cannot be read as UTF-8: {exc}."
            if not content.strip():
                return None, f"workflow/{name} is empty."
            return content, None

        tree_reason = tree_rejection()
        if tree_reason:
            return tree_reason

        content, reason = read_required_document(self.ENTRY_NAME)
        if reason:
            return reason
        assert content is not None
        try:
            closing = self._parse_metadata(content)
        except ValueError as exc:
            return f"workflow/WORKFLOW.md frontmatter is invalid: {exc}."

        workflow_body = "\n".join(content.splitlines()[closing + 1 :])
        try:
            self._parse_steps(workflow_body, "execution step")
        except ValueError as exc:
            return f"workflow/{self.ENTRY_NAME} {exc}."

        validation_body, reason = read_required_document(self.VALIDATION_NAME)
        if reason:
            return reason
        assert validation_body is not None
        validation_disabled = self._is_no_validation_document(validation_body)
        if not validation_disabled:
            lines = validation_body.splitlines()
            if (
                lines
                and lines[0].strip() == "---"
                and any(
                    line.strip().startswith("validation:")
                    for line in lines[1:]
                    if line.strip() != "---"
                )
            ):
                return (
                    "workflow/VALIDATE.md uses a validation mode declaration, but "
                    "execution-only mode requires exactly `---`, `validation: none`, "
                    "`---` on three lines with no body."
                )
            try:
                self._parse_steps(validation_body, "validation check")
            except ValueError as exc:
                return f"workflow/{self.VALIDATION_NAME} {exc}."

        documents = (
            (self.ENTRY_NAME, workflow_body, closing + 2),
            (self.VALIDATION_NAME, validation_body, 1),
        )
        references: set[str] = set()
        reference_sources: dict[str, str] = {}
        scripts_dir = self.scripts_dir
        if scripts_dir.exists() and not scripts_dir.is_dir():
            return "workflow/scripts must be a directory when present."

        on_disk = set()
        if scripts_dir.is_dir():
            for root, _, files in os.walk(scripts_dir, followlinks=False):
                root_path = Path(root)
                for filename in files:
                    path = root_path / filename
                    if path.suffix == ".py":
                        on_disk.add(f"scripts/{path.relative_to(scripts_dir).as_posix()}")

        for document_name, body, body_start_line in documents:
            invalid_references = []
            for match in self.SCRIPT_PATH_RE.finditer(body):
                reference = match.group(1)
                references.add(reference)
                reference_sources.setdefault(reference, document_name)
                path_reason = script_reference_rejection(reference, scripts_dir, document_name)
                if path_reason:
                    line_number = body_start_line + body.count("\n", 0, match.start())
                    invalid_references.append(
                        f"- workflow/{document_name} line {line_number}: {path_reason}"
                    )
            if invalid_references:
                count = len(invalid_references)
                noun = "reference" if count == 1 else "references"
                return (
                    f"workflow/{document_name} contains {count} invalid script {noun}:\n"
                    + "\n".join(invalid_references)
                )

        for reference in sorted(references):
            script_path = self.source_root.joinpath(*reference.split("/"))
            if not script_path.is_file():
                document_name = reference_sources[reference]
                return (
                    f"workflow/{document_name} references `{reference}`, but that file does "
                    "not exist under workflow/scripts/."
                )
            try:
                source = script_path.read_text(encoding="utf-8")
            except (OSError, UnicodeError) as exc:
                return f"workflow/{reference} cannot be read as UTF-8: {exc}."
            try:
                compile(source, reference, "exec")
            except SyntaxError as exc:
                return (
                    f"workflow/{reference} has a syntax error "
                    f"(line {exc.lineno}: {exc.msg})."
                )

        orphaned = sorted(on_disk - references)
        if orphaned:
            return (
                f"workflow/{orphaned[0]} exists but is not referenced by any "
                "step in WORKFLOW.md or VALIDATE.md."
            )
        return None


@dataclass(frozen=True)
class _SavedWorkflowStorage:
    """One immutable Workflow definition in the global user library."""

    workflow_id: str
    root: Path

    def __post_init__(self) -> None:
        if not isinstance(self.workflow_id, str) or not self.workflow_id.strip():
            raise ValueError("Saved Workflow id must be non-empty")
        object.__setattr__(self, "root", Path(self.root).expanduser().resolve())

    @classmethod
    def managed(cls, workflow_id: str) -> "_SavedWorkflowStorage":
        """Return the canonical global space for one Workflow id."""
        return cls(workflow_id, cls.library_root() / workflow_id)

    @staticmethod
    def library_root() -> Path:
        configured = os.getenv(WORKFLOWS_ROOT_ENV_VAR)
        if configured:
            return Path(configured).expanduser().resolve()
        return (Path.home() / ".bridgic" / "AmphiAgent" / "workflows").resolve()

    @property
    def is_available(self) -> bool:
        try:
            self._validate_root(self.root)
        except (FileNotFoundError, OSError, UnicodeError, ValueError):
            return False
        return True

    def create_from_source(self, source_root: Path) -> Path:
        """Atomically materialize one source package into this empty space."""
        parent = self.library_root()
        parent.mkdir(parents=True, exist_ok=True)
        if self.root.exists() or self.root.is_symlink():
            raise FileExistsError(f"Workflow directory already exists: {self.root}")
        staged = self._stage_source(source_root)
        try:
            os.replace(staged, self.root)
        except BaseException:
            shutil.rmtree(staged, ignore_errors=True)
            raise
        return self.root

    @contextmanager
    def replace_from_source(self, source_root: Path) -> Iterator[Path]:
        """Replace this Workflow within a rollback boundary."""
        self._validate_root(self.root)
        staged = self._stage_source(source_root)
        backup = Path(tempfile.mkdtemp(
            prefix=f".{self.workflow_id}.backup.",
            dir=self.library_root(),
        ))
        backup.rmdir()
        try:
            os.replace(self.root, backup)
            try:
                os.replace(staged, self.root)
            except BaseException:
                os.replace(backup, self.root)
                raise
            try:
                yield self.root
            except BaseException:
                self.delete()
                os.replace(backup, self.root)
                raise
            else:
                shutil.rmtree(backup, ignore_errors=True)
        finally:
            shutil.rmtree(staged, ignore_errors=True)

    def delete(self) -> None:
        """Delete this canonical Workflow directory without following links."""
        try:
            relative = self.root.resolve(strict=False).relative_to(self.library_root())
        except (OSError, ValueError):
            return
        if not relative.parts or relative.parts != (self.workflow_id,):
            return
        if self.root.is_symlink() or self.root.is_file():
            self.root.unlink(missing_ok=True)
        elif self.root.is_dir():
            shutil.rmtree(self.root, ignore_errors=True)

    @contextmanager
    def stage_removal(self) -> Iterator[Optional[Path]]:
        """Move the canonical package aside and restore it if deletion fails."""
        canonical = self.managed(self.workflow_id).root
        if self.root != canonical:
            raise ValueError(
                f"Workflow package is outside its canonical library path: {self.root}"
            )
        if self.root.is_symlink() or (self.root.exists() and not self.root.is_dir()):
            raise ValueError(f"Workflow package is not a regular directory: {self.root}")
        if not self.root.exists():
            yield None
            return
        tombstone = Path(tempfile.mkdtemp(
            prefix=f".{self.workflow_id}.removing.",
            dir=self.library_root(),
        ))
        tombstone.rmdir()
        os.replace(self.root, tombstone)
        try:
            yield tombstone
        except BaseException:
            os.replace(tombstone, self.root)
            raise

    def discard_staged_removal(self, tombstone: Path) -> None:
        """Best-effort purge of a package already removed from the catalogue."""
        path = Path(tombstone)
        expected_prefix = f".{self.workflow_id}.removing."
        if path.parent != self.library_root() or not path.name.startswith(expected_prefix):
            raise ValueError(f"Invalid Workflow removal tombstone: {path}")
        shutil.rmtree(path, ignore_errors=True)

    def restore_source_to(self, target_root: Path) -> Path:
        """Restore saved Workflow documents and source into a prepared directory."""
        self._validate_root(self.root)
        target = Path(target_root).expanduser().resolve()
        if target.is_symlink() or not target.is_dir():
            raise FileNotFoundError(f"Workflow restore target is unavailable: {target}")
        restored: list[Path] = []
        try:
            for name in WorkflowPackage.ROOT_ENTRY_NAMES:
                source = self.root / name
                destination = target / name
                if destination.exists() or destination.is_symlink():
                    raise FileExistsError(f"Workflow restore target already exists: {destination}")
                if source.is_dir():
                    shutil.copytree(source, destination, symlinks=True)
                else:
                    shutil.copy2(source, destination)
                restored.append(destination)
        except BaseException:
            for path in reversed(restored):
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    path.unlink(missing_ok=True)
            raise
        return target

    def _stage_source(self, source_root: Path) -> Path:
        parent = self.library_root()
        parent.mkdir(parents=True, exist_ok=True)
        source = Path(source_root)
        if source.is_symlink() or not source.is_dir():
            raise FileNotFoundError(f"Workflow materialization source is unavailable: {source}")
        temporary = Path(tempfile.mkdtemp(
            prefix=f".{self.workflow_id}.",
            dir=parent,
        ))
        temporary.rmdir()

        def copy_entry(source_path: Path, target_path: Path) -> None:
            if source_path.is_symlink():
                target_path.symlink_to(
                    os.readlink(source_path),
                    target_is_directory=source_path.is_dir(),
                )
            elif source_path.is_dir():
                shutil.copytree(source_path, target_path, symlinks=True)
            else:
                shutil.copy2(source_path, target_path)

        try:
            temporary.mkdir()
            for name in WorkflowPackage.ROOT_ENTRY_NAMES:
                copy_entry(source / name, temporary / name)
            self._validate_root(temporary)
            return temporary
        except BaseException:
            shutil.rmtree(temporary, ignore_errors=True)
            raise

    @classmethod
    def _validate_root(cls, root: Path) -> None:
        if root.is_symlink() or not root.is_dir():
            raise FileNotFoundError(f"Workflow directory is unavailable: {root}")
        for name in WorkflowPackage.BUILD_DOCUMENT_NAMES:
            path = root / name
            if path.is_symlink() or not path.is_file():
                raise FileNotFoundError(f"Workflow document is unavailable: {name}")
            if not path.read_text(encoding="utf-8").strip():
                raise ValueError(f"Workflow document is empty: {name}")
        workflow_dir = root / "workflow"
        cls._validate_regular_tree(workflow_dir, "workflow")
        reason = WorkflowPackage(root).validation_reason()
        if reason:
            raise ValueError(reason)

    @classmethod
    def _validate_regular_tree(cls, root: Path, label: str) -> None:
        if root.is_symlink() or not root.is_dir():
            raise FileNotFoundError(f"{label} directory is unavailable")
        for child in root.iterdir():
            relative = child.relative_to(root).as_posix()
            if child.is_symlink():
                raise ValueError(f"{label}/{relative} is a symbolic link")
            if child.is_dir():
                cls._validate_regular_tree(child, f"{label}/{child.name}")
            elif not child.is_file():
                raise ValueError(f"{label}/{relative} is not a regular file")


class WorkflowLibrary:
    """Agent-facing catalogue and persistence adapter for saved Workflows.

    Parameters
    ----------
    user_id : str
        Owner used for every Workflow lookup and mutation.
    """

    def __init__(self, user_id: str) -> None:
        self._user_id = user_id
        self._repo = WorkflowRepository()
        self._packages: Dict[str, WorkflowPackage] = {}
        self.package: Optional[WorkflowPackage] = None

    @staticmethod
    def storage_root() -> Path:
        """Return the global directory containing saved Workflow packages."""
        return _SavedWorkflowStorage.library_root()

    async def load(self) -> "WorkflowLibrary":
        """Load every available saved Workflow owned by this user."""
        self.package = None
        rows = await self._repo.list_for_user(self._user_id)
        packages = [self._package_from_row(row) for row in rows if row.workflow_dir]
        self._packages = {
            package.workflow_id: package
            for package in packages
            if package.workflow_id is not None and package.is_available
        }
        return self

    def is_empty(self) -> bool:
        """Return whether the user has no saved Workflows."""
        return not self._packages

    def data(self) -> Dict[str, WorkflowPackage]:
        """Return loaded Workflows keyed by stable Workflow id."""
        return self._packages

    def get(self, workflow_id: str) -> Optional[WorkflowPackage]:
        """Return one loaded Workflow by its stable id."""
        return self._packages.get(workflow_id)

    def open_package(
        self,
        root: Path,
        *,
        workflow_id: Optional[str] = None,
        name: Optional[str] = None,
        validate: bool = False,
    ) -> WorkflowPackage:
        """Bind one Build or pinned Run package for the active cognitive mode."""
        self.package = None
        package = WorkflowPackage(
            Path(os.path.abspath(Path(root).expanduser())),
            workflow_id=workflow_id,
            name=name,
        )
        if validate:
            reason = package.validation_reason()
            if reason:
                raise ValueError(reason)
        self.package = package
        return package

    def require_package(self, root: Optional[Path] = None) -> WorkflowPackage:
        """Return the package bound for the active cognitive mode."""
        package = self.package
        if package is None:
            raise RuntimeError("No Workflow package is bound to the active cognitive mode.")
        expected = Path(os.path.abspath(Path(root).expanduser())) if root is not None else None
        if expected is not None and package.root != expected:
            raise RuntimeError("The bound Workflow package belongs to another workspace root.")
        return package

    def close_package(self) -> None:
        """Drop the active package binding without changing its files."""
        self.package = None

    async def delete(self, workflow_id: str) -> bool:
        """Delete one owned Workflow record and its canonical package."""
        async with self._repo.source_guard(self._user_id, workflow_id):
            row = await self._repo.get(self._user_id, workflow_id)
            if row is None:
                return False
            storage = _SavedWorkflowStorage(workflow_id, Path(row.workflow_dir))
            with storage.stage_removal() as tombstone:
                if not await self._repo.delete(self._user_id, workflow_id):
                    raise RuntimeError(
                        f"Workflow `{workflow_id}` disappeared during deletion"
                    )
            self._packages.pop(workflow_id, None)
            if tombstone is not None:
                await asyncio.to_thread(storage.discard_staged_removal, tombstone)
            return True

    async def import_workflow(
        self,
        source_root: Path,
        *,
        name: str,
        description: Optional[str],
        domain: Optional[str],
    ) -> WorkflowPackage:
        """Restore and persist one portable Workflow package.

        Parameters
        ----------
        source_root : Path
            Extracted portable artifact root.
        name : str
            User-visible name unique within this user's Workflow library.
        description : str, optional
            User-visible Workflow summary.
        domain : str, optional
            Optional Workflow domain.

        Returns
        -------
        WorkflowPackage
            Fully validated and persisted Workflow package.
        """
        requested_name = name.strip()
        if not requested_name:
            raise ValueError("Workflow name is required")
        if await self._repo.get_by_name(self._user_id, requested_name) is not None:
            raise WorkflowNameConflictError(requested_name)

        workflow_id = self._repo.new_id()
        storage = _SavedWorkflowStorage.managed(workflow_id)
        restore = asyncio.create_task(asyncio.to_thread(
            storage.create_from_source,
            source_root,
        ))
        try:
            await asyncio.shield(restore)
        except asyncio.CancelledError:
            try:
                await restore
            except BaseException:
                pass
            await asyncio.to_thread(storage.delete)
            raise
        except BaseException:
            await asyncio.to_thread(storage.delete)
            raise

        persist = asyncio.create_task(self._repo.create(
            self._user_id,
            workflow_id=workflow_id,
            name=requested_name,
            description=description,
            domain=domain,
            workflow_dir=str(storage.root),
        ))
        try:
            row = await asyncio.shield(persist)
        except asyncio.CancelledError:
            try:
                await persist
            except BaseException:
                await asyncio.to_thread(storage.delete)
            raise
        except BaseException:
            await asyncio.to_thread(storage.delete)
            raise

        package = self._package_from_row(row)
        self._remember_package(package)
        return package

    async def prepare_edit(self, workflow_id: str) -> WorkflowPackage:
        """Return an editable Workflow after validating its saved source."""
        package = self.source(workflow_id)
        if not _SavedWorkflowStorage(workflow_id, package.root).is_available:
            raise ValueError(f"Workflow `{workflow_id}` has no reusable source package")
        return package

    async def restore_source(self, package: WorkflowPackage, target_root: Path) -> Path:
        """Restore one guarded saved Workflow into a prepared Build directory."""
        if package.workflow_id is None:
            raise ValueError("Only a saved Workflow package can be restored")
        storage = _SavedWorkflowStorage(package.workflow_id, package.root)
        return await asyncio.to_thread(storage.restore_source_to, target_root)

    async def find_materialized_workflow(self, source_turn_id: str) -> Optional[WorkflowPackage]:
        """Return the Workflow already saved by one confirmation Turn."""
        row = await self._repo.get_by_source_turn(self._user_id, source_turn_id)
        if row is None:
            return None
        package = self._package_from_row(row)
        if not package.is_available:
            raise ValueError("The previously saved Workflow is unavailable")
        self._remember_package(package)
        return package

    async def materialize_workflow(
        self,
        source_root: Path,
        *,
        workflow_id: Optional[str],
        source_session_id: str,
        source_turn_id: str,
        name: str,
        description: Optional[str],
    ) -> WorkflowPackage:
        """Validate an exported Build source and persist it as a Workflow."""
        if not source_session_id.strip() or not source_turn_id.strip():
            raise ValueError("Workflow confirmation requires its Session and Turn ids")
        requested_name = name.strip()
        if workflow_id is None and not requested_name:
            raise ValueError("Workflow name is required")

        if workflow_id is not None:
            current = await self._repo.get(self._user_id, workflow_id)
            if current is None:
                raise ValueError("The Workflow selected for editing is no longer available")
            storage = _SavedWorkflowStorage(workflow_id, Path(current.workflow_dir))
            async with self._repo.source_guard(self._user_id, workflow_id):
                with storage.replace_from_source(source_root) as workflow_dir:
                    row = await self._repo.update_content(
                        self._user_id,
                        workflow_id,
                        workflow_dir=str(workflow_dir),
                        description=description,
                        session_id=source_session_id,
                    )
                    if row is None:
                        raise ValueError("The Workflow selected for editing is no longer available")
            package = self._package_from_row(row)
            self._remember_package(package)
            return package

        existing = await self.find_materialized_workflow(source_turn_id)
        if existing is not None:
            return existing
        if await self._repo.get_by_name(self._user_id, requested_name) is not None:
            raise WorkflowNameConflictError(requested_name)

        workflow_id = self._repo.new_id()
        storage = _SavedWorkflowStorage.managed(workflow_id)
        materialize = asyncio.create_task(
            asyncio.to_thread(storage.create_from_source, source_root)
        )
        try:
            await asyncio.shield(materialize)
        except asyncio.CancelledError:
            try:
                await materialize
            except BaseException:
                pass
            await asyncio.to_thread(storage.delete)
            raise
        except BaseException:
            await asyncio.to_thread(storage.delete)
            raise

        persist = asyncio.create_task(self._repo.create_from_turn(
            self._user_id,
            workflow_id=workflow_id,
            workflow_dir=str(storage.root),
            source_session_id=source_session_id,
            source_turn_id=source_turn_id,
            name=requested_name,
            description=description,
            domain=None,
        ))
        try:
            row, created = await asyncio.shield(persist)
        except asyncio.CancelledError:
            try:
                _, created = await persist
            except BaseException:
                await asyncio.to_thread(storage.delete)
            else:
                if not created:
                    await asyncio.to_thread(storage.delete)
            raise
        except BaseException:
            await asyncio.to_thread(storage.delete)
            raise
        if not created:
            await asyncio.to_thread(storage.delete)
        package = self._package_from_row(row)
        self._remember_package(package)
        return package

    @asynccontextmanager
    async def guarded_source(self, workflow_id: str) -> AsyncIterator[WorkflowPackage]:
        """Yield one durable Workflow while source mutation is excluded."""
        async with self._repo.source_guard(self._user_id, workflow_id):
            yield await self._validated_saved_workflow(workflow_id)

    async def associate_session(self, session_id: str, workflow_id: str) -> bool:
        """Associate one loaded Workflow with the Session using it."""
        return workflow_id in self._packages and await self._repo.associate(
            self._user_id, session_id, workflow_id,
        )

    async def associate_session_input(self, session_id: str, user_input: object) -> Tuple[str, ...]:
        """Associate saved Workflows referenced directly by one Session input."""
        workflow_ids = []
        for block in UserInput.from_runtime(user_input).blocks:
            block_type = block.get("type")
            reference_id = str(block.get("id") or "").strip()
            if not reference_id:
                continue
            if block_type == "slash" and block.get("resource") == "workflow":
                workflow_ids.append(reference_id)
                continue
            if (
                block_type == "mention"
                and block.get("group") in {"Workflow", "Workflows", "WorkflowEntity"}
            ):
                workflow_ids.append(reference_id)

        associated = []
        for workflow_id in dict.fromkeys(workflow_ids):
            if await self.associate_session(session_id, workflow_id):
                associated.append(workflow_id)
        return tuple(associated)

    def source(self, workflow_id: str) -> WorkflowPackage:
        """Load and validate one Workflow's executable source."""
        package = self.get(workflow_id)
        if package is None or not package.is_available:
            raise ValueError(f"Workflow `{workflow_id}` is unavailable")
        reason = package.validation_reason()
        if reason:
            raise ValueError(reason)
        return package

    async def _validated_saved_workflow(self, workflow_id: str) -> WorkflowPackage:
        package = self.source(workflow_id)
        durable = await self._repo.get(self._user_id, workflow_id)
        storage = _SavedWorkflowStorage(workflow_id, package.root)
        if (
            durable is None
            or Path(durable.workflow_dir) != package.root
            or not storage.is_available
        ):
            raise ValueError(f"Workflow `{workflow_id}` is unavailable")
        return package

    @staticmethod
    def _package_from_row(row: WorkflowRecord) -> WorkflowPackage:
        return WorkflowPackage(
            root=Path(row.workflow_dir),
            workflow_id=row.id,
            name=row.name,
            description=row.description,
            domain=row.domain,
            source_session_id=row.source_session_id,
            source_turn_id=row.source_turn_id,
        )

    def _remember_package(self, package: WorkflowPackage) -> None:
        if package.workflow_id is None:
            raise ValueError("A saved Workflow package requires a stable id")
        self._packages[package.workflow_id] = package


__all__ = [
    "WorkflowLibrary",
    "WorkflowPackage",
]
