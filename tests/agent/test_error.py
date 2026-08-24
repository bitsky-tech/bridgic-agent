from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from src.amphi_agent._error import PublicAgentError
from src.amphi_service.i18n import use_locale
from src.amphi_service.protocol.llms._codex_credentials import CodexAuthError


class ProviderError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


def test_context_limit_unwraps_framework_error_without_exposing_provider_details() -> None:
    provider = ProviderError(
        "Error code: 400 - context window exceeded; token=sk-private; type=upstream_error",
        status_code=400,
        code="context_length_exceeded",
    )
    wrapper = RuntimeError(
        "Worker 'WorkflowThink' failed during observe-think-act cycle: "
        f"{provider}"
    )
    wrapper.__cause__ = provider

    public = PublicAgentError.from_exception(wrapper)

    assert public == PublicAgentError(
        code="context_too_large",
        message="当前会话或任务内容已超过所选模型的上下文上限。请减少输入、压缩会话历史，或新建会话后重试。",
        retryable=False,
        action="new_session",
    )
    assert "WorkflowThink" not in public.message
    assert "sk-private" not in public.message
    assert "upstream_error" not in public.message


@pytest.mark.parametrize(
    ("error", "code", "retryable", "action"),
    [
        (ProviderError("model missing", status_code=404, code="model_not_found"), "model_not_found", False, "open_model_settings"),
        (ProviderError("insufficient quota", status_code=429, code="insufficient_quota"), "quota_exhausted", False, "switch_model"),
        (ProviderError("rate limit", status_code=429), "rate_limited", True, "retry"),
        (ProviderError("invalid key", status_code=401), "authentication_failed", False, "open_model_settings"),
        (ProviderError("content policy", status_code=400, code="content_filter"), "content_rejected", False, "edit_input"),
        (ProviderError("forbidden", status_code=403), "permission_denied", False, "switch_model"),
        (ProviderError("missing endpoint", status_code=404), "model_or_endpoint_not_found", False, "open_model_settings"),
        (ProviderError("invalid payload", status_code=422), "request_rejected", False, "edit_input"),
        (ProviderError("service unavailable", status_code=503), "provider_unavailable", True, "retry"),
        (TimeoutError("read timed out"), "request_timeout", True, "retry"),
        (httpx.ConnectError("connection refused"), "network_unreachable", True, "retry"),
        (RuntimeError("database password=private"), "internal_error", True, "retry"),
    ],
)
def test_common_failures_have_stable_public_metadata(error: Exception, code: str, retryable: bool, action: str) -> None:
    public = PublicAgentError.from_exception(error)

    assert public.code == code
    assert public.retryable is retryable
    assert public.action == action
    assert str(error) not in public.message


def test_incomplete_stream_is_distinct_from_connection_failure() -> None:
    public = PublicAgentError.from_exception(httpx.RemoteProtocolError(
        "peer closed connection without sending complete message body",
    ))

    assert public.code == "stream_interrupted"
    assert public.retryable is True
    assert public.action == "retry"


def test_sdk_original_exception_is_classified() -> None:
    provider = ProviderError("invalid request", status_code=400, code="context_length_exceeded")
    wrapper = RuntimeError("model retry limit exceeded")
    wrapper.original_exception = provider  # type: ignore[attr-defined]

    assert PublicAgentError.from_exception(wrapper).code == "context_too_large"


def test_codex_auth_preserves_its_safe_message_and_action() -> None:
    error = CodexAuthError(
        "Codex 登录已失效，请重新登录。",
        code="codex_auth_expired",
        relogin_required=True,
    )

    public = PublicAgentError.from_exception(error)

    assert public == PublicAgentError(
        code="codex_auth_expired",
        message="Codex 登录已失效，请重新登录。",
        retryable=False,
        action="relogin",
    )


def test_public_messages_follow_the_active_locale() -> None:
    with use_locale("en"):
        public = PublicAgentError.from_exception(ProviderError("rate limit", status_code=429))

    assert public.message == "The model service is receiving too many requests. Please try again later."


def test_http_status_can_be_read_from_the_sdk_response() -> None:
    error = RuntimeError("opaque provider failure")
    error.response = SimpleNamespace(status_code=403)  # type: ignore[attr-defined]

    assert PublicAgentError.from_exception(error).code == "permission_denied"
