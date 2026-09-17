import hashlib
import json
import shutil
from pathlib import Path

from filelock import FileLock

OFFICE_EXTENSIONS = {".docx", ".xlsx", ".pptx"}


def import_office_file(workspace_root: str, source: Path, filename: str | None = None) -> Path:
    """Bind an Office import to one managed file, retaining its original bytes."""
    if not workspace_root:
        raise ValueError("The Session workspace is unavailable")
    source = source.resolve(strict=True)
    name = Path(filename).name if filename else source.name
    display = Path(name)
    root = Path(workspace_root).resolve()
    work = root / ".work"
    work.mkdir(parents=True, exist_ok=True)
    internal = root / ".internal" / "office"
    internal.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(str(source).encode()).hexdigest()
    record = internal / f"{key}.json"
    with FileLock(str(internal / "imports.lock")):
        if source.is_relative_to(work.resolve()):
            target = source
        else:
            target = None
            if record.exists():
                candidate = (work / json.loads(record.read_text())["name"]).resolve()
                if candidate.is_relative_to(work.resolve()) and candidate.is_file():
                    target = candidate
            if target is None:
                target = work / name
                ordinal = 2
                while target.exists():
                    target = work / f"{display.stem} ({ordinal}){display.suffix}"
                    ordinal += 1
                shutil.copyfile(source, target)
                record.write_text(json.dumps({"name": target.name}))
        original_key = hashlib.sha256(str(target).encode()).hexdigest()
        original = internal / "originals" / original_key / target.name
        if not original.exists():
            original.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, original)
        return target
