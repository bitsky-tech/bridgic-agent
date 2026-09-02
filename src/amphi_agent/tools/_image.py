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
from bridgic.core.model.types import Message, Role
from google import genai
from google.genai import types

from ...amphi_service.protocol.llms import (
    PROVIDER_CATALOG_BY_ID,
    catalog_model,
    supports_image_generation,
)
from ...amphi_service.protocol.llms._image_inputs import (
    IMAGE_INPUTS_EXTRA,
    ImageInputUnsupportedError,
    ImageInputValidationError,
    MAX_REUSABLE_IMAGE_BYTES,
    image_data_url,
    inspect_image_input,
    read_image_input,
    validate_image_inputs,
)
from ...amphi_store import ProviderCredential, ProviderRepository


_IMAGE_TIMEOUT = httpx.Timeout(180.0, connect=10.0)
_MAX_IMAGE_BYTES = MAX_REUSABLE_IMAGE_BYTES
_MAX_ENCODED_IMAGE_LENGTH = ((_MAX_IMAGE_BYTES + 2) // 3) * 4 + 16
_SUPPORTED_PROTOCOLS = frozenset({"openai", "google"})
_MAX_IMAGE_ANALYSIS_PROMPT_LENGTH = 32_000
_DEFAULT_IMAGE_ANALYSIS_PROMPT = (
    "Describe the visible image accurately. Cover the subject, composition, perspective, "
    "lighting, color palette, materials, style, and any readable text. Separate direct "
    "observations from uncertainty, and include the concrete visual details another image "
    "model would need to create a similar result."
)
_IMAGE_ANALYSIS_SYSTEM_PROMPT = (
    "You are a visual inspection component. Analyze only what is visible in the supplied "
    "image and answer the user's inspection request. Do not claim hidden identity, intent, "
    "provenance, or exact attributes that cannot be established from pixels. Return concise "
    "plain text that a parent agent can use for later reasoning or image generation."
)


@dataclass(frozen=True)
class _ImageTarget:
    credential: ProviderCredential
    model: str


def _ordered_credentials(credentials: Iterable[ProviderCredential]) -> list[ProviderCredential]:
    rows = list(credentials)
    return [row for row in rows if row.is_active] + [row for row in rows if not row.is_active]


def _supports_reference_generation(provider_id: str, model_id: str) -> bool:
    model = catalog_model(provider_id, model_id)
    return bool(
        model is not None
        and "text" in model["input_modalities"]
        and "image" in model["input_modalities"]
        and "image" in model["output_modalities"]
    )


def _is_supported_target(credential: ProviderCredential, model: str, require_reference: bool = False) -> bool:
    protocol_supported = (
        credential.provider_id == "openrouter"
        or credential.protocol in _SUPPORTED_PROTOCOLS
    )
    model_supported = (
        _supports_reference_generation(credential.provider_id, model)
        if require_reference
        else supports_image_generation(credential.provider_id, model)
    )
    return protocol_supported and model_supported


def _select_target(credentials: Iterable[ProviderCredential], provider_id: str, model: str, require_reference: bool = False) -> _ImageTarget:
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
            (
                candidate
                for candidate in candidates
                if _is_supported_target(credential, candidate, require_reference)
            ),
            None,
        )
        if selected is None:
            detail = f"model {requested_model!r}" if requested_model else "its enabled models"
            capability = "image-to-image" if require_reference else "text-to-image"
            raise ValueError(
                f"provider {requested_provider!r} does not expose {detail} as {capability} capable"
            )
        return _ImageTarget(credential, selected)

    for credential in rows:
        if not credential.is_enabled or not credential.api_key:
            continue
        if requested_model and requested_model not in credential.enabled_models:
            continue
        candidates = [requested_model] if requested_model else credential.enabled_models
        selected = next(
            (
                candidate
                for candidate in candidates
                if _is_supported_target(credential, candidate, require_reference)
            ),
            None,
        )
        if selected is not None:
            return _ImageTarget(credential, selected)

    if requested_model:
        capability = "image-to-image" if require_reference else "text-to-image"
        raise ValueError(
            f"no enabled provider has {capability} model {requested_model!r} with an API key"
        )
    if require_reference:
        raise ValueError(
            "no enabled image-to-image model with an API key is configured; enable an "
            "image model that supports both image input and image output first"
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


async def _request_http_image(target: _ImageTarget, prompt: str, reference: Optional[dict] = None) -> tuple[bytes, Optional[str]]:
    credential = target.credential
    base_url = _normalized_base_url(credential)
    is_openrouter = credential.provider_id == "openrouter"
    endpoint = f"{base_url}/images" if is_openrouter else f"{base_url}/images/generations"
    headers = {"Authorization": f"Bearer {credential.api_key}"}
    request: dict[str, Any]
    if reference is not None and is_openrouter:
        headers["Content-Type"] = "application/json"
        request = {
            "json": {
                "model": target.model,
                "prompt": prompt,
                "input_references": [{
                    "type": "image_url",
                    "image_url": {"url": image_data_url(reference)},
                }],
            }
        }
    elif reference is not None:
        image, media_type = read_image_input(reference)
        endpoint = f"{base_url}/images/edits"
        request = {
            "data": {"model": target.model, "prompt": prompt},
            "files": {
                "image": (
                    str(reference.get("name") or "reference-image"),
                    image,
                    media_type,
                ),
            },
        }
    else:
        headers["Content-Type"] = "application/json"
        request = {"json": {"model": target.model, "prompt": prompt}}
    async with httpx.AsyncClient(timeout=_IMAGE_TIMEOUT) as client:
        response = await client.post(endpoint, headers=headers, **request)
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


async def _request_google_image(target: _ImageTarget, prompt: str, reference: Optional[dict] = None) -> tuple[bytes, Optional[str]]:
    credential = target.credential
    configured_base = (credential.base_url or "").strip() or None
    default_base = (_default_base_url(credential.provider_id) or "").rstrip("/")
    if configured_base and configured_base.rstrip("/") == default_base:
        configured_base = None
    http_options = types.HttpOptions(base_url=configured_base) if configured_base else None
    client = genai.Client(api_key=credential.api_key, http_options=http_options)
    async_client = client.aio
    contents: Any = prompt
    if reference is not None:
        image, media_type = read_image_input(reference)
        contents = [prompt, types.Part.from_bytes(data=image, mime_type=media_type)]
    try:
        response = await async_client.models.generate_content(
            model=target.model,
            contents=contents,
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


async def _request_image(target: _ImageTarget, prompt: str, reference: Optional[dict] = None) -> tuple[bytes, Optional[str]]:
    if target.credential.protocol == "google":
        return await _request_google_image(target, prompt, reference)
    return await _request_http_image(target, prompt, reference)


def _inspect_session_image(file_path: str, work_dir: Any, argument_name: str = "file_path") -> dict:
    cleaned_path = file_path.strip()
    if not cleaned_path:
        raise ValueError(f"{argument_name} is required")
    candidate = Path(cleaned_path)
    resolved_path = (
        candidate.resolve()
        if candidate.is_absolute()
        else (Path(work_dir).resolve() / candidate).resolve()
    )
    image = inspect_image_input(
        str(resolved_path),
        resolved_path.name,
        max_bytes=_MAX_IMAGE_BYTES,
    )
    if image is None:
        raise ImageInputValidationError(f"File is not a supported image: {resolved_path}")
    return validate_image_inputs([image], max_total_bytes=_MAX_IMAGE_BYTES)[0]


async def read_image(file_path: str, prompt: str = "") -> str:
    """Inspect one local image with the current vision-capable model.

    Use this tool when visual details in a local or generated image must be
    understood, compared, checked, or converted into a generation-ready
    description. Relative paths resolve from the current Session workspace;
    absolute paths returned by ``generate_image`` can be passed directly.

    The image is sent to the current model as native image input. The tool
    returns the model's textual visual analysis, not the image pixels. For later
    generation, use this analysis to refine the prompt and also pass the same
    path through ``generate_image.reference_image_path`` so the image model
    receives the source pixels directly.

    Args:
        file_path: Workspace-relative or absolute path to a PNG, JPEG, GIF, or
            WebP image no larger than the supported image-input limit.
        prompt: Optional question or inspection focus. Leave empty for a broad,
            generation-ready visual description.

    Returns:
        Textual analysis of the supplied image, including its resolved path.
    """
    cleaned_prompt = prompt.strip() or _DEFAULT_IMAGE_ANALYSIS_PROMPT
    if len(cleaned_prompt) > _MAX_IMAGE_ANALYSIS_PROMPT_LENGTH:
        raise ValueError("prompt must be at most 32000 characters")

    agent = current_agent.get(None)
    context = getattr(agent, "ctx", None) if agent is not None else None
    workspace = getattr(context, "workspace", None) if context is not None else None
    work_dir = getattr(workspace, "work_dir", None) if workspace is not None else None
    llm = getattr(agent, "_llm", None) if agent is not None else None
    if work_dir is None or llm is None:
        raise RuntimeError("read_image requires an active Session workspace and LLM")

    llm_provider = getattr(context, "llm_provider", None)
    support = (
        llm_provider.supports_image_input()
        if llm_provider is not None
        else None
    )
    if support is False:
        raise ImageInputUnsupportedError(str(getattr(llm_provider, "model_id", "") or ""))

    image = _inspect_session_image(file_path, work_dir)
    resolved_path = str(image["path"])

    response = await llm.achat([
        Message.from_text(_IMAGE_ANALYSIS_SYSTEM_PROMPT, role=Role.SYSTEM),
        Message.from_text(
            cleaned_prompt,
            role=Role.USER,
            extras={IMAGE_INPUTS_EXTRA: [image]},
        ),
    ])

    def response_text() -> str:
        if isinstance(response, str):
            return response.strip()
        message = getattr(response, "message", None)
        blocks = getattr(message, "blocks", None) or []
        return "".join(
            str(block.text)
            for block in blocks
            if getattr(block, "block_type", None) == "text"
            and getattr(block, "text", None)
        ).strip()

    analysis = response_text()
    if not analysis:
        raise RuntimeError("the vision model returned no image analysis")
    return f"Image analysis for {resolved_path}:\n{analysis}"


async def generate_image(prompt: str, provider_id: str = "", model: str = "", reference_image_path: str = "") -> str:
    """Generate or edit one image and display its file.

    Use this tool when the user asks to create a new image from text or create
    one that directly references an existing local image. Pass
    ``reference_image_path`` when preserving or transforming the source image's
    subject, composition, pose, style, or other visual traits matters; the source
    pixels are then sent to an image-to-image capable model. Do not replace this
    direct reference with a ``read_image`` text summary unless the source file is
    unavailable.

    A current Codex subscription model is allowed to use its hosted Responses
    image-generation or image-editing tool. Otherwise the tool automatically
    prefers the active configured provider, then the first enabled model with
    the required output and input modalities. Pass ``provider_id`` or ``model``
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
        reference_image_path: Optional workspace-relative or absolute path to a
            reference image. Leave empty for text-only generation.

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
    reference = (
        _inspect_session_image(reference_image_path, work_dir, "reference_image_path")
        if reference_image_path.strip()
        else None
    )

    requested_provider = provider_id.strip()
    requested_model = model.strip()
    current_llm = getattr(agent, "_llm", None)
    current_protocol = getattr(current_llm, "protocol", "")
    configuration = getattr(current_llm, "configuration", None)
    current_model = str(getattr(configuration, "model", "") or "")
    use_codex = (
        current_protocol == "openai-codex"
        and callable(getattr(current_llm, "agenerate_image", None))
        and requested_provider in {"", "openai-codex"}
        and requested_model in {"", current_model}
        and (
            reference is None
            or context.llm_provider.supports_image_input() is not False
        )
    )

    image: bytes
    source: str
    codex_error: Optional[Exception] = None
    if use_codex:
        try:
            encoded = await current_llm.agenerate_image(cleaned_prompt, reference)
            image = _decode_base64_image(encoded)
            source = f"openai-codex/{current_model}"
        except Exception as exc:
            codex_error = exc
            if requested_provider or requested_model:
                raise RuntimeError(
                    f"image generation with openai-codex/{current_model} failed: {exc}"
                ) from None

    if not use_codex or codex_error is not None:
        credentials = await ProviderRepository().list_for_user(user_id)
        try:
            target = _select_target(credentials, provider_id, model, require_reference=reference is not None)
        except ValueError as exc:
            if codex_error is not None:
                raise RuntimeError(
                    f"image generation with openai-codex/{current_model} failed: {codex_error}; "
                    f"no configured image-model fallback is available"
                ) from None
            raise
        source = f"{target.credential.provider_id}/{target.model}"
        try:
            image, _mime_type = await _request_image(target, cleaned_prompt, reference)
        except Exception as exc:
            message = str(exc)
            if target.credential.api_key:
                message = message.replace(target.credential.api_key, "[redacted]")
            raise RuntimeError(f"image generation with {source} failed: {message}") from None

    extension = _raster_extension(image)

    workspace_root = Path(work_dir).resolve()
    output_dir = workspace_root / "generated-images"
    output_dir.mkdir(parents=True, exist_ok=True)
    if not output_dir.resolve().is_relative_to(workspace_root):
        raise RuntimeError("generated image directory escapes the Session workspace")
    output_path = output_dir / f"generated-{uuid.uuid4().hex}.{extension}"
    output_path.write_bytes(image)
    resolved_path = output_path.resolve()
    reference_summary = (
        f" using reference image {reference['path']}"
        if reference is not None
        else ""
    )
    return (
        f"Generated one image with {source}{reference_summary}.\n"
        f"{resolved_path}"
    )


read_image_tool: FunctionToolSpec = FunctionToolSpec.from_raw(read_image)
generate_image_tool: FunctionToolSpec = FunctionToolSpec.from_raw(generate_image)

__all__ = ["generate_image", "generate_image_tool", "read_image", "read_image_tool"]
