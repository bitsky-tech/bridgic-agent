from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from src.amphi_agent._error import (
    AgentEmptyAnswerError,
    AgentException,
    ContextWindowExceededError,
    PublicAgentError,
)
from src.amphi_service.i18n import backend_i18n, use_locale
from src.amphi_service.protocol.llms._codex_credentials import CodexAuthError
from src.amphi_service.protocol.llms._streaming import ModelNotFoundError


class ProviderError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


def test_agent_empty_answer_has_a_specific_safe_public_error() -> None:
    error = AgentEmptyAnswerError(recovery_attempts=3)

    public = PublicAgentError.from_exception(error)

    assert isinstance(error, AgentException)
    assert error.recovery_attempts == 3
    assert public == PublicAgentError(
        code="empty_answer",
        message="Sorry, no response was generated for this task. Run it again, or try another model if it still produces no response.",
        retryable=True,
        action="retry",
    )
    assert str(error) not in public.message


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
        message="This conversation has too much content for the current model. Shorten it or start a new conversation and try again.",
        retryable=False,
        action="new_session",
    )
    assert "WorkflowThink" not in public.message
    assert "sk-private" not in public.message
    assert "upstream_error" not in public.message


def test_preflight_context_limit_uses_the_same_public_error() -> None:
    public = PublicAgentError.from_exception(ContextWindowExceededError(120_000, 100_000))

    assert public.code == "context_too_large"
    assert public.retryable is False
    assert public.action == "new_session"


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


def test_codex_auth_uses_a_plain_message_without_exposing_internal_details() -> None:
    error = CodexAuthError(
        "HTTP 401: refresh_token_reused at https://auth.internal.invalid",
        code="codex_auth_expired",
        relogin_required=True,
    )

    public = PublicAgentError.from_exception(error)

    assert public == PublicAgentError(
        code="codex_auth_expired",
        message="The selected model's sign-in has expired. Sign in again and try again.",
        retryable=False,
        action="relogin",
    )
    assert str(error) not in public.message


def test_known_model_not_found_error_uses_the_plain_public_message() -> None:
    error = ModelNotFoundError("Model ID 'vendor-internal-v7' returned model-not-found / 404")

    public = PublicAgentError.from_exception(error)

    assert public == PublicAgentError(
        code="model_not_found",
        message="The selected model cannot be used right now. Choose another model in settings and try again.",
        retryable=False,
        action="open_model_settings",
    )
    assert str(error) not in public.message


def test_public_messages_follow_the_active_locale() -> None:
    with use_locale("en"):
        public = PublicAgentError.from_exception(ProviderError("rate limit", status_code=429))

    assert public.message == "The service is busy right now. Please try again later."


def test_all_localized_agent_errors_avoid_internal_jargon() -> None:
    message_ids = (
        "agent.error.context_too_large",
        "agent.error.empty_answer",
        "agent.error.model_not_found",
        "agent.error.quota_exhausted",
        "agent.error.rate_limited",
        "agent.error.authentication_failed",
        "agent.error.login_required",
        "agent.error.content_rejected",
        "agent.error.permission_denied",
        "agent.error.model_or_endpoint_not_found",
        "agent.error.request_rejected",
        "agent.error.stream_interrupted",
        "agent.error.request_timeout",
        "agent.error.network_unreachable",
        "agent.error.provider_unavailable",
        "agent.error.trace_too_large",
        "agent.error.internal",
    )
    forbidden_zh = ("Agent", "API Key", "Base URL", "HTTP", "上下文", "供应商", "认证", "模型 ID", "流式")
    forbidden_en = ("Agent", "API key", "Base URL", "HTTP", "context limit", "provider", "authentication", "endpoint", "stream")

    for message_id in message_ids:
        zh = backend_i18n.text(message_id, locale="zh")
        en = backend_i18n.text(message_id, locale="en")
        assert not any(term in zh for term in forbidden_zh), message_id
        assert not any(term in en for term in forbidden_en), message_id


def test_http_status_can_be_read_from_the_sdk_response() -> None:
    error = RuntimeError("opaque provider failure")
    error.response = SimpleNamespace(status_code=403)  # type: ignore[attr-defined]

    assert PublicAgentError.from_exception(error).code == "permission_denied"
