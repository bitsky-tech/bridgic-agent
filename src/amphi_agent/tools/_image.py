from __future__ import annotations

import base64
import binascii
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

import httpx
from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec
from google import genai
from google.genai import types

from ...amphi_service.protocol.llms import (
    PROVIDER_CATALOG_BY_ID,
    supports_image_generation,
)
from ...amphi_store import ProviderCredential, ProviderRepository


_IMAGE_TIMEOUT = httpx.Timeout(180.0, connect=10.0)
_MAX_IMAGE_BYTES = 32 * 1024 * 1024
_MAX_ENCODED_IMAGE_LENGTH = ((_MAX_IMAGE_BYTES + 2) // 3) * 4 + 16
_SUPPORTED_PROTOCOLS = frozenset({"openai", "google"})


@dataclass(frozen=True)
class _ImageTarget:
    credential: ProviderCredential
    model: str


def _ordered_credentials(credentials: Iterable[ProviderCredential]) -> list[ProviderCredential]:
    rows = list(credentials)
    return [row for row in rows if row.is_active] + [row for row in rows if not row.is_active]


def _is_supported_target(credential: ProviderCredential, model: str) -> bool:
    protocol_supported = (
        credential.provider_id == "openrouter"
        or credential.protocol in _SUPPORTED_PROTOCOLS
    )
    return protocol_supported and supports_image_generation(credential.provider_id, model)


def _select_target(credentials: Iterable[ProviderCredential], provider_id: str, model: str) -> _ImageTarget:
    rows = _ordered_credentials(credentials)
    requested_provider = provider_id.strip()
    requested_model = model.strip()

    if requested_provider:
        credential = next((row for row in rows if row.provider_id == requested_provider), None)
        if credential is None:
            raise ValueError(f"provider {requested_provider!r} is not configured")
        if not credential.is_enabled:
            raise ValueError(f"provider {requested_provider!r} is disabled")
        if not credential.api_key:
            raise ValueError(
                f"provider {requested_provider!r} needs an API key for image generation"
            )
        if requested_model and requested_model not in credential.enabled_models:
            raise ValueError(
                f"model {requested_model!r} is not enabled for provider {requested_provider!r}"
            )
        candidates = [requested_model] if requested_model else credential.enabled_models
        selected = next(
            (candidate for candidate in candidates if _is_supported_target(credential, candidate)),
            None,
        )
        if selected is None:
            detail = f"model {requested_model!r}" if requested_model else "its enabled models"
            raise ValueError(
                f"provider {requested_provider!r} does not expose {detail} as text-to-image capable"
            )
        return _ImageTarget(credential, selected)

    for credential in rows:
        if not credential.is_enabled or not credential.api_key:
            continue
        if requested_model and requested_model not in credential.enabled_models:
            continue
        candidates = [requested_model] if requested_model else credential.enabled_models
        selected = next(
            (candidate for candidate in candidates if _is_supported_target(credential, candidate)),
            None,
        )
        if selected is not None:
            return _ImageTarget(credential, selected)

    if requested_model:
        raise ValueError(
            f"no enabled provider has text-to-image model {requested_model!r} with an API key"
        )
    raise ValueError(
        "no enabled text-to-image model with an API key is configured; "
        "enable an image-output model under OpenAI, Google, or OpenRouter first"
    )


def _default_base_url(provider_id: str) -> Optional[str]:
    provider = PROVIDER_CATALOG_BY_ID.get(provider_id)
    if not isinstance(provider, dict):
        return None
    value = provider.get("default_base_url")
    return value if isinstance(value, str) and value.strip() else None


def _normalized_base_url(credential: ProviderCredential) -> str:
    base_url = (credential.base_url or _default_base_url(credential.provider_id) or "").strip()
    if not base_url:
        raise ValueError(f"provider {credential.provider_id!r} has no base URL")
    base_url = base_url.rstrip("/")
    for suffix in ("/chat/completions", "/responses", "/images/generations", "/images"):
        if base_url.endswith(suffix):
            base_url = base_url[: -len(suffix)]
            break
    return base_url


def _decode_base64_image(value: Any) -> bytes:
    if not isinstance(value, str) or not value:
        raise RuntimeError("the image provider returned no base64 image data")
    if len(value) > _MAX_ENCODED_IMAGE_LENGTH:
        raise RuntimeError("the generated image exceeds the 32 MB size limit")
    try:
        image = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise RuntimeError("the image provider returned invalid base64 image data") from exc
    return image


def _raster_extension(image: bytes) -> str:
    if not image:
        raise RuntimeError("the image provider returned an empty image")
    if len(image) > _MAX_IMAGE_BYTES:
        raise RuntimeError("the generated image exceeds the 32 MB size limit")
    if image.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if image.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if len(image) >= 12 and image.startswith(b"RIFF") and image[8:12] == b"WEBP":
        return "webp"
    if image.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    raise RuntimeError("the image provider returned an unsupported or invalid raster image")


def _response_error(response: httpx.Response) -> str:
    message = ""
    try:
        payload = response.json()
        error = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(error, dict):
            message = str(error.get("message") or error.get("code") or "")
        elif error:
            message = str(error)
    except ValueError:
        pass
    suffix = f": {message[:500]}" if message else ""
    return f"image provider returned HTTP {response.status_code}{suffix}"


async def _request_http_image(target: _ImageTarget, prompt: str) -> tuple[bytes, Optional[str]]:
    credential = target.credential
    base_url = _normalized_base_url(credential)
    endpoint = (
        f"{base_url}/images"
        if credential.provider_id == "openrouter"
        else f"{base_url}/images/generations"
    )
    headers = {
        "Authorization": f"Bearer {credential.api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=_IMAGE_TIMEOUT) as client:
        response = await client.post(
            endpoint,
            headers=headers,
            json={"model": target.model, "prompt": prompt},
        )
    if response.status_code >= 400:
        raise RuntimeError(_response_error(response))
    content_length = response.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > _MAX_ENCODED_IMAGE_LENGTH:
        raise RuntimeError("the image provider response exceeds the 32 MB image limit")
    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError("the image provider returned invalid JSON") from exc
    items = payload.get("data") if isinstance(payload, dict) else None
    item = items[0] if isinstance(items, list) and items else None
    if not isinstance(item, dict):
        raise RuntimeError("the image provider returned no image")
    if not item.get("b64_json") and item.get("url"):
        raise RuntimeError(
            "the image provider returned only a remote URL; configure a model that returns image bytes"
        )
    return _decode_base64_image(item.get("b64_json")), item.get("media_type")


async def _request_google_image(target: _ImageTarget, prompt: str) -> tuple[bytes, Optional[str]]:
    credential = target.credential
    configured_base = (credential.base_url or "").strip() or None
    default_base = (_default_base_url(credential.provider_id) or "").rstrip("/")
    if configured_base and configured_base.rstrip("/") == default_base:
        configured_base = None
    http_options = types.HttpOptions(base_url=configured_base) if configured_base else None
    client = genai.Client(api_key=credential.api_key, http_options=http_options)
    async_client = client.aio
    try:
        response = await async_client.models.generate_content(
            model=target.model,
            contents=prompt,
            config=types.GenerateContentConfig(response_modalities=["IMAGE"]),
        )
    finally:
        await async_client.aclose()

    candidates = getattr(response, "candidates", None) or []
    content = getattr(candidates[0], "content", None) if candidates else None
    parts = getattr(content, "parts", None) or []
    for part in parts:
        inline_data = getattr(part, "inline_data", None)
        data = getattr(inline_data, "data", None) if inline_data is not None else None
        if isinstance(data, bytes) and data:
            return data, getattr(inline_data, "mime_type", None)
        if isinstance(data, str) and data:
            return _decode_base64_image(data), getattr(inline_data, "mime_type", None)
    raise RuntimeError("Google returned no image data")


async def _request_image(target: _ImageTarget, prompt: str) -> tuple[bytes, Optional[str]]:
    if target.credential.protocol == "google":
        return await _request_google_image(target, prompt)
    return await _request_http_image(target, prompt)


async def generate_image(prompt: str, provider_id: str = "", model: str = "") -> str:
    """Generate one image with a configured text-to-image model and display its file.

    Use this tool when the user asks to create or render a new image from a text
    description. The tool automatically prefers the active configured provider,
    then the first enabled text-to-image model. Pass ``provider_id`` or ``model``
    only when the user explicitly requests a configured provider or model.

    The generated raster image is saved under the current Session workspace.
    The returned absolute path occupies its own line so the desktop client can
    render the image with its existing local-file preview.

    Args:
        prompt: Detailed text description of the image to generate.
        provider_id: Optional configured provider id, such as ``openai``,
            ``google``, or ``openrouter``. Leave empty for automatic selection.
        model: Optional exact enabled image model id. Leave empty for automatic
            selection.

    Returns:
        A short generation summary followed by the generated image's absolute
        local path on its own line.
    """
    cleaned_prompt = prompt.strip()
    if not cleaned_prompt:
        raise ValueError("prompt is required")
    if len(cleaned_prompt) > 32_000:
        raise ValueError("prompt must be at most 32000 characters")

    agent = current_agent.get(None)
    context = getattr(agent, "ctx", None) if agent is not None else None
    session = getattr(context, "session", None) if context is not None else None
    workspace = getattr(context, "workspace", None) if context is not None else None
    user_id = getattr(session, "user_id", None) if session is not None else None
    work_dir = getattr(workspace, "work_dir", None) if workspace is not None else None
    if not user_id or work_dir is None:
        raise RuntimeError("generate_image requires an active Session workspace")

    credentials = await ProviderRepository().list_for_user(user_id)
    target = _select_target(credentials, provider_id, model)
    try:
        image, _mime_type = await _request_image(target, cleaned_prompt)
        extension = _raster_extension(image)
    except Exception as exc:
        message = str(exc)
        if target.credential.api_key:
            message = message.replace(target.credential.api_key, "[redacted]")
        raise RuntimeError(
            f"image generation with {target.credential.provider_id}/{target.model} failed: {message}"
        ) from None

    workspace_root = Path(work_dir).resolve()
    output_dir = workspace_root / "generated-images"
    output_dir.mkdir(parents=True, exist_ok=True)
    if not output_dir.resolve().is_relative_to(workspace_root):
        raise RuntimeError("generated image directory escapes the Session workspace")
    output_path = output_dir / f"generated-{uuid.uuid4().hex}.{extension}"
    output_path.write_bytes(image)
    resolved_path = output_path.resolve()
    return (
        f"Generated one image with {target.credential.provider_id}/{target.model}.\n"
        f"{resolved_path}"
    )


generate_image_tool: FunctionToolSpec = FunctionToolSpec.from_raw(generate_image)

__all__ = ["generate_image", "generate_image_tool"]
