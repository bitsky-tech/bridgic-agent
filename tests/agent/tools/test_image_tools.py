import base64
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from bridgic.amphibious import StepToolCall, ToolArgument
from bridgic.core.model.types import Message, Response, Role

from src.amphi_agent._llm_provider import LlmProvider
from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_agent.security import ExecutionMode, PermissionEngine
from src.amphi_agent.tools import _image as image_module
from src.amphi_agent.tools._image import generate_image, read_image
from src.amphi_service.i18n import use_locale
from src.amphi_service.protocol.llms import supports_image_generation
from src.amphi_service.protocol.llms._image_inputs import (
    IMAGE_INPUTS_EXTRA,
    ImageInputUnsupportedError,
    ImageInputValidationError,
    MAX_IMAGE_INPUT_BYTES,
    MAX_IMAGE_INPUT_TOTAL_BYTES,
    inspect_image_input,
    read_image_input,
)
from src.amphi_store import ProviderCredential, ProviderRepository
from tests.agent.tools._harness import ToolHarness


_PNG = b"\x89PNG\r\n\x1a\nimage-data"


async def _configure_provider(provider_id: str, model: str, protocol: str = "openai") -> None:
    await ProviderRepository().upsert(
        "local",
        provider_id,
        auth_mode="api_key",
        api_key=f"{provider_id}-secret",
        base_url=None,
        protocol=protocol,
        models=[model],
    )


async def _configure_codex_auth(*models: str) -> None:
    await ProviderRepository().upsert(
        "local",
        "openai",
        auth_mode="oauth",
        api_key=None,
        base_url=None,
        protocol="openai-codex",
        models=list(models) or ["gpt-5.5"],
    )


def test_image_capability_and_tool_registration() -> None:
    assert supports_image_generation("openai", "gpt-image-2") is True
    assert supports_image_generation("openai", "gpt-5.5") is False
    assert [
        tool.tool_name
        for tool in TOOL_LIBRARY.select(["generate_image", "read_image"])
    ] == [
        "read_image",
        "generate_image",
    ]


async def test_read_image_uses_read_permission(tool_harness: ToolHarness) -> None:
    call = StepToolCall(
        tool="read_image",
        tool_arguments=[ToolArgument(name="file_path", value="reference.png")],
    )
    engine = PermissionEngine(
        str(tool_harness.workspace.work_dir),
        mode=ExecutionMode.REQUEST,
    )

    verdict = (await engine.evaluate([call]))[0]

    assert verdict.capability == "read"
    assert verdict.verdict == "allow"


async def test_read_image_sends_native_image_input_and_returns_text(tool_harness: ToolHarness) -> None:
    image_path = tool_harness.workspace.work_dir / "reference.png"
    image_path.write_bytes(_PNG)
    calls: list[list[Message]] = []

    class RecordingLlm:
        async def achat(self, messages: list[Message], **_: Any) -> Response:
            calls.append(messages)
            return Response(
                message=Message.from_text(
                    "A red panda in a centered watercolor composition.",
                    role=Role.AI,
                )
            )

    tool_harness.agent._llm = RecordingLlm()
    tool_harness.context.llm_provider = LlmProvider(
        model_id="gpt-5.6-sol",
        provider_id="openai-codex",
    )

    result = await read_image("reference.png", "Describe the composition for reuse")

    assert len(calls) == 1
    assert [message.role for message in calls[0]] == [Role.SYSTEM, Role.USER]
    assert calls[0][1].content == "Describe the composition for reuse"
    descriptor = calls[0][1].extras[IMAGE_INPUTS_EXTRA][0]
    assert descriptor["path"] == str(image_path.resolve())
    assert descriptor["media_type"] == "image/png"
    assert result == (
        f"Image analysis for {image_path.resolve()}:\n"
        "A red panda in a centered watercolor composition."
    )


async def test_read_image_prefers_codex_vision_fallback(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    image_path = tool_harness.workspace.work_dir / "reference.png"
    image_path.write_bytes(_PNG)
    await _configure_provider("google", "gemini-2.5-flash", "google")
    await ProviderRepository().set_active("local", "google")
    await _configure_codex_auth("gpt-5.5")
    captured: dict[str, object] = {"sync_closed": False, "async_closed": False}

    class SyncClient:
        def close(self) -> None:
            captured["sync_closed"] = True

    class AsyncClient:
        async def aclose(self) -> None:
            captured["async_closed"] = True

    class VisionLlm:
        client = SyncClient()
        async_client = AsyncClient()

        async def achat(self, messages: list[Message], **_: Any) -> Response:
            captured["messages"] = messages
            return Response(
                message=Message.from_text("A misty mountain landscape.", role=Role.AI)
            )

    def build_codex(model: str, user_id: str = "", temperature: float = 0.0, api_base: str | None = None) -> VisionLlm:
        captured.update({
            "model": model,
            "user_id": user_id,
            "temperature": temperature,
            "api_base": api_base,
        })
        return VisionLlm()

    def reject_api_fallback(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("API-key fallback should not run before ChatGPT Auth")

    monkeypatch.setattr(image_module, "build_codex_llm", build_codex)
    monkeypatch.setattr(image_module, "build_llm", reject_api_fallback)
    tool_harness.agent._llm = SimpleNamespace()
    tool_harness.context.llm_provider = LlmProvider(
        model_id="deepseek-v4-pro",
        provider_id="deepseek",
    )

    result = await read_image("reference.png", "Describe the scene")

    assert captured["model"] == "gpt-5.5"
    assert captured["user_id"] == "local"
    assert captured["sync_closed"] is True
    assert captured["async_closed"] is True
    messages = captured["messages"]
    assert isinstance(messages, list)
    assert messages[1].extras[IMAGE_INPUTS_EXTRA][0]["path"] == str(image_path.resolve())
    assert result == f"Image analysis for {image_path.resolve()}:\nA misty mountain landscape."


async def test_read_image_uses_api_vision_fallback_without_codex(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    image_path = tool_harness.workspace.work_dir / "reference.png"
    image_path.write_bytes(_PNG)
    await _configure_provider("google", "gemini-2.5-flash", "google")
    captured: dict[str, object] = {"closed": False}

    class AsyncClient:
        async def aclose(self) -> None:
            captured["closed"] = True

    class VisionLlm:
        client = SimpleNamespace(close=lambda: None)
        async_client = AsyncClient()

        async def achat(self, messages: list[Message], **_: Any) -> Response:
            captured["messages"] = messages
            return Response(
                message=Message.from_text("A geometric poster.", role=Role.AI)
            )

    def build_provider(user: object, model: str) -> VisionLlm:
        captured["user"] = user
        captured["model"] = model
        return VisionLlm()

    monkeypatch.setattr(image_module, "build_llm", build_provider)
    tool_harness.agent._llm = SimpleNamespace()
    tool_harness.context.llm_provider = LlmProvider(
        model_id="deepseek-v4-pro",
        provider_id="deepseek",
    )

    result = await read_image("reference.png")

    fallback_user = captured["user"]
    assert isinstance(fallback_user, image_module.User)
    assert fallback_user.api_key == "google-secret"
    assert fallback_user.protocol == "google"
    assert captured["model"] == "gemini-2.5-flash"
    assert captured["closed"] is True
    assert result == f"Image analysis for {image_path.resolve()}:\nA geometric poster."


async def test_read_image_skips_image_only_output_model(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    image_path = tool_harness.workspace.work_dir / "reference.png"
    image_path.write_bytes(_PNG)
    await ProviderRepository().upsert(
        "local",
        "openai",
        auth_mode="api_key",
        api_key="openai-secret",
        base_url=None,
        protocol="openai",
        models=["gpt-image-2", "gpt-4.1"],
    )
    captured: dict[str, object] = {"async_closed": False}

    class AsyncClient:
        async def close(self) -> None:
            captured["async_closed"] = True

    class VisionLlm:
        client = SimpleNamespace(close=lambda: None)
        async_client = AsyncClient()

        async def achat(self, _messages: list[Message], **_: Any) -> Response:
            return Response(
                message=Message.from_text("A textual image analysis.", role=Role.AI)
            )

    def build_provider(_user: object, model: str) -> VisionLlm:
        captured["model"] = model
        return VisionLlm()

    monkeypatch.setattr(image_module, "build_llm", build_provider)
    tool_harness.agent._llm = SimpleNamespace()
    tool_harness.context.llm_provider = LlmProvider(
        model_id="deepseek-v4-pro",
        provider_id="deepseek",
    )

    result = await read_image("reference.png")

    assert captured["model"] == "gpt-4.1"
    assert captured["async_closed"] is True
    assert result == f"Image analysis for {image_path.resolve()}:\nA textual image analysis."


async def test_read_image_does_not_retry_failed_current_codex_model(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    image_path = tool_harness.workspace.work_dir / "reference.png"
    image_path.write_bytes(_PNG)
    await _configure_codex_auth("gpt-5.5")
    await _configure_provider("google", "gemini-2.5-flash", "google")
    codex_builds: list[str] = []

    class CurrentCodexLlm:
        protocol = "openai-codex"

        async def achat(self, _messages: list[Message], **_: Any) -> Response:
            raise ImageInputUnsupportedError("gpt-5.5")

    class AsyncClient:
        async def aclose(self) -> None:
            pass

    class VisionLlm:
        client = SimpleNamespace(close=lambda: None)
        async_client = AsyncClient()

        async def achat(self, _messages: list[Message], **_: Any) -> Response:
            return Response(
                message=Message.from_text("Fallback inspection.", role=Role.AI)
            )

    def build_codex(model: str, **_kwargs: object) -> VisionLlm:
        codex_builds.append(model)
        return VisionLlm()

    monkeypatch.setattr(image_module, "build_codex_llm", build_codex)
    monkeypatch.setattr(image_module, "build_llm", lambda *_args, **_kwargs: VisionLlm())
    tool_harness.agent._llm = CurrentCodexLlm()
    tool_harness.context.llm_provider = LlmProvider(
        model_id="gpt-5.5",
        provider_id="openai",
    )

    result = await read_image("reference.png")

    assert codex_builds == []
    assert result == f"Image analysis for {image_path.resolve()}:\nFallback inspection."


async def test_read_image_rejects_known_text_only_model(tool_harness: ToolHarness) -> None:
    image_path = tool_harness.workspace.work_dir / "reference.png"
    image_path.write_bytes(_PNG)
    tool_harness.agent._llm = SimpleNamespace()
    tool_harness.context.llm_provider = LlmProvider(
        model_id="deepseek-v4-pro",
        provider_id="deepseek",
    )

    with use_locale("zh"):
        with pytest.raises(ImageInputUnsupportedError) as error:
            await read_image(str(image_path))

    assert str(error.value) == (
        "当前没有可用的图片理解模型。请完成 ChatGPT 授权，"
        "或在模型设置中启用一个支持图片输入的模型。"
    )


async def test_read_image_replaces_private_path_details_with_friendly_message(tool_harness: ToolHarness) -> None:
    tool_harness.agent._llm = SimpleNamespace()
    tool_harness.context.llm_provider = LlmProvider(
        model_id="gpt-5.6-sol",
        provider_id="openai-codex",
    )

    with use_locale("zh"):
        with pytest.raises(ImageInputValidationError) as error:
            await read_image("private/missing-reference.png")

    assert str(error.value) == (
        "无法读取这张图片。请确认文件仍然存在，是有效的 PNG、JPEG、GIF 或 WebP 图片，"
        "并且不超过 32 MB。"
    )
    assert "private/missing-reference.png" not in str(error.value)


def test_provider_failures_keep_image_tool_specific_guidance() -> None:
    with use_locale("zh"):
        invalid = image_module._friendly_provider_failure(
            "generation",
            ImageInputValidationError("private/path/reference.png changed"),
        )
        unsupported = image_module._friendly_provider_failure(
            "read",
            ImageInputUnsupportedError("provider-model-id"),
        )

    assert "不超过 32 MB" in invalid
    assert "private/path/reference.png" not in invalid
    assert unsupported == (
        "当前模型“所选模型”无法理解图片。请切换到支持图片输入的模型后重试。"
    )
    assert "移除图片" not in unsupported


async def test_generate_image_uses_network_permission(tool_harness: ToolHarness) -> None:
    call = StepToolCall(
        tool="generate_image",
        tool_arguments=[
            ToolArgument(name="prompt", value="a lighthouse"),
            ToolArgument(name="reference_image_path", value="reference.png"),
        ],
    )
    engine = PermissionEngine(
        str(tool_harness.workspace.work_dir),
        mode=ExecutionMode.REQUEST,
    )

    verdict = (await engine.evaluate([call]))[0]

    assert verdict.capability == "network"
    assert verdict.boundary == "in_workspace"
    assert verdict.verdict == "ask"


async def test_generate_image_reference_reaches_auto_mode_safety_review(tool_harness: ToolHarness) -> None:
    reference_call = StepToolCall(
        tool="generate_image",
        tool_arguments=[
            ToolArgument(name="prompt", value="keep the composition"),
            ToolArgument(name="reference_image_path", value="reference.png"),
        ],
    )
    text_only_call = StepToolCall(
        tool="generate_image",
        tool_arguments=[ToolArgument(name="prompt", value="a lighthouse")],
    )
    engine = PermissionEngine(
        str(tool_harness.workspace.work_dir),
        mode=ExecutionMode.AUTO,
    )

    reference_verdict, text_only_verdict = await engine.evaluate([
        reference_call,
        text_only_call,
    ])

    assert reference_verdict.verdict == "ask"
    assert reference_verdict.boundary == "in_workspace"
    assert text_only_verdict.verdict == "allow"


async def test_generate_image_prefers_active_provider_and_returns_preview_path(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    await _configure_provider("google", "gemini-2.5-flash-image", "google")
    await _configure_provider("openai", "gpt-image-2")
    await ProviderRepository().set_active("local", "openai")
    captured: dict[str, str] = {}

    async def request_image(target: image_module._ImageTarget, prompt: str, reference: dict | None = None) -> tuple[bytes, str]:
        assert reference is None
        captured.update(
            provider_id=target.credential.provider_id,
            model=target.model,
            prompt=prompt,
        )
        return _PNG, "image/png"

    monkeypatch.setattr(image_module, "_request_image", request_image)

    result = await generate_image("  a tiny red panda astronaut  ")

    assert captured == {
        "provider_id": "openai",
        "model": "gpt-image-2",
        "prompt": "a tiny red panda astronaut",
    }
    image_path = Path(result.splitlines()[-1])
    assert image_path.is_absolute()
    assert image_path.parent == tool_harness.workspace.work_dir / "generated-images"
    assert image_path.read_bytes() == _PNG
    assert image_path.suffix == ".png"


async def test_generate_image_prefers_current_codex_hosted_tool(tool_harness: ToolHarness) -> None:
    captured: list[str] = []

    class CodexLlm:
        protocol = "openai-codex"
        configuration = SimpleNamespace(model="gpt-5.6-sol")

        async def agenerate_image(self, prompt: str, reference: dict | None = None) -> str:
            assert reference is None
            captured.append(prompt)
            return base64.b64encode(_PNG).decode("ascii")

    tool_harness.agent._llm = CodexLlm()

    result = await generate_image("a glass city")

    assert captured == ["a glass city"]
    image_path = Path(result.splitlines()[-1])
    assert image_path.read_bytes() == _PNG
    assert result.startswith("Generated one image with openai-codex/gpt-5.6-sol.\n")


async def test_generate_image_uses_configured_codex_auth_from_another_main_provider(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    await _configure_codex_auth("gpt-5.5", "gpt-5.4-mini")
    await _configure_provider("deepseek", "deepseek-v4-pro")
    await ProviderRepository().set_active("local", "deepseek")
    tool_harness.agent._llm = SimpleNamespace(
        protocol="openai",
        configuration=SimpleNamespace(model="deepseek-v4-pro"),
    )
    captured: dict[str, object] = {}

    class CodexLlm:
        async def agenerate_image(self, prompt: str, reference: dict | None = None) -> str:
            captured.update(prompt=prompt, reference=reference)
            return base64.b64encode(_PNG).decode("ascii")

    def build_codex_llm(model: str, user_id: str = "", temperature: float = 0.0, api_base: str | None = None) -> CodexLlm:
        captured.update(model=model, user_id=user_id, temperature=temperature, api_base=api_base)
        return CodexLlm()

    monkeypatch.setattr(image_module, "build_codex_llm", build_codex_llm)

    result = await generate_image("a city floating above the clouds")

    assert captured == {
        "model": "gpt-5.5",
        "user_id": "local",
        "temperature": 0.0,
        "api_base": None,
        "prompt": "a city floating above the clouds",
        "reference": None,
    }
    assert result.startswith("Generated one image with openai-codex/gpt-5.5.\n")
    assert Path(result.splitlines()[-1]).read_bytes() == _PNG


async def test_generate_image_falls_back_to_api_key_model_after_configured_codex_failure(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    await _configure_codex_auth("gpt-5.5")
    await _configure_provider("google", "gemini-2.5-flash-image", "google")
    requested: list[tuple[str, str]] = []

    class FailingCodexLlm:
        async def agenerate_image(self, _prompt: str, _reference: dict | None = None) -> str:
            raise RuntimeError("Codex image generation unavailable")

    async def request_image(target: image_module._ImageTarget, _prompt: str, reference: dict | None = None) -> tuple[bytes, str]:
        assert reference is None
        requested.append((target.credential.provider_id, target.model))
        return _PNG, "image/png"

    monkeypatch.setattr(image_module, "build_codex_llm", lambda *_args, **_kwargs: FailingCodexLlm())
    monkeypatch.setattr(image_module, "_request_image", request_image)

    result = await generate_image("a lighthouse")

    assert requested == [("google", "gemini-2.5-flash-image")]
    assert result.startswith("Generated one image with google/gemini-2.5-flash-image.\n")


async def test_generate_image_localizes_codex_failure_without_exposing_details(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    await _configure_codex_auth("gpt-5.5")

    class FailingCodexLlm:
        async def agenerate_image(self, _prompt: str, _reference: dict | None = None) -> str:
            raise RuntimeError("Codex returned no generated image")

    monkeypatch.setattr(image_module, "build_codex_llm", lambda *_args, **_kwargs: FailingCodexLlm())

    with use_locale("zh"):
        with pytest.raises(RuntimeError) as error:
            await generate_image("a lighthouse")

    assert str(error.value) == (
        "图片生成没有完成，并且当前没有可用的备用图片生成模型。"
        "请稍后重试，或在模型设置中启用一个支持图片生成的模型。"
    )
    assert "Codex" not in str(error.value)


async def test_generate_image_explicit_api_provider_bypasses_configured_codex_auth(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    await _configure_codex_auth("gpt-5.5")
    await _configure_provider("google", "gemini-2.5-flash-image", "google")
    requested: list[tuple[str, str]] = []

    def unexpected_codex(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("Explicit Google selection must not use ChatGPT Auth")

    async def request_image(target: image_module._ImageTarget, _prompt: str, reference: dict | None = None) -> tuple[bytes, str]:
        assert reference is None
        requested.append((target.credential.provider_id, target.model))
        return _PNG, "image/png"

    monkeypatch.setattr(image_module, "build_codex_llm", unexpected_codex)
    monkeypatch.setattr(image_module, "_request_image", request_image)

    await generate_image(
        "a paper-cut forest",
        provider_id="google",
        model="gemini-2.5-flash-image",
    )

    assert requested == [("google", "gemini-2.5-flash-image")]


async def test_generate_image_passes_reference_pixels_to_configured_codex_fallback(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    await _configure_codex_auth("gpt-5.5")
    image_path = tool_harness.workspace.work_dir / "character.png"
    image_path.write_bytes(_PNG)
    captured: dict[str, object] = {}

    class CodexLlm:
        async def agenerate_image(self, prompt: str, reference: dict | None = None) -> str:
            captured.update(prompt=prompt, reference=reference)
            return base64.b64encode(_PNG).decode("ascii")

    monkeypatch.setattr(image_module, "build_codex_llm", lambda *_args, **_kwargs: CodexLlm())

    result = await generate_image(
        "Keep the character and change the background to a forest",
        reference_image_path="character.png",
    )

    assert captured["prompt"] == "Keep the character and change the background to a forest"
    assert isinstance(captured["reference"], dict)
    assert captured["reference"]["path"] == str(image_path.resolve())
    assert f"using reference image {image_path.resolve()}" in result


async def test_generate_image_passes_reference_pixels_to_codex(tool_harness: ToolHarness) -> None:
    image_path = tool_harness.workspace.work_dir / "character.png"
    image_path.write_bytes(_PNG)
    captured: dict[str, Any] = {}

    class CodexLlm:
        protocol = "openai-codex"
        configuration = SimpleNamespace(model="gpt-5.6-sol")

        async def agenerate_image(self, prompt: str, reference: dict | None = None) -> str:
            captured.update(prompt=prompt, reference=reference)
            return base64.b64encode(_PNG).decode("ascii")

    tool_harness.agent._llm = CodexLlm()
    tool_harness.context.llm_provider = LlmProvider(
        model_id="gpt-5.6-sol",
        provider_id="openai-codex",
    )

    result = await generate_image(
        "Keep the character and change the background to a forest",
        reference_image_path="character.png",
    )

    assert captured["prompt"] == "Keep the character and change the background to a forest"
    assert captured["reference"]["path"] == str(image_path.resolve())
    assert f"using reference image {image_path.resolve()}" in result
    assert Path(result.splitlines()[-1]).read_bytes() == _PNG


async def test_generate_image_honors_explicit_provider_and_model(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    await _configure_provider("google", "gemini-2.5-flash-image", "google")
    selected: list[tuple[str, str]] = []

    async def request_image(target: image_module._ImageTarget, _prompt: str, reference: dict | None = None) -> tuple[bytes, str]:
        assert reference is None
        selected.append((target.credential.provider_id, target.model))
        return _PNG, "image/png"

    monkeypatch.setattr(image_module, "_request_image", request_image)

    await generate_image(
        "a paper-cut forest",
        provider_id="google",
        model="gemini-2.5-flash-image",
    )

    assert selected == [("google", "gemini-2.5-flash-image")]


async def test_generate_image_requires_a_configured_image_model(tool_harness: ToolHarness) -> None:
    await _configure_provider("openai", "gpt-5.5")

    with use_locale("en"):
        with pytest.raises(ValueError) as english_error:
            await generate_image("a lighthouse")

    assert str(english_error.value) == (
        "No image generation model is available. Connect ChatGPT, or enable a model "
        "that supports image generation in model settings."
    )

    with use_locale("zh"):
        with pytest.raises(ValueError) as error:
            await generate_image("a lighthouse")

    assert str(error.value) == (
        "当前没有可用的图片生成模型。请完成 ChatGPT 授权，"
        "或在模型设置中启用一个支持图片生成的模型。"
    )


async def test_generate_image_replaces_provider_failure_with_friendly_message(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    await _configure_provider("openai", "gpt-image-2")

    async def request_image(*_args: object, **_kwargs: object) -> tuple[bytes, str]:
        raise RuntimeError("provider overloaded")

    monkeypatch.setattr(image_module, "_request_image", request_image)

    with use_locale("zh"):
        with pytest.raises(RuntimeError) as error:
            await generate_image("a lighthouse")

    assert str(error.value) == (
        "图片生成没有完成。当前服务暂时不可用。请稍后再试，或换一个模型。"
    )
    assert "provider overloaded" not in str(error.value)


def test_image_inputs_and_generated_outputs_share_the_same_size_limit(tool_harness: ToolHarness) -> None:
    assert MAX_IMAGE_INPUT_BYTES == MAX_IMAGE_INPUT_TOTAL_BYTES
    assert MAX_IMAGE_INPUT_BYTES == image_module._MAX_IMAGE_BYTES

    image_path = tool_harness.workspace.work_dir / "maximum-size-image.png"
    image_bytes = _PNG + b"x" * (MAX_IMAGE_INPUT_BYTES - len(_PNG))
    image_path.write_bytes(image_bytes)

    message_descriptor = inspect_image_input(str(image_path))
    assert message_descriptor is not None
    assert message_descriptor["size_bytes"] == MAX_IMAGE_INPUT_BYTES

    descriptor = image_module._inspect_session_image(
        str(image_path),
        tool_harness.workspace.work_dir,
    )

    assert descriptor["size_bytes"] == len(image_bytes)
    assert read_image_input(descriptor) == (image_bytes, "image/png")

    image_path.write_bytes(image_bytes + b"x")
    with pytest.raises(ImageInputValidationError, match="Image exceeds"):
        inspect_image_input(str(image_path))
    with pytest.raises(ImageInputValidationError, match="no larger than 32 MB"):
        image_module._inspect_session_image(
            str(image_path),
            tool_harness.workspace.work_dir,
        )


@pytest.mark.parametrize(
    ("provider_id", "base_url", "expected_url"),
    [
        (
            "openai",
            "https://api.openai.com/v1/chat/completions",
            "https://api.openai.com/v1/images/generations",
        ),
        (
            "openrouter",
            "https://openrouter.ai/api/v1",
            "https://openrouter.ai/api/v1/images",
        ),
    ],
)
async def test_http_image_provider_routes(monkeypatch: pytest.MonkeyPatch, provider_id: str, base_url: str, expected_url: str) -> None:
    captured: dict[str, object] = {}

    class Client:
        def __init__(self, **kwargs: object) -> None:
            captured["client"] = kwargs

        async def __aenter__(self) -> "Client":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, url: str, **kwargs: object) -> httpx.Response:
            captured["url"] = url
            captured["request"] = kwargs
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "b64_json": base64.b64encode(_PNG).decode("ascii"),
                            "media_type": "image/png",
                        }
                    ]
                },
            )

    monkeypatch.setattr(image_module.httpx, "AsyncClient", Client)
    credential = ProviderCredential(
        user_id="local",
        provider_id=provider_id,
        auth_mode="api_key",
        api_key="secret",
        base_url=base_url,
        protocol="openai",
        enabled_models=["image-model"],
    )

    image, mime_type = await image_module._request_http_image(
        image_module._ImageTarget(credential, "image-model"),
        "draw a bridge",
    )

    assert captured["url"] == expected_url
    assert captured["request"] == {
        "headers": {
            "Authorization": "Bearer secret",
            "Content-Type": "application/json",
        },
        "json": {"model": "image-model", "prompt": "draw a bridge"},
    }
    assert image == _PNG
    assert mime_type == "image/png"


async def test_http_image_provider_ignores_json_envelope_size(monkeypatch: pytest.MonkeyPatch) -> None:
    class Client:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self) -> "Client":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, _url: str, **_kwargs: object) -> httpx.Response:
            encoded_limit = ((MAX_IMAGE_INPUT_BYTES + 2) // 3) * 4
            return httpx.Response(
                200,
                headers={"content-length": str(encoded_limit + 1024)},
                json={"data": [{"b64_json": base64.b64encode(_PNG).decode("ascii")}]},
            )

    monkeypatch.setattr(image_module.httpx, "AsyncClient", Client)
    credential = ProviderCredential(
        user_id="local",
        provider_id="openai",
        auth_mode="api_key",
        api_key="secret",
        base_url="https://api.openai.com/v1",
        protocol="openai",
        enabled_models=["gpt-image-2"],
    )

    image, _ = await image_module._request_http_image(
        image_module._ImageTarget(credential, "gpt-image-2"),
        "draw a bridge",
    )

    assert image == _PNG


async def test_openai_reference_image_uses_multipart_edit_endpoint(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {}
    image_path = tmp_path / "reference.png"
    image_path.write_bytes(_PNG)
    reference = inspect_image_input(str(image_path))
    assert reference is not None

    class Client:
        def __init__(self, **kwargs: object) -> None:
            captured["client"] = kwargs

        async def __aenter__(self) -> "Client":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, url: str, **kwargs: object) -> httpx.Response:
            captured["url"] = url
            captured["request"] = kwargs
            return httpx.Response(
                200,
                json={"data": [{"b64_json": base64.b64encode(_PNG).decode("ascii")}]},
            )

    monkeypatch.setattr(image_module.httpx, "AsyncClient", Client)
    credential = ProviderCredential(
        user_id="local",
        provider_id="openai",
        auth_mode="api_key",
        api_key="secret",
        base_url="https://api.openai.com/v1",
        protocol="openai",
        enabled_models=["gpt-image-2"],
    )

    image, _ = await image_module._request_http_image(
        image_module._ImageTarget(credential, "gpt-image-2"),
        "turn the scene into watercolor",
        reference,
    )

    assert captured["url"] == "https://api.openai.com/v1/images/edits"
    request = captured["request"]
    assert isinstance(request, dict)
    assert request["headers"] == {"Authorization": "Bearer secret"}
    assert request["data"] == {
        "model": "gpt-image-2",
        "prompt": "turn the scene into watercolor",
    }
    assert request["files"]["image"] == ("reference.png", _PNG, "image/png")
    assert image == _PNG


async def test_openrouter_reference_image_uses_input_references(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {}
    image_path = tmp_path / "reference.png"
    image_path.write_bytes(_PNG)
    reference = inspect_image_input(str(image_path))
    assert reference is not None

    class Client:
        def __init__(self, **kwargs: object) -> None:
            captured["client"] = kwargs

        async def __aenter__(self) -> "Client":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, url: str, **kwargs: object) -> httpx.Response:
            captured["url"] = url
            captured["request"] = kwargs
            return httpx.Response(
                200,
                json={"data": [{"b64_json": base64.b64encode(_PNG).decode("ascii")}]},
            )

    monkeypatch.setattr(image_module.httpx, "AsyncClient", Client)
    credential = ProviderCredential(
        user_id="local",
        provider_id="openrouter",
        auth_mode="api_key",
        api_key="secret",
        base_url="https://openrouter.ai/api/v1",
        protocol="openai",
        enabled_models=["google/gemini-3.1-flash-image"],
    )

    await image_module._request_http_image(
        image_module._ImageTarget(credential, "google/gemini-3.1-flash-image"),
        "keep the subject",
        reference,
    )

    assert captured["url"] == "https://openrouter.ai/api/v1/images"
    request = captured["request"]
    assert isinstance(request, dict)
    assert request["headers"] == {
        "Authorization": "Bearer secret",
        "Content-Type": "application/json",
    }
    reference_url = request["json"]["input_references"][0]["image_url"]["url"]
    assert reference_url == f"data:image/png;base64,{base64.b64encode(_PNG).decode('ascii')}"


async def test_google_image_provider_reads_inline_data(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class Models:
        async def generate_content(self, **kwargs: object) -> object:
            captured.update(kwargs)
            return SimpleNamespace(
                candidates=[
                    SimpleNamespace(
                        content=SimpleNamespace(
                            parts=[
                                SimpleNamespace(
                                    inline_data=SimpleNamespace(
                                        data=_PNG,
                                        mime_type="image/png",
                                    )
                                )
                            ]
                        )
                    )
                ]
            )

    class AsyncClient:
        models = Models()

        async def aclose(self) -> None:
            captured["closed"] = True

    class Client:
        def __init__(self, **kwargs: object) -> None:
            captured["client"] = kwargs
            self.aio = AsyncClient()

    monkeypatch.setattr(image_module.genai, "Client", Client)
    credential = ProviderCredential(
        user_id="local",
        provider_id="google",
        auth_mode="api_key",
        api_key="google-secret",
        base_url=None,
        protocol="google",
        enabled_models=["gemini-2.5-flash-image"],
    )

    image, mime_type = await image_module._request_google_image(
        image_module._ImageTarget(credential, "gemini-2.5-flash-image"),
        "draw a bridge",
    )

    assert captured["client"] == {"api_key": "google-secret", "http_options": None}
    assert captured["model"] == "gemini-2.5-flash-image"
    assert captured["contents"] == "draw a bridge"
    assert captured["config"].response_modalities == ["IMAGE"]
    assert captured["closed"] is True
    assert image == _PNG
    assert mime_type == "image/png"


async def test_google_reference_image_is_sent_with_prompt(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {}
    image_path = tmp_path / "reference.png"
    image_path.write_bytes(_PNG)
    reference = inspect_image_input(str(image_path))
    assert reference is not None

    class Models:
        async def generate_content(self, **kwargs: object) -> object:
            captured.update(kwargs)
            return SimpleNamespace(
                candidates=[
                    SimpleNamespace(
                        content=SimpleNamespace(
                            parts=[
                                SimpleNamespace(
                                    inline_data=SimpleNamespace(
                                        data=_PNG,
                                        mime_type="image/png",
                                    )
                                )
                            ]
                        )
                    )
                ]
            )

    class AsyncClient:
        models = Models()

        async def aclose(self) -> None:
            return None

    class Client:
        def __init__(self, **_kwargs: object) -> None:
            self.aio = AsyncClient()

    monkeypatch.setattr(image_module.genai, "Client", Client)
    credential = ProviderCredential(
        user_id="local",
        provider_id="google",
        auth_mode="api_key",
        api_key="google-secret",
        base_url=None,
        protocol="google",
        enabled_models=["gemini-2.5-flash-image"],
    )

    await image_module._request_google_image(
        image_module._ImageTarget(credential, "gemini-2.5-flash-image"),
        "change only the background",
        reference,
    )

    contents = captured["contents"]
    assert isinstance(contents, list)
    assert contents[0] == "change only the background"
    assert contents[1].inline_data.data == _PNG
    assert contents[1].inline_data.mime_type == "image/png"
