"""Safe, user-facing classification for terminal Agent failures."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, ClassVar, Iterable, Literal, Optional

from ..amphi_service.i18n import backend_i18n
from ..amphi_service.protocol.llms._codex_credentials import CodexAuthError
from ..amphi_service.protocol.llms._streaming import (
    ModelNotFoundError,
    is_daily_quota_error,
    is_incomplete_stream_error,
    is_model_not_found_error,
    is_rate_limit_error,
    is_retryable_transport_error,
    is_transient_server_error,
)


AgentErrorAction = Literal[
    "edit_input",
    "new_session",
    "open_model_settings",
    "relogin",
    "retry",
    "switch_model",
]


class AgentException(RuntimeError):
    """Base class for recognized failures produced by the Agent runtime."""


class AgentEmptyAnswerError(AgentException):
    """Raised when recovery attempts still produce no user-visible answer."""

    def __init__(self, recovery_attempts: int) -> None:
        self.recovery_attempts = recovery_attempts
        super().__init__(
            "Agent produced an empty final answer after "
            f"{recovery_attempts} recovery attempts"
        )


@dataclass(frozen=True)
class PublicAgentError:
    """A safe public failure and the factory that classifies internal errors."""

    code: str
    message: str
    retryable: bool
    action: Optional[AgentErrorAction] = None

    _CONTEXT_CODES: ClassVar[frozenset[str]] = frozenset({
        "context_length_exceeded",
        "context_window_exceeded",
        "input_too_long",
        "max_tokens_exceeded",
        "prompt_too_long",
    })
    _CONTEXT_MARKERS: ClassVar[tuple[str, ...]] = (
        "context length exceeded",
        "context window",
        "exceed context limit",
        "exceeds the context",
        "input is too long",
        "input token count exceeds",
        "maximum context length",
        "prompt is too long",
        "too many input tokens",
        "too many tokens",
    )
    _QUOTA_CODES: ClassVar[frozenset[str]] = frozenset({
        "billing_hard_limit_reached",
        "credits_exhausted",
        "insufficient_quota",
        "quota_exceeded",
    })
    _QUOTA_MARKERS: ClassVar[tuple[str, ...]] = (
        "billing hard limit",
        "credit balance",
        "credits exhausted",
        "insufficient quota",
        "quota exceeded",
    )
    _AUTH_CODES: ClassVar[frozenset[str]] = frozenset({
        "authentication_error",
        "invalid_api_key",
        "invalid_authentication",
        "unauthorized",
    })
    _PERMISSION_CODES: ClassVar[frozenset[str]] = frozenset({
        "access_denied",
        "forbidden",
        "permission_denied",
    })
    _CONTENT_CODES: ClassVar[frozenset[str]] = frozenset({
        "content_filter",
        "content_policy_violation",
        "moderation_blocked",
        "safety_rejected",
    })
    _CONTENT_MARKERS: ClassVar[tuple[str, ...]] = (
        "blocked by content filtering",
        "content filter",
        "content policy",
        "moderation blocked",
        "safety policy",
    )

    @classmethod
    def from_exception(cls, exc: BaseException) -> "PublicAgentError":
        """Create one bounded, localized public failure from any exception."""
        chain = tuple(cls._exception_chain(exc))
        errors = tuple(item for item in chain if isinstance(item, Exception))

        if any(isinstance(item, AgentEmptyAnswerError) for item in errors):
            return cls._localized("empty_answer", "agent.error.empty_answer", True, "retry")

        codex_auth = next((item for item in errors if isinstance(item, CodexAuthError)), None)
        if codex_auth is not None:
            return cls(
                code=codex_auth.code,
                message=str(codex_auth),
                retryable=not codex_auth.relogin_required,
                action="relogin" if codex_auth.relogin_required else "retry",
            )

        if cls._has_code(errors, cls._CONTEXT_CODES) or cls._has_marker(errors, cls._CONTEXT_MARKERS):
            return cls._localized("context_too_large", "agent.error.context_too_large", False, "new_session")

        if cls._matches(errors, is_model_not_found_error):
            known = next((item for item in errors if isinstance(item, ModelNotFoundError)), None)
            if known is not None and str(known).strip():
                return cls(
                    code="model_not_found",
                    message=str(known).strip(),
                    retryable=False,
                    action="open_model_settings",
                )
            return cls._localized("model_not_found", "agent.error.model_not_found", False, "open_model_settings")

        if (
            cls._matches(errors, is_daily_quota_error)
            or cls._has_code(errors, cls._QUOTA_CODES)
            or cls._has_marker(errors, cls._QUOTA_MARKERS)
        ):
            return cls._localized("quota_exhausted", "agent.error.quota_exhausted", False, "switch_model")

        if cls._matches(errors, is_rate_limit_error):
            return cls._localized("rate_limited", "agent.error.rate_limited", True, "retry")

        statuses = {cls._status_of(item) for item in errors}
        statuses.discard(None)
        if 401 in statuses or cls._has_code(errors, cls._AUTH_CODES):
            return cls._localized("authentication_failed", "agent.error.authentication_failed", False, "open_model_settings")

        if cls._has_code(errors, cls._CONTENT_CODES) or cls._has_marker(errors, cls._CONTENT_MARKERS):
            return cls._localized("content_rejected", "agent.error.content_rejected", False, "edit_input")

        if 403 in statuses or cls._has_code(errors, cls._PERMISSION_CODES):
            return cls._localized("permission_denied", "agent.error.permission_denied", False, "switch_model")

        if 404 in statuses:
            return cls._localized(
                "model_or_endpoint_not_found",
                "agent.error.model_or_endpoint_not_found",
                False,
                "open_model_settings",
            )

        if any(isinstance(status, int) and 400 <= status < 500 for status in statuses):
            return cls._localized("request_rejected", "agent.error.request_rejected", False, "edit_input")

        if is_incomplete_stream_error(exc):
            return cls._localized("stream_interrupted", "agent.error.stream_interrupted", True, "retry")

        if any(isinstance(item, TimeoutError) or "timeout" in type(item).__name__.lower() for item in chain):
            return cls._localized("request_timeout", "agent.error.request_timeout", True, "retry")

        if is_retryable_transport_error(exc):
            return cls._localized("network_unreachable", "agent.error.network_unreachable", True, "retry")

        if cls._matches(errors, is_transient_server_error) or any(
            isinstance(status, int) and status >= 500 for status in statuses
        ):
            return cls._localized("provider_unavailable", "agent.error.provider_unavailable", True, "retry")

        if any(type(item).__name__ == "InvocationTraceLimitError" for item in chain):
            return cls._localized("trace_too_large", "agent.error.trace_too_large", False, "edit_input")

        return cls._localized("internal_error", "agent.error.internal", True, "retry")

    @staticmethod
    def _exception_chain(exc: BaseException) -> Iterable[BaseException]:
        """Yield wrapper, cause, context, SDK original, and grouped errors once."""
        pending = [exc]
        seen: set[int] = set()
        while pending:
            current = pending.pop()
            if id(current) in seen:
                continue
            seen.add(id(current))
            yield current

            nested = getattr(current, "exceptions", ())
            if isinstance(nested, (list, tuple)):
                pending.extend(reversed([
                    item for item in nested if isinstance(item, BaseException)
                ]))
            original = getattr(current, "original_exception", None)
            if isinstance(original, BaseException):
                pending.append(original)
            if current.__context__ is not None:
                pending.append(current.__context__)
            if current.__cause__ is not None:
                pending.append(current.__cause__)

    @staticmethod
    def _status_of(exc: BaseException) -> Optional[int]:
        for attr in ("status_code", "status"):
            value = getattr(exc, attr, None)
            if isinstance(value, int):
                return value
        code = getattr(exc, "code", None)
        if isinstance(code, int):
            return code
        response = getattr(exc, "response", None)
        value = getattr(response, "status_code", None)
        return value if isinstance(value, int) else None

    @staticmethod
    def _codes_of(exc: BaseException) -> set[str]:
        codes: set[str] = set()
        for attr in ("code", "type"):
            value = getattr(exc, attr, None)
            if isinstance(value, str) and value:
                codes.add(value.lower())
        for attr in ("body", "error"):
            value = getattr(exc, attr, None)
            if not isinstance(value, dict):
                continue
            nested = value.get("error")
            if isinstance(nested, dict):
                value = nested
            for key in ("code", "type"):
                item = value.get(key)
                if isinstance(item, str) and item:
                    codes.add(item.lower())
        return codes

    @staticmethod
    def _matches(errors: tuple[Exception, ...], predicate: Callable[[Exception], bool]) -> bool:
        for error in errors:
            try:
                if predicate(error):
                    return True
            except Exception:
                continue
        return False

    @staticmethod
    def _has_marker(errors: tuple[Exception, ...], markers: tuple[str, ...]) -> bool:
        return any(
            marker in str(error).lower()
            for error in errors
            for marker in markers
        )

    @classmethod
    def _has_code(cls, errors: tuple[Exception, ...], codes: frozenset[str]) -> bool:
        return any(cls._codes_of(error) & codes for error in errors)

    @classmethod
    def _localized(cls, code: str, message_id: str, retryable: bool, action: Optional[AgentErrorAction]) -> "PublicAgentError":
        return cls(
            code=code,
            message=backend_i18n.text(message_id),
            retryable=retryable,
            action=action,
        )


__all__ = [
    "AgentEmptyAnswerError",
    "AgentErrorAction",
    "AgentException",
    "PublicAgentError",
]
