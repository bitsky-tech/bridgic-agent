from typing import Any, Callable, Dict, Optional

from bridgic.llms.openai import OpenAIConfiguration

from ...i18n import backend_i18n
from ....amphi_store import User
from ._codex_credentials import resolve_codex_credentials
from .anthropic_llm import AnthropicConfiguration, AnthropicLlm
from .codex_llm import CodexConfiguration, CodexResponsesLlm
from .google_llm import GoogleConfiguration, GoogleLlm
from .openai_llm import OpenAICompatLlm

# ----------------------------------------------------------------------
# Provider construction — Registry + Strategy
# ----------------------------------------------------------------------
#
# ``build_llm`` dispatches by ``user.protocol`` through a registry of per-protocol
# builder Strategies (``_PROVIDER_BUILDERS``) instead of an if/else chain. Adding a
# provider is a single table entry; an unknown protocol falls to the OpenAI-compat
# default so a typo in the protocol field never 500s the whole chat path. Future
# per-protocol behaviour (reasoning carrier, usage normalizer, …) can hang off the
# same registry without touching the dispatcher.
#
# NOTE: the builders live in THIS module on purpose — ``_build_codex`` references
# the module-level ``resolve_codex_credentials``, and the factory tests inject fake
# credentials via ``monkeypatch.setattr(_factory, "resolve_codex_credentials", …)``,
# which only takes effect for a same-module reference.


def _require_api_key(user: User) -> None:
    """The credential gate shared by every api_key channel (Codex goes through OAuth and
    does not pass this gate).

    Handler code should call ``BaseHandler.require_ai(user)`` upstream to 503
    cleanly before reaching here; this exception is a defensive backstop.
    """
    if not user.api_key:
        raise ValueError(
            f"No API key configured for user {user.id!r}. "
            "Configure and activate a provider in the product before retrying."
        )


def build_codex_llm(model: str, user_id: str = "", temperature: float = 0.0, api_base: Optional[str] = None) -> CodexResponsesLlm:
    """Build a Codex client from the authorized local ChatGPT credentials.

    ``generate_image`` also uses this constructor when ChatGPT Auth is an
    enabled fallback but the current conversation runs on another provider.
    Keeping credential resolution here preserves the same refresh and request
    behavior as the primary Codex chat path.
    """
    creds = resolve_codex_credentials()
    if creds is None:
        raise ValueError(backend_i18n.text(
            "llm.codex_credentials_missing",
            user_id=user_id,
        ))
    return CodexResponsesLlm(
        access_token=creds.access_token,
        account_id=creds.account_id,
        configuration=CodexConfiguration(
            model=model, temperature=temperature,
        ),
        api_base=api_base or None,
        # Re-resolve (and auto-refresh) creds per request so this cached client
        # never sends an expired access token; also drives the 401 force-refresh.
        credential_provider=resolve_codex_credentials,
    )


def _build_codex(user: User, model: str) -> Any:
    # Codex (ChatGPT subscription) = OAuth-only; the credentials live in
    # ~/.codex/auth.json, not on the User row. Resolve (+ refresh) them before the
    # api_key gate, because a Codex user legitimately has no api_key.
    return build_codex_llm(
        model,
        user_id=user.id,
        temperature=user.default_temperature,
        api_base=user.base_url,
    )


def _build_anthropic(user: User, model: str) -> Any:
    _require_api_key(user)
    return AnthropicLlm(
        api_key=user.api_key,
        api_base=user.base_url,
        configuration=AnthropicConfiguration(
            model=model, temperature=user.default_temperature, max_tokens=None,
        ),
    )


def _build_google(user: User, model: str) -> Any:
    # Gemini goes through the native google-genai SDK (not the OpenAI-compat shim)
    # so thought_signatures round-trip. An empty base_url lets the SDK default.
    _require_api_key(user)
    return GoogleLlm(
        api_key=user.api_key,
        api_base=user.base_url,
        configuration=GoogleConfiguration(
            model=model, temperature=user.default_temperature, max_tokens=None,
        ),
    )


def _build_openai_compat(user: User, model: str) -> Any:
    # Default: OpenAI Chat Completions wire (OpenAI + all OpenAI-compat services).
    _require_api_key(user)
    return OpenAICompatLlm(
        api_key=user.api_key,
        api_base=user.base_url,
        configuration=OpenAIConfiguration(
            model=model, temperature=user.default_temperature, max_tokens=None,
        ),
    )


# protocol → construction Strategy. An unknown protocol falls back to the default
# (OpenAI-compat).
_PROVIDER_BUILDERS: Dict[str, Callable[[User, str], Any]] = {
    "openai-codex": _build_codex,
    "anthropic": _build_anthropic,
    "google": _build_google,
}
_DEFAULT_BUILDER: Callable[[User, str], Any] = _build_openai_compat


def build_llm(user: User, model: str) -> Any:
    """Build an LLM client for ``(user, model)``, dispatched by ``user.protocol``.

    Pulls credentials + provider preferences off the :class:`User` row. ``model``
    is passed separately because a session may use a different model than the
    user's currently-selected one (e.g. during a model switch).

    Returns a provider-specific live handle (``OpenAICompatLlm`` / ``AnthropicLlm``
    / ``GoogleLlm`` / ``CodexResponsesLlm``) ready for streaming + tool-calling;
    callers that unwrap the inner client (the agent's ``thinking()``) MUST branch
    on ``user.protocol`` first, because each native client surfaces a different
    streaming + tool-calling API.

    Raises
    ------
    ValueError
        When an api_key channel has no ``user.api_key``, or a Codex user has no
        ~/.codex credentials.
    """
    builder = _PROVIDER_BUILDERS.get(user.protocol, _DEFAULT_BUILDER)
    return builder(user, model)


__all__ = ["build_codex_llm", "build_llm"]
