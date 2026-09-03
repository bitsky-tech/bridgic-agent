"""Shared validation and wire helpers for local image message inputs."""

from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple


IMAGE_INPUTS_EXTRA = "image_inputs"
MAX_IMAGE_INPUTS = 10
MAX_IMAGE_INPUT_BYTES = 32 * 1024 * 1024
MAX_IMAGE_INPUT_TOTAL_BYTES = MAX_IMAGE_INPUT_BYTES
MAX_REUSABLE_IMAGE_BYTES = MAX_IMAGE_INPUT_BYTES

_IMAGE_EXTENSIONS = frozenset({
    ".avif",
    ".gif",
    ".heic",
    ".heif",
    ".jfif",
    ".jpeg",
    ".jpg",
    ".png",
    ".svg",
    ".webp",
})


class ImageInputError(ValueError):
    """Base class for image inputs that cannot be sent safely."""


class ImageInputUnsupportedError(ImageInputError):
    """The selected model is known not to accept image input."""

    def __init__(self, model_id: str = "", message: str = "") -> None:
        self.model_id = model_id
        super().__init__(
            message or f"Model {model_id or '(unknown)'} does not support image input"
        )


class ImageInputValidationError(ImageInputError):
    """A referenced image is missing, unsupported, invalid, or too large."""


def _media_type(data: bytes) -> Optional[str]:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def inspect_image_input(path: str, name: str = "", *, max_bytes: int = MAX_IMAGE_INPUT_BYTES) -> Optional[Dict[str, Any]]:
    """Return one lightweight descriptor when ``path`` is a supported image.

    Magic bytes, rather than the filename or uploaded MIME value, decide whether
    a file becomes model-visible image content. Image-looking filenames fail
    explicitly when their bytes are unavailable or unsupported; ordinary files
    remain ordinary file mentions. User messages and image tools share the same
    32 MB per-image ceiling.
    """
    if max_bytes <= 0 or max_bytes > MAX_REUSABLE_IMAGE_BYTES:
        raise ValueError(
            f"max_bytes must be between 1 and {MAX_REUSABLE_IMAGE_BYTES}"
        )
    resolved = os.path.realpath(os.path.abspath(path))
    suffix = Path(resolved).suffix.casefold()
    image_looking = suffix in _IMAGE_EXTENSIONS
    try:
        if not os.path.isfile(resolved):
            if image_looking:
                raise ImageInputValidationError(f"Image file is unavailable: {resolved}")
            return None
        size_bytes = os.path.getsize(resolved)
        with open(resolved, "rb") as stream:
            header = stream.read(16)
    except ImageInputValidationError:
        raise
    except OSError as exc:
        if image_looking:
            raise ImageInputValidationError(f"Image file cannot be read: {resolved}") from exc
        return None

    media_type = _media_type(header)
    if media_type is None:
        if image_looking:
            raise ImageInputValidationError(f"Unsupported or invalid image: {resolved}")
        return None
    if size_bytes <= 0:
        raise ImageInputValidationError(f"Image file is empty: {resolved}")
    if size_bytes > max_bytes:
        raise ImageInputValidationError(
            f"Image exceeds {max_bytes} bytes: {resolved}"
        )
    descriptor = {
        "path": resolved,
        "media_type": media_type,
        "size_bytes": size_bytes,
        "name": name or Path(resolved).name,
    }
    if max_bytes != MAX_IMAGE_INPUT_BYTES:
        descriptor["max_bytes"] = max_bytes
    return descriptor


def validate_image_inputs(inputs: Iterable[Mapping[str, Any]], *, max_total_bytes: int = MAX_IMAGE_INPUT_TOTAL_BYTES) -> List[Dict[str, Any]]:
    """Bound one message's image count and total encoded source size.

    User messages and image tools share the same 32 MB aggregate ceiling.
    """
    if max_total_bytes <= 0 or max_total_bytes > MAX_REUSABLE_IMAGE_BYTES:
        raise ValueError(
            f"max_total_bytes must be between 1 and {MAX_REUSABLE_IMAGE_BYTES}"
        )
    normalized = [dict(item) for item in inputs]
    if len(normalized) > MAX_IMAGE_INPUTS:
        raise ImageInputValidationError(
            f"A message can contain at most {MAX_IMAGE_INPUTS} images"
        )
    total = sum(max(0, int(item.get("size_bytes") or 0)) for item in normalized)
    if total > max_total_bytes:
        raise ImageInputValidationError(
            f"Image inputs exceed {max_total_bytes} total bytes"
        )
    return normalized


def image_inputs_of(message: Any) -> List[Dict[str, Any]]:
    """Read normalized image descriptors from a Bridgic Message."""
    values = (getattr(message, "extras", None) or {}).get(IMAGE_INPUTS_EXTRA) or []
    return [dict(value) for value in values if isinstance(value, Mapping)]


def read_image_input(image: Mapping[str, Any]) -> Tuple[bytes, str]:
    """Re-read and revalidate an image immediately before provider encoding."""
    path = str(image.get("path") or "")
    expected_type = str(image.get("media_type") or "")
    expected_size = int(image.get("size_bytes") or 0)
    max_bytes = int(image.get("max_bytes") or MAX_IMAGE_INPUT_BYTES)
    inspected = inspect_image_input(
        path,
        str(image.get("name") or ""),
        max_bytes=max_bytes,
    )
    if (
        inspected is None
        or inspected["media_type"] != expected_type
        or inspected["size_bytes"] != expected_size
    ):
        raise ImageInputValidationError(f"Image changed before it could be sent: {path}")
    try:
        data = Path(inspected["path"]).read_bytes()
    except OSError as exc:
        raise ImageInputValidationError(f"Image file cannot be read: {path}") from exc
    return data, str(inspected["media_type"])


def image_data_url(image: Mapping[str, Any]) -> str:
    """Encode one validated local image for OpenAI-family wire protocols."""
    data, media_type = read_image_input(image)
    return f"data:{media_type};base64,{base64.b64encode(data).decode('ascii')}"


__all__ = [
    "IMAGE_INPUTS_EXTRA",
    "ImageInputError",
    "ImageInputUnsupportedError",
    "ImageInputValidationError",
    "MAX_IMAGE_INPUT_BYTES",
    "MAX_IMAGE_INPUTS",
    "MAX_REUSABLE_IMAGE_BYTES",
    "image_data_url",
    "image_inputs_of",
    "inspect_image_input",
    "read_image_input",
    "validate_image_inputs",
]
