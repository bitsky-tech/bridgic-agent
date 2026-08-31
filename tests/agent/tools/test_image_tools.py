import base64
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from bridgic.amphibious import StepToolCall, ToolArgument

from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_agent.security import ExecutionMode, PermissionEngine
from src.amphi_agent.tools import _image as image_module
from src.amphi_agent.tools._image import generate_image
from src.amphi_service.protocol.llms import supports_image_generation
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


def test_image_capability_and_tool_registration() -> None:
    assert supports_image_generation("openai", "gpt-image-2") is True
    assert supports_image_generation("openai", "gpt-5.5") is False
    assert [tool.tool_name for tool in TOOL_LIBRARY.select(["generate_image"])] == [
        "generate_image"
    ]


async def test_generate_image_uses_network_permission(tool_harness: ToolHarness) -> None:
    call = StepToolCall(
        tool="generate_image",
        tool_arguments=[ToolArgument(name="prompt", value="a lighthouse")],
    )
    engine = PermissionEngine(
        str(tool_harness.workspace.work_dir),
        mode=ExecutionMode.REQUEST,
    )

    verdict = (await engine.evaluate([call]))[0]

    assert verdict.capability == "network"
    assert verdict.verdict == "ask"


async def test_generate_image_prefers_active_provider_and_returns_preview_path(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    await _configure_provider("google", "gemini-2.5-flash-image", "google")
    await _configure_provider("openai", "gpt-image-2")
    await ProviderRepository().set_active("local", "openai")
    captured: dict[str, str] = {}

    async def request_image(target: image_module._ImageTarget, prompt: str) -> tuple[bytes, str]:
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

        async def agenerate_image(self, prompt: str) -> str:
            captured.append(prompt)
            return base64.b64encode(_PNG).decode("ascii")

    tool_harness.agent._llm = CodexLlm()

    result = await generate_image("a glass city")

    assert captured == ["a glass city"]
    image_path = Path(result.splitlines()[-1])
    assert image_path.read_bytes() == _PNG
    assert result.startswith("Generated one image with openai-codex/gpt-5.6-sol.\n")


async def test_generate_image_honors_explicit_provider_and_model(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    await _configure_provider("google", "gemini-2.5-flash-image", "google")
    selected: list[tuple[str, str]] = []

    async def request_image(target: image_module._ImageTarget, _prompt: str) -> tuple[bytes, str]:
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

    with pytest.raises(ValueError, match="no enabled text-to-image model"):
        await generate_image("a lighthouse")


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
