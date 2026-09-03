from __future__ import annotations

import base64
import binascii
import inspect
import uuid
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

import httpx
from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec
from bridgic.core.model.types import Message, Role
from google import genai
from google.genai import types

from .._error import ImageProviderResponseError, PublicAgentError
from ...amphi_service.protocol.llms import (
    PROVIDER_CATALOG_BY_ID,
    build_codex_llm,
    build_llm,
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
from ...amphi_service.protocol.llms.codex_llm import DEFAULT_CODEX_MODEL
from ...amphi_service.i18n import backend_i18n
from ...amphi_store import ProviderCredential, ProviderRepository, User


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


def _capability_label(require_reference: bool) -> str:
    suffix = "reference" if require_reference else "generation"
    return backend_i18n.text(f"agent.image_tool.capability.{suffix}")


def _friendly_provider_failure(operation: str, exc: Exception) -> str:
    public = PublicAgentError.from_exception(exc)
    if public.code == "image_input_invalid":
        return backend_i18n.text("agent.image_tool.error.image_invalid")
    if public.code == "image_input_unsupported":
        return backend_i18n.text(
            "agent.image_tool.error.vision_unsupported",
            model_display=backend_i18n.text("llm.selected_model"),
        )
    suffix = "read" if operation == "read" else "generation"
    if public.code == "internal_error":
        return backend_i18n.text(f"agent.image_tool.error.{suffix}_failed")
    return backend_i18n.text(
        f"agent.image_tool.error.{suffix}_failed_reason",
        reason=public.message,
    )


async def _close_temporary_llm(llm: Any) -> None:
    client = getattr(llm, "client", None)
    close = getattr(client, "close", None)
    if callable(close):
        with suppress(Exception):
            close()
    async_client = getattr(llm, "async_client", None)
    async_close = getattr(async_client, "aclose", None) or getattr(async_client, "close", None)
    if callable(async_close):
        with suppress(Exception):
            result = async_close()
            if inspect.isawaitable(result):
                await result


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
            raise ValueError(backend_i18n.text(
                "agent.image_tool.error.provider_not_configured",
                provider_id=requested_provider,
            ))
        if not credential.is_enabled:
            raise ValueError(backend_i18n.text(
                "agent.image_tool.error.provider_disabled",
                provider_id=requested_provider,
            ))
        if not credential.api_key:
            raise ValueError(backend_i18n.text(
                "agent.image_tool.error.provider_key_required",
                provider_id=requested_provider,
            ))
        if requested_model and requested_model not in credential.enabled_models:
            raise ValueError(backend_i18n.text(
                "agent.image_tool.error.model_not_enabled",
                model_id=requested_model,
                provider_id=requested_provider,
            ))
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
            if requested_model:
                raise ValueError(backend_i18n.text(
                    "agent.image_tool.error.requested_model_unavailable",
                    capability=_capability_label(require_reference),
                    model_id=requested_model,
                ))
            raise ValueError(backend_i18n.text(
                "agent.image_tool.error.model_capability_missing",
                capability=_capability_label(require_reference),
                provider_id=requested_provider,
            ))
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
        raise ValueError(backend_i18n.text(
            "agent.image_tool.error.requested_model_unavailable",
            capability=_capability_label(require_reference),
            model_id=requested_model,
        ))
    if require_reference:
        raise ValueError(backend_i18n.text("agent.image_tool.error.no_reference_model"))
    raise ValueError(backend_i18n.text("agent.image_tool.error.no_generation_model"))


def _default_base_url(provider_id: str) -> Optional[str]:
    provider = PROVIDER_CATALOG_BY_ID.get(provider_id)
    if not isinstance(provider, dict):
        return None
    value = provider.get("default_base_url")
    return value if isinstance(value, str) and value.strip() else None


def _normalized_base_url(credential: ProviderCredential) -> str:
    base_url = (credential.base_url or _default_base_url(credential.provider_id) or "").strip()
    if not base_url:
        raise ValueError(backend_i18n.text(
            "agent.image_tool.error.provider_url_missing",
            provider_id=credential.provider_id,
        ))
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


def _response_error(response: httpx.Response) -> ImageProviderResponseError:
    message = ""
    code = ""
    try:
        payload = response.json()
        error = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(error, dict):
            message = str(error.get("message") or error.get("code") or "")
            code = str(error.get("code") or error.get("type") or "")
        elif error:
            message = str(error)
    except ValueError:
        pass
    suffix = f": {message[:500]}" if message else ""
    return ImageProviderResponseError(
        f"image provider returned HTTP {response.status_code}{suffix}",
        response.status_code,
        code,
    )


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
        raise _response_error(response)
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


def _inspect_session_image(file_path: str, work_dir: Any) -> dict:
    cleaned_path = file_path.strip()
    if not cleaned_path:
        raise ValueError(backend_i18n.text("agent.image_tool.error.file_required"))
    candidate = Path(cleaned_path)
    resolved_path = (
        candidate.resolve()
        if candidate.is_absolute()
        else (Path(work_dir).resolve() / candidate).resolve()
    )
    try:
        image = inspect_image_input(
            str(resolved_path),
            resolved_path.name,
            max_bytes=_MAX_IMAGE_BYTES,
        )
        if image is None:
            raise ImageInputValidationError(f"File is not a supported image: {resolved_path}")
        return validate_image_inputs([image], max_total_bytes=_MAX_IMAGE_BYTES)[0]
    except ImageInputValidationError as exc:
        raise ImageInputValidationError(
            backend_i18n.text("agent.image_tool.error.image_invalid")
        ) from exc


async def read_image(file_path: str, prompt: str = "") -> str:
    """Inspect one local image with an available vision-capable model.

    Use this tool when visual details in a local or generated image must be
    understood, compared, checked, or converted into a generation-ready
    description. Relative paths resolve from the current Session workspace;
    absolute paths returned by ``generate_image`` can be passed directly.

    The tool prefers the current model when it supports image input. Otherwise
    it automatically tries an enabled ChatGPT Auth model, then an enabled API
    provider model with vision capability. It returns textual visual analysis,
    not the image pixels. For later generation, use this analysis to refine the
    prompt and also pass the same path through
    ``generate_image.reference_image_path`` so the image model receives the
    source pixels directly.

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
        raise ValueError(backend_i18n.text(
            "agent.image_tool.error.read_prompt_too_long"
        ))

    agent = current_agent.get(None)
    context = getattr(agent, "ctx", None) if agent is not None else None
    session = getattr(context, "session", None) if context is not None else None
    workspace = getattr(context, "workspace", None) if context is not None else None
    user_id = getattr(session, "user_id", None) if session is not None else None
    work_dir = getattr(workspace, "work_dir", None) if workspace is not None else None
    current_llm = getattr(agent, "_llm", None) if agent is not None else None
    if not user_id or work_dir is None:
        raise RuntimeError(backend_i18n.text(
            "agent.image_tool.error.read_unavailable"
        ))

    image = _inspect_session_image(file_path, work_dir)
    resolved_path = str(image["path"])
    llm_provider = getattr(context, "llm_provider", None)
    support = (
        llm_provider.supports_image_input()
        if llm_provider is not None
        else None
    )

    def inspection_messages() -> list[Message]:
        return [
            Message.from_text(_IMAGE_ANALYSIS_SYSTEM_PROMPT, role=Role.SYSTEM),
            Message.from_text(
                cleaned_prompt,
                role=Role.USER,
                extras={IMAGE_INPUTS_EXTRA: [image]},
            ),
        ]

    async def inspect_with(llm: Any) -> Any:
        return await llm.achat(inspection_messages())

    response: Any = None
    response_received = False
    current_failure: Optional[Exception] = None
    if current_llm is not None and support is not False:
        try:
            response = await inspect_with(current_llm)
            response_received = True
        except Exception as exc:
            if PublicAgentError.from_exception(exc).code != "image_input_unsupported":
                raise RuntimeError(_friendly_provider_failure("read", exc)) from exc
            current_failure = exc

    if not response_received:
        try:
            credentials = await ProviderRepository().list_for_user(user_id)
        except Exception as exc:
            raise RuntimeError(_friendly_provider_failure("read", exc)) from exc

        current_protocol = str(getattr(current_llm, "protocol", "") or "")
        current_provider_id = (
            "openai-codex"
            if current_protocol == "openai-codex"
            else str(getattr(llm_provider, "provider_id", "") or "")
        )
        current_model_id = str(getattr(llm_provider, "model_id", "") or "")

        def normalized_provider_id(credential: ProviderCredential) -> str:
            return (
                "openai-codex"
                if credential.protocol == "openai-codex"
                else credential.provider_id
            )

        def supports_vision(credential: ProviderCredential, candidate: str) -> bool:
            metadata = catalog_model(normalized_provider_id(credential), candidate)
            return bool(
                metadata is not None
                and "image" in metadata["input_modalities"]
                and "text" in metadata["output_modalities"]
            )

        def select_fallback() -> Optional[_ImageTarget]:
            rows = _ordered_credentials(credentials)
            codex_credential = next((
                credential
                for credential in rows
                if credential.is_enabled
                and credential.auth_mode == "oauth"
                and credential.protocol == "openai-codex"
            ), None)
            if codex_credential is not None:
                candidates = list(codex_credential.enabled_models)
                if DEFAULT_CODEX_MODEL in candidates:
                    candidates.remove(DEFAULT_CODEX_MODEL)
                    candidates.insert(0, DEFAULT_CODEX_MODEL)
                selected = next((
                    candidate
                    for candidate in candidates
                    if supports_vision(codex_credential, candidate)
                    and not (
                        current_failure is not None
                        and current_provider_id == "openai-codex"
                        and current_model_id == candidate
                    )
                ), None)
                if selected is not None:
                    return _ImageTarget(codex_credential, selected)

            for credential in rows:
                if (
                    not credential.is_enabled
                    or not credential.api_key
                    or credential.protocol not in {"anthropic", "google", "openai"}
                ):
                    continue
                selected = next((
                    candidate
                    for candidate in credential.enabled_models
                    if supports_vision(credential, candidate)
                    and not (
                        current_failure is not None
                        and current_provider_id == normalized_provider_id(credential)
                        and current_model_id == candidate
                    )
                ), None)
                if selected is not None:
                    return _ImageTarget(credential, selected)
            return None

        target = select_fallback()
        if target is None:
            model_id = current_model_id
            raise ImageInputUnsupportedError(
                model_id,
                backend_i18n.text("agent.image_tool.error.no_vision_model"),
            ) from current_failure

        fallback_llm: Any = None
        try:
            if target.credential.protocol == "openai-codex":
                fallback_llm = build_codex_llm(
                    target.model,
                    user_id=user_id,
                    api_base=target.credential.base_url,
                )
            else:
                fallback_llm = build_llm(
                    User(
                        id=user_id,
                        api_key=target.credential.api_key,
                        base_url=(
                            target.credential.base_url
                            or _default_base_url(target.credential.provider_id)
                        ),
                        current_model=target.model,
                        protocol=target.credential.protocol,
                    ),
                    target.model,
                )
            response = await inspect_with(fallback_llm)
            response_received = True
        except Exception as exc:
            raise RuntimeError(_friendly_provider_failure("read", exc)) from exc
        finally:
            if fallback_llm is not None:
                await _close_temporary_llm(fallback_llm)

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
        raise RuntimeError(backend_i18n.text("agent.image_tool.error.read_failed"))
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
    image-generation or image-editing tool. When another provider is current,
    an enabled ChatGPT Auth channel is used as the first automatic fallback.
    Otherwise the tool prefers the active API-key provider, then the first
    enabled model with the required output and input modalities. Pass
    ``provider_id`` or ``model`` only when the user explicitly requests a
    configured provider or model.

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
        raise ValueError(backend_i18n.text(
            "agent.image_tool.error.generation_prompt_required"
        ))
    if len(cleaned_prompt) > 32_000:
        raise ValueError(backend_i18n.text(
            "agent.image_tool.error.generation_prompt_too_long"
        ))

    agent = current_agent.get(None)
    context = getattr(agent, "ctx", None) if agent is not None else None
    session = getattr(context, "session", None) if context is not None else None
    workspace = getattr(context, "workspace", None) if context is not None else None
    user_id = getattr(session, "user_id", None) if session is not None else None
    work_dir = getattr(workspace, "work_dir", None) if workspace is not None else None
    if not user_id or work_dir is None:
        raise RuntimeError(backend_i18n.text(
            "agent.image_tool.error.generation_unavailable"
        ))
    reference = (
        _inspect_session_image(reference_image_path, work_dir)
        if reference_image_path.strip()
        else None
    )

    def select_codex_fallback(credentials: Iterable[ProviderCredential]) -> Optional[_ImageTarget]:
        requested_provider = provider_id.strip()
        requested_model = model.strip()
        if requested_provider and requested_provider not in {"openai", "openai-codex"}:
            return None

        credential = next(
            (
                row
                for row in _ordered_credentials(credentials)
                if row.is_enabled
                and row.auth_mode == "oauth"
                and row.protocol == "openai-codex"
            ),
            None,
        )
        if credential is None:
            return None

        candidates = list(credential.enabled_models)
        if requested_model:
            if requested_model not in candidates:
                return None
            candidates = [requested_model]
        elif DEFAULT_CODEX_MODEL in candidates:
            candidates.remove(DEFAULT_CODEX_MODEL)
            candidates.insert(0, DEFAULT_CODEX_MODEL)

        if reference is not None:
            def accepts_image_input(candidate: str) -> bool:
                metadata = catalog_model("openai-codex", candidate)
                return metadata is None or bool(metadata.get("vision"))

            candidates = [
                candidate
                for candidate in candidates
                if accepts_image_input(candidate)
            ]
        if not candidates:
            return None
        return _ImageTarget(credential=credential, model=candidates[0])

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

    image = b""
    source = ""
    generated = False
    codex_error: Optional[Exception] = None
    if use_codex:
        try:
            encoded = await current_llm.agenerate_image(cleaned_prompt, reference)
            image = _decode_base64_image(encoded)
            source = f"openai-codex/{current_model}"
            generated = True
        except Exception as exc:
            codex_error = exc
            if requested_provider or requested_model:
                raise RuntimeError(_friendly_provider_failure(
                    "generation",
                    exc,
                )) from exc

    if not generated:
        try:
            credentials = await ProviderRepository().list_for_user(user_id)
        except Exception as exc:
            raise RuntimeError(_friendly_provider_failure("generation", exc)) from exc
        codex_target = (
            select_codex_fallback(credentials)
            if not use_codex
            else None
        )
        if codex_target is not None:
            fallback_llm: Any = None
            try:
                fallback_llm = build_codex_llm(
                    codex_target.model,
                    user_id=user_id,
                    api_base=codex_target.credential.base_url,
                )
                encoded = await fallback_llm.agenerate_image(cleaned_prompt, reference)
                image = _decode_base64_image(encoded)
                source = f"openai-codex/{codex_target.model}"
                generated = True
            except Exception as exc:
                codex_error = exc
                if requested_provider or requested_model:
                    raise RuntimeError(_friendly_provider_failure(
                        "generation",
                        exc,
                    )) from exc
            finally:
                if fallback_llm is not None:
                    await _close_temporary_llm(fallback_llm)

        if not generated:
            try:
                target = _select_target(credentials, provider_id, model, require_reference=reference is not None)
            except ValueError:
                if codex_error is not None:
                    public = PublicAgentError.from_exception(codex_error)
                    if public.code == "internal_error":
                        message = backend_i18n.text(
                            "agent.image_tool.error.no_fallback"
                        )
                    else:
                        message = backend_i18n.text(
                            "agent.image_tool.error.no_fallback_reason",
                            reason=public.message,
                        )
                    raise RuntimeError(message) from codex_error
                raise
            source = f"{target.credential.provider_id}/{target.model}"
            try:
                image, _mime_type = await _request_image(target, cleaned_prompt, reference)
            except Exception as exc:
                raise RuntimeError(_friendly_provider_failure(
                    "generation",
                    exc,
                )) from exc

    try:
        extension = _raster_extension(image)
    except Exception as exc:
        raise RuntimeError(_friendly_provider_failure("generation", exc)) from exc

    workspace_root = Path(work_dir).resolve()
    output_dir = workspace_root / "generated-images"
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise RuntimeError(backend_i18n.text(
            "agent.image_tool.error.save_failed"
        )) from exc
    if not output_dir.resolve().is_relative_to(workspace_root):
        raise RuntimeError(backend_i18n.text(
            "agent.image_tool.error.save_failed"
        ))
    output_path = output_dir / f"generated-{uuid.uuid4().hex}.{extension}"
    try:
        output_path.write_bytes(image)
    except OSError as exc:
        raise RuntimeError(backend_i18n.text(
            "agent.image_tool.error.save_failed"
        )) from exc
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
