import asyncio
import json
import logging
import secrets
import threading
import time
from typing import Any, Dict, List, Optional

import httpx
from fastapi import HTTPException, Response, status

from ..protocol import (
    PROVIDER_CATALOG_BY_ID,
    AddProviderRequest,
    FetchModelsRequest,
    SetActiveModelRequest,
    TestProviderRequest,
    ToggleProviderRequest,
    visible_catalog,
)
from ..protocol.llms._codex_credentials import (
    CodexAuthError,
    peek_codex_local,
    resolve_codex_credentials,
)
from ..protocol.llms._codex_oauth import (
    CodexCallbackServer,
    build_authorize_url,
    exchange_code,
    generate_pkce,
    persist_codex_tokens,
)
from ..protocol.llms.codex_llm import CODEX_CATALOG_MODELS, DEFAULT_CODEX_MODEL
from ..protocol.llms._openai_params import is_kimi_code_endpoint
from ..cache import LlmCache
from ..i18n import backend_i18n
from ...amphi_store import (
    ProviderCredential,
    ProviderRepository,
    UserRepository,
)
from ._base import BaseHandler
from ._me_handler import me_profile


# Mappers + shared credential-sync helper.
def _resolve_protocol(provider_id: str, fallback: str) -> str:
    """A known catalog provider's protocol is AUTHORITATIVE.

    The catalog declares each built-in channel's wire protocol (e.g. ``google``
    → native Gemini, ``anthropic`` → Messages API). But the GUI's channel form
    only models ``'openai' | 'anthropic'`` and posts ``'openai'`` for everything
    else — so a Google channel arrives as ``protocol='openai'`` and, trusted
    verbatim, routes through the OpenAI-compat path that drops Gemini
    thought_signatures (→ 400 on multi-step tool calls). For catalog ids we use
    the catalog's protocol; a custom slug (not in the catalog) keeps the posted
    value so arbitrary OpenAI-/Anthropic-compat endpoints still work.
    """
    entry = PROVIDER_CATALOG_BY_ID.get(provider_id)
    return entry["protocol"] if entry else fallback


def _configured(cred: ProviderCredential) -> dict:
    """Map a stored credential to its wire view (api_key never echoed).

    Phase-2 wire shape: includes ``protocol`` / ``display_name`` /
    ``available_models``. The model list now reflects the user's
    whitelist (``enabled_models`` column) rather than being catalog-derived;
    no entry → empty list (picker won't show it).
    """
    models = cred.enabled_models if isinstance(cred.enabled_models, list) else []
    return {
        "id": cred.provider_id,
        "auth_mode": cred.auth_mode,
        "api_key_set": bool(cred.api_key),
        "base_url": cred.base_url,
        "is_active": cred.is_active,
        "is_enabled": cred.is_enabled,
        "protocol": cred.protocol,
        "display_name": cred.display_name,
        "available_models": models,
    }


async def _sync_user_credentials(
    llms: LlmCache,
    user_id: str,
    *,
    api_key,
    base_url,
    protocol: str = "openai",
    model=None,
) -> None:
    """Mirror the active provider's creds onto the User row + drop LLM cache.

    Keeps the chat path (``build_llm`` reads ``User.api_key`` /
    ``base_url`` / ``User.protocol``) consistent with the active
    provider. Overwrites unconditionally (incl. clearing to ``None``);
    ``model`` is set only when provided (the active-model switch path).

    ``protocol`` defaults to ``"openai"`` so the delete-active path
    (which passes None creds) resets dispatch to the historical default
    and prevents ``build_llm`` from trying Anthropic with no key on the
    next chat attempt.
    """
    updated = await UserRepository().set_active_provider(
        user_id,
        api_key=api_key,
        base_url=base_url,
        protocol=protocol,
        model=model,
    )
    if updated is None:
        return
    await llms.invalidate_user(user_id)


async def _promote_next_active(
    llms: LlmCache, user_id: str, *, exclude_provider_id: str,
) -> bool:
    """Promote the next usable channel to active after the current active one
    is removed or disabled; return ``True`` if one was promoted.

    Mirrors the promoted provider's creds + protocol onto the User row AND
    resets ``current_model`` to its first whitelisted model. The model reset
    matters: the chat picker's ``activeModelAtom`` needs a matching
    ``(active provider, current_model)`` pair — leaving ``current_model`` on
    the just-removed provider's model id would make the GUI show
    the "configure a model first" notice even though a channel is active.
    Returns ``False`` when no
    enabled, key-bearing provider remains (caller then clears the mirror).
    """
    promoted = await ProviderRepository().first_enabled_other(
        user_id, exclude_provider_id=exclude_provider_id,
    )
    if promoted is None:
        return False
    activated = await ProviderRepository().set_active(user_id, promoted.provider_id)
    if activated is None:
        return False
    try:
        enabled = activated.enabled_models
        if isinstance(enabled, list):
            models = enabled
        elif isinstance(enabled, str):
            models = json.loads(enabled or "[]")
        else:
            models = []
        first_model = models[0] if isinstance(models, list) and models else None
    except (ValueError, TypeError):
        first_model = None
    await _sync_user_credentials(
        llms,
        user_id,
        api_key=activated.api_key,
        base_url=activated.base_url,
        protocol=activated.protocol,
        model=first_model,
    )
    return True


class ProvidersCatalogHandler(BaseHandler):
    """Bind: ``GET /providers`` — the static provider/model catalog."""

    tags = ["providers"]

    async def get(self) -> Response:
        return self.response(visible_catalog())


class MeProvidersHandler(BaseHandler):
    """Bind: ``GET /me/providers`` (list), ``POST /me/providers`` (upsert)."""

    tags = ["providers"]

    async def get(self) -> Response:
        user = await self.require_user()
        creds = await ProviderRepository().list_for_user(user.id)
        return self.response([_configured(c) for c in creds])

    async def post(self, body: AddProviderRequest) -> Response:
        # Phase-2: catalog membership is NOT a precondition anymore — users
        # can wire any OpenAI-compat or Anthropic-compat endpoint by giving
        # it a slug. The catalog at GET /providers is now a UI prefill source.
        user = await self.require_user()
        cred = await ProviderRepository().upsert(
            user.id,
            body.provider_id,
            auth_mode=body.auth_mode,
            api_key=body.api_key,
            base_url=body.base_url,
            protocol=_resolve_protocol(body.provider_id, body.protocol),
            display_name=body.display_name,
            models=body.models,
        )
        # First usable (api_key) provider auto-activates and mirrors its
        # creds onto the User row so chat works without a separate step.
        existing = await ProviderRepository().list_for_user(user.id)
        if not any(c.is_active for c in existing) and cred.api_key:
            cred = await ProviderRepository().set_active(user.id, cred.provider_id)
            await _sync_user_credentials(
                self.llms,
                user.id,
                api_key=cred.api_key,
                base_url=cred.base_url,
                protocol=cred.protocol,
            )
        return self.response(_configured(cred), status_code=status.HTTP_201_CREATED)


class MeProviderItemHandler(BaseHandler):
    """Bind: ``DELETE /me/providers/{provider_id}``."""

    tags = ["providers"]

    async def delete(self, provider_id: str) -> Response:
        user = await self.require_user()
        was_active = await ProviderRepository().delete(user.id, provider_id)
        if was_active is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Provider {provider_id!r} is not configured.",
            )
        # Removing the active provider: promote the next usable channel so the
        # user isn't stranded on "configure a model first" when others remain.
        # Only when
        # none qualifies do we clear the mirrored creds (so a stale, just-
        # deleted key is never used by the next chat).
        if was_active and not await _promote_next_active(
            self.llms, user.id, exclude_provider_id=provider_id,
        ):
            await _sync_user_credentials(
                self.llms, user.id, api_key=None, base_url=None,
            )
        return self.response(status_code=status.HTTP_204_NO_CONTENT)


# TODO: Delete MeActiveModelHandler in future. No need.
class MeActiveModelHandler(BaseHandler):
    """Bind: ``POST /me/active-model`` — activate a provider+model."""

    tags = ["providers"]

    async def post(self, body: SetActiveModelRequest) -> Response:
        user = await self.require_user()
        activated = await ProviderRepository().set_active(user.id, body.provider_id)
        if activated is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Provider {body.provider_id!r} is not configured; "
                "POST /me/providers first.",
            )
        await _sync_user_credentials(
            self.llms,
            user.id,
            api_key=activated.api_key,
            base_url=activated.base_url,
            protocol=activated.protocol,
            model=body.model,
        )
        refreshed = await self.require_user()
        return self.response(me_profile(refreshed))


class MeProviderTestHandler(BaseHandler):
    """Bind: ``POST /me/providers/test`` — probe credentials without saving.

    Lets the GUI verify that a typed-but-unsaved ``(protocol, base_url,
    api_key, model)`` tuple actually reaches the provider before the user
    commits. Kimi Coding verifies auth against its fast ``/models`` endpoint;
    other providers build a one-shot LLM client (NOT cached, NOT mirrored to
    the User row) and fire a 1-token chat. Both return a
    ``{ok, latency_ms}`` / ``{ok, error}`` envelope.

    Always returns 200 so the client only has to read ``ok`` — keeps the
    JS fetch flow simple (no try/catch wrapper around 4xx). Real network
    / framework failures bubble up as 500 still (deliberate: those
    indicate a daemon-side bug, not a credential problem).
    """

    tags = ["providers"]

    async def post(self, body: TestProviderRequest) -> Response:
        await self.require_user()  # 401 if anon (kept for future auth)
        import time
        # Lazy import to keep the handler module light at startup;
        # bridgic.llms.openai's pydantic models can be slow to load.
        from bridgic.core.model.types import Message, Role
        from bridgic.llms.openai import OpenAIConfiguration

        from ..protocol.llms.anthropic_llm import (
            AnthropicConfiguration,
            AnthropicLlm,
        )
        from ..protocol.llms.google_llm import GoogleConfiguration, GoogleLlm
        from ..protocol.llms.openai_llm import OpenAICompatLlm

        if not body.api_key.strip():
            return self.response({
                "ok": False,
                "error": backend_i18n.text("provider.api_key_required"),
            })

        # Probe the SAME protocol the channel will actually use — a catalog id's
        # protocol is authoritative (see ``_resolve_protocol``), so testing a
        # Google channel exercises the native Gemini path, not OpenAI-compat.
        protocol = _resolve_protocol(body.provider_id, body.protocol)
        if protocol == "openai" and (
            body.provider_id == "kimi" or is_kimi_code_endpoint(body.base_url)
        ):
            return self.response(await self._probe_kimi_code(body))

        # Build a one-shot client. Note: we DON'T go through ``build_llm``
        # (which reads from User row) — body is the source of truth here.
        try:
            if protocol == "anthropic":
                llm = AnthropicLlm(
                    api_key=body.api_key,
                    api_base=body.base_url or None,
                    configuration=AnthropicConfiguration(
                        model=body.model,
                        temperature=0.0,
                        # 1 token cap — keeps the probe cheap. Anthropic requires
                        # max_tokens, and the probe never enables thinking, so one
                        # token always completes.
                        max_tokens=1,
                    ),
                )
            elif protocol == "google":
                llm = GoogleLlm(
                    api_key=body.api_key,
                    api_base=body.base_url or None,
                    configuration=GoogleConfiguration(
                        model=body.model,
                        temperature=0.0,
                        max_tokens=1,
                    ),
                )
            else:
                llm = OpenAICompatLlm(
                    api_key=body.api_key,
                    api_base=body.base_url or None,
                    configuration=OpenAIConfiguration(
                        model=body.model,
                        temperature=0.0,
                        # No token cap: reasoning models (gpt-5.x / o-series) spend
                        # the budget on reasoning first, so a 1-token cap 400s with
                        # "Could not finish the message ..." on every strict
                        # upstream. A "ping" reply is short — no cap stays cheap.
                        max_tokens=None,
                    ),
                )
        except Exception as exc:  # noqa: BLE001 — surface ctor errors to UI
            return self.response({
                "ok": False,
                "error": backend_i18n.text("provider.client_construct_failed", detail=exc),
            })

        # The probe itself. Single-message chat; we don't interpret the
        # reply — any non-exception return means the provider accepted the
        # auth + reached the model.
        probe = [Message.from_text("ping", role=Role.USER)]
        started = time.perf_counter()
        try:
            await asyncio.wait_for(
                llm.achat(probe),
                timeout=_PROVIDER_PROBE_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            return self.response({
                "ok": False,
                "error": backend_i18n.text(
                    "provider.response_timeout", seconds=_PROVIDER_PROBE_TIMEOUT_SECONDS,
                ),
            })
        except Exception as exc:  # noqa: BLE001
            return self.response({
                "ok": False,
                "error": _probe_error_message(exc),
            })
        latency_ms = int((time.perf_counter() - started) * 1000)
        return self.response({"ok": True, "latency_ms": latency_ms})

    async def _probe_kimi_code(self, body: TestProviderRequest) -> Dict[str, Any]:
        """Verify Kimi Coding connectivity and credentials without model generation."""
        url, headers, params = _models_request("openai", body.api_key, body.base_url)
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(_PROVIDER_PROBE_TIMEOUT_SECONDS),
                follow_redirects=True,
            ) as client:
                response = await client.get(url, headers=headers, params=params)
        except httpx.TimeoutException:
            return {
                "ok": False,
                "error": backend_i18n.text(
                    "provider.response_timeout", seconds=_PROVIDER_PROBE_TIMEOUT_SECONDS,
                ),
            }
        except Exception as exc:  # noqa: BLE001
            detail = str(exc)[:200] or type(exc).__name__
            if body.api_key:
                detail = detail.replace(body.api_key, "***")
            return {
                "ok": False,
                "error": backend_i18n.text("provider.network_unreachable", detail=detail),
            }
        if response.status_code >= 400:
            return {
                "ok": False,
                "error": _fetch_error_message(response.status_code, response.text, body.api_key),
            }
        return {
            "ok": True,
            "latency_ms": int((time.perf_counter() - started) * 1000),
        }


_PROVIDER_PROBE_TIMEOUT_SECONDS = 12.0

# Shared by both "test connection" and "fetch from provider": the single
# misconfiguration that
# reaches each of them through a different (and equally unreadable) exception.
#
# Gateways that front their API with a console SPA answer EVERY unmatched path
# with 200 + text/html rather than 404, so a base_url missing its version
# segment gets an HTML page where JSON is expected — and sails past every
# status-code check we have. Name the cause and the fix; the underlying
# JSONDecodeError / AttributeError points the user nowhere near their typo.
def _non_json_endpoint_error() -> str:
    """Resolve this display text at request time, never at module import time."""
    return backend_i18n.text("provider.non_json_endpoint")


def _probe_error_message(exc: Exception) -> str:
    """Surface a short, user-friendly message for common provider errors.

    The Anthropic / OpenAI SDKs raise their own exception classes
    (``AuthenticationError`` / ``NotFoundError`` / ``APIConnectionError`` …)
    — we string-match the class name so this module doesn't have to import
    both SDKs' error hierarchies. Falls back to the raw message for the
    long tail; the GUI can show it verbatim.

    bridgic's ``retryable_model_call`` decorator wraps the real provider error
    in ``ModelUnrecoverableError`` / ``ModelRetryLimitError``, whose ``str()``
    is a generic "failed with non-recoverable error" / "exceeded retry
    attempts" — the actual cause lives on ``.original_exception``. Unwrap it
    first so the heuristics below see the real SDK error (401/404/connection)
    instead of the opaque wrapper text.
    """
    original = getattr(exc, "original_exception", None)
    if original is not None:
        exc = original
    name = type(exc).__name__
    msg = str(exc) or name
    # No SDK error is raised when the endpoint answers with a non-JSON
    # Content-Type: openai's ``_legacy_response`` deliberately hands back
    # ``response.text`` unparsed, so the str reaches bridgic's
    # ``response.choices[0]`` and dies there. Exact-type + str-receiver match,
    # so an unrelated AttributeError (a real daemon bug) still surfaces raw.
    if isinstance(exc, AttributeError) and "'str' object has no attribute" in msg:
        return _non_json_endpoint_error()
    if "Authentication" in name or "401" in msg:
        return backend_i18n.text("provider.authentication_failed", status_code=401)
    if "NotFound" in name or "404" in msg:
        return backend_i18n.text("provider.model_or_endpoint_not_found")
    if "Connection" in name or "Timeout" in name:
        return backend_i18n.text("provider.network_unreachable", detail=msg[:200])
    return msg[:300]


# --- Model listing (``POST /me/providers/fetch-models``) ---------------------
#
# 20s, matching the Codex httpx clients in this package. The renderer's own
# fetch aborts at 30s (REQUEST_TIMEOUT_MS), so we must fail first — otherwise
# the user sees a generic client-side abort instead of our error message.
_FETCH_MODELS_TIMEOUT = httpx.Timeout(20.0)
_ANTHROPIC_VERSION = "2023-06-01"
_ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com"
_GOOGLE_DEFAULT_BASE = "https://generativelanguage.googleapis.com"


def _models_endpoint(protocol: str, base_url: Optional[str]) -> str:
    """Derive a provider's model-listing URL from the channel's base_url.

    Users paste either a root (``https://api.openai.com/v1``) or a full chat
    endpoint (``…/v1/chat/completions``) — the GUI's ``normalizeBaseUrl`` strips
    the latter, but the daemon is also reachable from other API clients, so the
    same tolerance is repeated here rather than assumed.
    """
    base = (base_url or "").strip().rstrip("/")
    if protocol == "anthropic":
        base = base or _ANTHROPIC_DEFAULT_BASE
        # Anthropic nests under /v1; accept root, /v1, and /v1/messages alike.
        for suffix in ("/v1/messages", "/v1"):
            if base.endswith(suffix):
                base = base[: -len(suffix)]
                break
        return f"{base}/v1/models"
    if protocol == "google":
        base = base or _GOOGLE_DEFAULT_BASE
        # Gemini's REST API requires an explicit version segment — dropping it
        # 404s (verified against the live endpoint). Unlike OpenAI-compat, the
        # catalog's default_base_url carries no version, and it must not: that
        # same value is handed to the google-genai SDK for chat, which appends
        # its own version segment.
        #
        # But users do paste the versioned root (it's what Google's own docs
        # show), so strip an existing version before appending — otherwise we
        # build `…/v1beta/v1beta/models` and 404 on a perfectly good base_url.
        for suffix in ("/v1beta", "/v1"):
            if base.endswith(suffix):
                base = base[: -len(suffix)]
                break
        return f"{base}/v1beta/models"
    # OpenAI-compat: base_url already carries its version segment (/v1, /v4, …).
    for suffix in ("/chat/completions", "/responses"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    return f"{base}/models"


def _models_request(
    protocol: str, api_key: str, base_url: Optional[str]
) -> tuple[str, Dict[str, str], Dict[str, str]]:
    """Build ``(url, headers, params)`` for the provider's list-models call."""
    url = _models_endpoint(protocol, base_url)
    if protocol == "anthropic":
        # Send BOTH auth headers: api.anthropic.com wants x-api-key, while
        # third-party Anthropic-compat gateways commonly only read Bearer.
        return url, {
            "x-api-key": api_key,
            "authorization": f"Bearer {api_key}",
            "anthropic-version": _ANTHROPIC_VERSION,
        }, {}
    if protocol == "google":
        # Gemini takes the key as a query param, not a header.
        return url, {}, {"key": api_key}
    return url, {"authorization": f"Bearer {api_key}"}, {}


def _parse_models(protocol: str, payload: Any) -> List[Dict[str, str]]:
    """Normalize a provider's list-models payload into ``[{id, name}]``.

    Deduplicates by id (keeping first occurrence) — some OpenAI-compat
    gateways aggregate several upstreams and repeat ids.
    """
    entries: List[Dict[str, str]] = []
    if protocol == "google":
        for m in (payload or {}).get("models") or []:
            # Filter out embedding / tuning-only models — they'd break chat.
            if "generateContent" not in (m.get("supportedGenerationMethods") or []):
                continue
            raw = str(m.get("name") or "")
            model_id = raw[len("models/"):] if raw.startswith("models/") else raw
            if model_id:
                entries.append({"id": model_id, "name": m.get("displayName") or model_id})
    else:
        for m in (payload or {}).get("data") or []:
            model_id = str(m.get("id") or "")
            if model_id:
                # display_name is Anthropic-only; OpenAI-compat has no name field.
                entries.append({"id": model_id, "name": m.get("display_name") or model_id})
        if protocol != "anthropic":
            # OpenAI-compat returns an arbitrary order and often 100+ entries;
            # Anthropic/Google already come newest-first, so leave those alone.
            entries.sort(key=lambda e: e["id"])
    deduped: Dict[str, Dict[str, str]] = {}
    for e in entries:
        deduped.setdefault(e["id"], e)
    return list(deduped.values())


def _fetch_error_message(status_code: int, body: str, api_key: str) -> str:
    """User-facing message for a non-2xx list-models response.

    The body is echoed (truncated) because gateway errors are often the only
    clue about a misconfigured base_url — but the key is scrubbed first, since
    some gateways reflect the Authorization header back in their error text.
    """
    # Collapse whitespace — provider errors are usually pretty-printed JSON,
    # and raw newlines wreck the single-line slot the GUI renders this in.
    detail = " ".join(body.split())[:200]

    # Classify against the UNSCRUBBED text, and scrub only what we echo back.
    # Doing it the other way round lets the redaction corrupt the very words
    # being matched — a short key like "k" rewrites "API key not valid" into
    # "API ***ey not valid" and the 400 heuristic below stops firing.
    if status_code in (401, 403):
        return backend_i18n.text("provider.authentication_failed", status_code=status_code)
    # Gemini reports a bad key as 400 INVALID_ARGUMENT, not 401 — without this
    # the user gets a wall of raw JSON for what is just a wrong key.
    if status_code == 400 and "api key" in detail.lower():
        return backend_i18n.text("provider.authentication_failed", status_code=400)
    if status_code == 404:
        return backend_i18n.text("provider.model_list_endpoint_not_found")
    if status_code == 429:
        return backend_i18n.text("provider.rate_limited")
    if api_key and api_key in detail:
        detail = detail.replace(api_key, "***")
    if detail:
        return backend_i18n.text(
            "provider.response_status", status_code=status_code, detail=detail,
        )
    return backend_i18n.text("provider.response_status_without_detail", status_code=status_code)


class MeProviderFetchModelsHandler(BaseHandler):
    """Bind: ``POST /me/providers/fetch-models`` — list a provider's models.

    Same envelope discipline as ``MeProviderTestHandler``: always 200, the
    client only reads ``ok``. Unlike "test connection" this needs no model id,
    so the GUI flow becomes: enter key → fetch list → tick models → test.

    Explicitly user-triggered and on its own endpoint — NEVER call it from an
    activation / save path. Auto-probing models during channel activation was
    already removed once (see ``_activate_codex_provider``): the extra
    cross-border round trips blew the renderer's 30s timeout on slow networks.
    """

    tags = ["providers"]

    async def post(self, body: FetchModelsRequest) -> Response:
        await self.require_user()  # 401 if anon (kept for future auth)

        # Codex FIRST, before _resolve_protocol: a Codex channel posts
        # provider_id='openai' (it attaches to that slug), and the catalog says
        # openai→'openai', so resolving would silently rewrite the protocol and
        # send us down the API-key path. Subscription channels also carry no
        # api_key, so this must precede the emptiness check too.
        if body.protocol == "openai-codex":
            # Copy the entries too, not just the outer list — a shallow list()
            # hands out references to the module-level dicts, so any downstream
            # mutation would permanently corrupt the in-process catalog.
            return self.response({"ok": True, "models": [dict(m) for m in CODEX_CATALOG_MODELS]})

        if not body.api_key.strip():
            return self.response({
                "ok": False,
                "error": backend_i18n.text("provider.api_key_required"),
            })

        # A catalog id's protocol is authoritative — a Google channel arrives
        # as protocol='openai' from the GUI form (see ``_resolve_protocol``).
        protocol = _resolve_protocol(body.provider_id, body.protocol)
        url, headers, params = _models_request(protocol, body.api_key, body.base_url)

        try:
            # follow_redirects: gateways commonly 30x (http→https, or /models →
            # /v1/models). Without it a 302 slips past the ``>= 400`` check and
            # dies in ``resp.json()``, surfacing as "cannot parse the model
            # list" — an error
            # that points the user at the wrong problem entirely.
            async with httpx.AsyncClient(
                timeout=_FETCH_MODELS_TIMEOUT, follow_redirects=True,
            ) as client:
                resp = await client.get(url, headers=headers, params=params)
        except Exception as exc:  # noqa: BLE001 — surface network errors to UI
            # Scrub here too: Google carries the key as a query param, so an
            # exception that echoes the request URL would leak it into both the
            # GUI and the daemon log. The HTTP branch below already scrubs.
            detail = str(exc)[:200] or type(exc).__name__
            if body.api_key:
                detail = detail.replace(body.api_key, "***")
            return self.response({
                "ok": False,
                "error": backend_i18n.text("provider.network_unreachable", detail=detail),
            })

        if resp.status_code >= 400:
            return self.response({
                "ok": False,
                "error": _fetch_error_message(resp.status_code, resp.text, body.api_key),
            })
        # Parse first, classify second. Content-Type is NOT the gate: some
        # self-hosted gateways serve a perfectly good list as text/plain, and
        # ``resp.json()`` never looked at the header — rejecting on it would
        # break channels that work today. The header only ever explains a body
        # that already failed to parse.
        try:
            payload = resp.json()
        except Exception:  # noqa: BLE001 — an HTML console page, not JSON
            return self.response({
                "ok": False,
                "error": _non_json_endpoint_error(),
            })
        try:
            models = _parse_models(protocol, payload)
        except Exception as exc:  # noqa: BLE001 — valid JSON, unexpected shape
            return self.response({
                "ok": False,
                "error": backend_i18n.text(
                    "provider.models_parse_failed", detail=str(exc)[:150],
                ),
            })
        if not models:
            return self.response({
                "ok": False,
                "error": backend_i18n.text("provider.empty_model_list"),
            })
        return self.response({"ok": True, "models": models})


class MeProviderApiKeyHandler(BaseHandler):
    """Bind: ``GET /me/providers/{provider_id}/api-key`` — reveal the stored key.

    The ONE endpoint that deliberately returns a plaintext api_key, so the edit
    form can prefill it (user request: "I typed that key in myself"). It is deliberately
    NOT folded into ``_configured()``: ``GET /me/providers`` is a high-traffic
    list (every settings open / hydrate), and keys have no business riding along
    on all of those. Here the key crosses the wire only when the user actually
    opens one channel's editor.

    This is the documented exception to the module's "api_key never appears in
    a response body" invariant — every OTHER view still upholds it.
    """

    tags = ["providers"]

    async def get(self, provider_id: str) -> Response:
        user = await self.require_user()
        # No repo-level get-by-id exists; a user has a handful of channels, so
        # filtering the list is cheaper than adding a method for one caller.
        creds = await ProviderRepository().list_for_user(user.id)
        cred = next((c for c in creds if c.provider_id == provider_id), None)
        if cred is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Provider {provider_id!r} is not configured.",
            )
        # OAuth/Codex channels legitimately have no key — null, not an error.
        return self.response({"api_key": cred.api_key})


class MeProviderToggleHandler(BaseHandler):
    """Bind: ``POST /me/providers/{provider_id}/toggle``.

    Flips the ``is_enabled`` flag on one provider. Body is ``{enabled: bool}``.
    The handler keeps the chat path's "active → enabled" invariant by:
      - On **disable of the active** row: clear the mirrored User-row
        credentials, then auto-promote the next enabled provider with a
        key (oldest first). If none remain, leave User row cleared and
        let the chat path return its standard 503 "no api key configured".
      - On **enable**: no automatic activation (user can switch via
        POST /me/active-model when ready).
    """

    tags = ["providers"]

    async def post(self, provider_id: str, body: ToggleProviderRequest) -> Response:
        user = await self.require_user()
        row = await ProviderRepository().set_enabled(
            user.id, provider_id, body.enabled,
        )
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Provider {provider_id!r} is not configured.",
            )
        # Disabling the active row: promote the next usable channel (resetting
        # current_model so the picker's (active, model) pair stays valid). When
        # none remains, clear the active flag too — a disabled provider must not
        # stay is_active, or the User-row mirror drifts from provider_credentials
        # (picker shows the model usable, chat 503s) — then clear the mirrored
        # creds so chat doesn't keep working off the just-disabled key.
        if (
            not body.enabled
            and row.is_active
            and not await _promote_next_active(
                self.llms, user.id, exclude_provider_id=provider_id,
            )
        ):
            await ProviderRepository().clear_active(user.id)
            await _sync_user_credentials(
                self.llms, user.id, api_key=None, base_url=None,
            )
        return self.response(_configured(row))


# In-flight Codex OAuth sessions, keyed by ``state``. The daemon is a single
# local user, so an in-memory table (rather than a store) is sufficient; each
# entry is short-lived (one sign-in) and dropped once finalized.
#
# Lifecycle invariant (the 1455-leak fix): every session that binds the 1455
# callback server is guaranteed to release it via one of three paths — the
# status poll finalizing it, a TTL reaper, or a preemptive sweep. Without this,
# an abandoned sign-in (user closes the browser mid-flow → no callback ever
# arrives → poll stays "pending" forever) leaks the 1455 socket and every later
# sign-in 409s. See the start handler + reapers below.
_CODEX_OAUTH_SESSIONS: Dict[str, Dict[str, Any]] = {}
# Guards the table against concurrent access (async handlers + the TTL reaper
# threads fired by threading.Timer).
_CODEX_SESSIONS_LOCK = threading.Lock()
# Backstop reclaim window. MUST exceed the renderer's OAuth poll timeout
# (90 × 2s = 180s, see atoms/models.ts) so the frontend gives up first and the
# backend only ever reaps a genuinely-abandoned session, never one still polled.
_CODEX_OAUTH_TTL_SECONDS = 300.0
# Codex OAuth (ChatGPT subscription) attaches to the "openai" channel — not a
# separate provider. Activation records auth_mode='oauth' + protocol='openai-codex'
# so the same channel slug carries either an API key or a Codex subscription.
_CODEX_PROVIDER_ID = "openai"

logger = logging.getLogger(__name__)


def _log(msg: str) -> None:
    """Trace for the Codex OAuth flow.

    Goes through ``logging`` rather than ``print(file=sys.stderr)``: the
    daemon configures a rotating ``server.log`` at startup (see
    ``server._logging``), while raw stderr is redirected by the supervisor to
    the crash-net file, which is not the file the GUI's "Open Logs" opens.
    Used to time the status-finalize path (token exchange / activation) so a
    slow sign-in is diagnosable from the log, not guessed at.
    """
    logger.info("[codex-oauth] %s", msg)


def _close_session(state: str) -> None:
    """Idempotently finalize one OAuth session: pop it, cancel its TTL timer,
    and stop routing its ``state`` to the (process-wide) callback server.

    The 1455 server is a singleton that stays up for the daemon's lifetime, so
    there's no per-session server to close — just an ``unregister`` (a quick
    dict pop, no socket teardown, safe to call inline on the event loop).
    """
    with _CODEX_SESSIONS_LOCK:
        session = _CODEX_OAUTH_SESSIONS.pop(state, None)
    if session is None:
        return
    timer = session.get("timer")
    if timer is not None:
        timer.cancel()
    CodexCallbackServer.unregister(state)


def _reap_session(state: str) -> None:
    """TTL-expiry callback (fired by ``threading.Timer``). Reclaims the session
    whether pending or terminal — idempotent via ``_close_session``."""
    _close_session(state)


def _drop_user_sessions(user_id: str) -> None:
    """Preemptively close every in-flight session owned by ``user_id``.

    Called at the start of a new sign-in so a user who abandoned (or double-
    clicked) a previous authorize self-heals: the stale server — and the 1455
    port it may still hold — is released before we bind a fresh one.
    """
    with _CODEX_SESSIONS_LOCK:
        states = [
            s for s, sess in _CODEX_OAUTH_SESSIONS.items() if sess.get("user_id") == user_id
        ]
    for state in states:
        _close_session(state)


def _sweep_all_sessions() -> None:
    """Close every in-flight session regardless of owner. Used when binding 1455
    fails: clears any zombie server this process leaked so a retry can succeed
    (if the retry still fails, the port is held by an external process)."""
    with _CODEX_SESSIONS_LOCK:
        states = list(_CODEX_OAUTH_SESSIONS.keys())
    for state in states:
        _close_session(state)


async def _activate_codex_provider(llms: LlmCache, user_id: str) -> None:
    """Upsert + activate the Codex provider after a successful OAuth sign-in.

    Tokens live in ~/.codex/auth.json (already persisted); the credential row
    only records the channel + ``protocol='openai-codex'`` so ``build_llm``
    dispatches to Codex. No api_key is stored.

    Activation seeds the whole static ``CODEX_CATALOG_MODELS`` table so the
    channel is usable immediately; the user can prune it in the GUI afterwards.
    This is a local table read — NOT the auto-probe that was removed here,
    which fired 7 cross-border requests INSIDE this call and routinely blew the
    renderer's 30s oauth/status timeout on a slow/blocked network. The
    subscription backend has no list-models endpoint, so a table is the only
    option; per-account availability still isn't knowable up front (a seeded
    model may 400 on first chat). Re-authorizing reseeds the table.
    """
    creds = resolve_codex_credentials()
    if creds is None:
        # Never activate a channel we can't actually drive — the caller (OAuth
        # status / local-reuse) turns this into a clear error. ``creds`` is now
        # only this liveness check; no probe consumes the token here anymore.
        raise CodexAuthError(
            backend_i18n.text("provider.codex_local_credentials_missing"),
            code="codex_no_local_creds",
            relogin_required=True,
        )
    models = [m["id"] for m in CODEX_CATALOG_MODELS]
    # current_model stays the pinned default rather than the table's first row:
    # the table is ordered newest-first for display, and the newest model isn't
    # necessarily the one this account can actually drive.
    current_model = DEFAULT_CODEX_MODEL

    await ProviderRepository().upsert(
        user_id,
        _CODEX_PROVIDER_ID,
        auth_mode="oauth",
        api_key=None,
        base_url=None,
        protocol="openai-codex",
        display_name="OpenAI",
        models=models,
    )
    # upsert preserves a non-None base_url — explicitly forget the api_key-era
    # url, or the next /me/active-model mirrors it back and Codex requests go
    # to https://api.openai.com/v1/codex/responses (404).
    await ProviderRepository().clear_base_url(user_id, _CODEX_PROVIDER_ID)
    await ProviderRepository().set_active(user_id, _CODEX_PROVIDER_ID)
    # Set current_model too: the chat picker's activeModelAtom needs a matching
    # (active provider, current model) pair, else the GUI shows "configure a
    # model first" even though the channel is active.
    await _sync_user_credentials(
        llms, user_id, api_key=None, base_url=None, protocol="openai-codex",
        model=current_model,
    )


class MeProviderOAuthHandler(BaseHandler):
    """Bind: ``POST /me/providers/{provider_id}/oauth/start`` — begin Codex OAuth.

    Starts the temporary localhost:1455 callback server and returns the
    authorize URL for the client to open in the system browser. The server is
    torn down by the status poll once the code arrives (or on failure).
    """

    tags = ["providers"]

    async def post(self, provider_id: str) -> Response:
        if provider_id != _CODEX_PROVIDER_ID:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"OAuth flow not supported for provider {provider_id!r}.",
            )
        user = await self.require_user()
        # Preempt: drop this user's previous unfinished sign-in so abandoning
        # then retrying (or double-clicking) self-heals — and frees the 1455
        # port it may still hold — before we bind a fresh server.
        _drop_user_sessions(user.id)
        verifier, challenge = generate_pkce()
        state = secrets.token_urlsafe(24)
        # Register this state on the singleton callback server (started lazily on
        # first use). Fails only if 1455 is held by an EXTERNAL process — the
        # singleton can't conflict with our own prior sign-ins anymore.
        if not CodexCallbackServer.register(state):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=backend_i18n.text("provider.oauth_port_occupied"),
            )
        # Backstop: reclaim this state if the sign-in is abandoned (no callback
        # arrives → poll stays pending → frontend times out → nobody unregisters).
        timer = threading.Timer(_CODEX_OAUTH_TTL_SECONDS, _reap_session, args=(state,))
        timer.daemon = True
        timer.start()
        with _CODEX_SESSIONS_LOCK:
            _CODEX_OAUTH_SESSIONS[state] = {
                "verifier": verifier,
                "status": "pending",
                "user_id": user.id,
                "error": None,
                "created_at": time.monotonic(),
                "timer": timer,
            }
        return self.response(
            {"auth_url": build_authorize_url(challenge=challenge, state=state), "state": state}
        )


class MeProviderOAuthStatusHandler(BaseHandler):
    """Bind: ``GET /me/providers/{provider_id}/oauth/status?state=...``.

    Polls the in-flight session: when the browser callback has delivered a
    code, exchanges it for tokens, persists them to ~/.codex, activates the
    Codex provider, and reports ``success``. Idempotent after terminal state.
    """

    tags = ["providers"]

    async def get(self, provider_id: str, state: str) -> Response:
        session = _CODEX_OAUTH_SESSIONS.get(state)
        if session is None:
            return self.response({"status": "unknown"})
        if session["status"] in ("success", "failed"):
            return self.response({"status": session["status"], "error": session.get("error")})

        err = CodexCallbackServer.error_for(state)
        if err:
            _log(f"state={state[:8]}… callback error: {err}")
            session["status"], session["error"] = "failed", err
            _close_session(state)
            return self.response({"status": "failed", "error": err})
        code = CodexCallbackServer.code_for(state)
        if not code:
            return self.response({"status": "pending"})

        try:
            t0 = time.perf_counter()
            _log(f"state={state[:8]}… code received; exchanging token…")
            # ``exchange_code`` uses a SYNC httpx client. Calling it directly in
            # this async handler would block the daemon's single event loop for
            # the whole token round-trip — stalling EVERY other request (health
            # polls, the next status poll, chat WS frames). Run it off-loop.
            tokens = await asyncio.to_thread(
                exchange_code, code, session["verifier"]
            )
            t1 = time.perf_counter()
            _log(f"state={state[:8]}… token ok ({(t1 - t0) * 1000:.0f}ms); activating…")
            persist_codex_tokens(tokens)
            await _activate_codex_provider(self.llms, session["user_id"])
            t2 = time.perf_counter()
            _log(
                f"state={state[:8]}… activated ({(t2 - t1) * 1000:.0f}ms); "
                f"total {(t2 - t0) * 1000:.0f}ms"
            )
            session["status"] = "success"
        except CodexAuthError as exc:
            # Carry the full message (includes the upstream HTTP body) so the
            # GUI shows the real reason, not a generic "please retry".
            _log(f"state={state[:8]}… FAILED (auth): {exc}")
            session["status"], session["error"] = "failed", str(exc)
        except Exception as exc:  # noqa: BLE001 — surface any failure to the client
            _log(f"state={state[:8]}… FAILED: {type(exc).__name__}: {exc}")
            session["status"], session["error"] = "failed", str(exc)
        finally:
            # Terminal: drop the session + cancel its TTL timer + unregister the
            # state. ``_close_session`` is now a cheap dict pop (no socket
            # teardown — the singleton server stays up), so it runs inline.
            _close_session(state)
        return self.response({"status": session["status"], "error": session.get("error")})


class MeProviderOAuthCancelHandler(BaseHandler):
    """Bind: ``POST /me/providers/{provider_id}/oauth/cancel?state=...``.

    User abandons the sign-in mid-flow — clicked "cancel authorization", or navigated away so
    the OAuth UI unmounted. Immediately drop the session + unregister its state
    from the (process-wide) callback server, so a stale callback can't later land
    on a finalized sign-in, instead of waiting for the TTL reaper. Idempotent: an
    unknown / already-finalized ``state`` is a no-op (``_close_session`` pops
    nothing).
    """

    tags = ["providers"]

    async def post(self, provider_id: str, state: str) -> Response:
        if provider_id != _CODEX_PROVIDER_ID:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"OAuth flow not supported for provider {provider_id!r}.",
            )
        # Cheap inline: drop the session + cancel timer + unregister the state
        # from the singleton server (no socket teardown).
        _close_session(state)
        return self.response(status_code=status.HTTP_204_NO_CONTENT)


class MeProviderCodexLocalHandler(BaseHandler):
    """Bind: ``GET/POST /me/providers/{provider_id}/codex/local``.

    The **local-first** path: reuse an existing ``~/.codex`` login instead of
    forcing OAuth.

    * GET  → detect whether a local Codex login exists (read-only).
    * POST → reuse it: activate the channel directly (resolve + probe models +
      activate), skipping the whole OAuth/browser flow.
    """

    tags = ["providers"]

    async def get(self, provider_id: str) -> Response:
        if provider_id != _CODEX_PROVIDER_ID:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Local Codex reuse not supported for provider {provider_id!r}.",
            )
        local = peek_codex_local()
        return self.response(
            {
                "has_local": local is not None,
                "account_id": local.get("account_id") if local else None,
            }
        )

    async def post(self, provider_id: str) -> Response:
        if provider_id != _CODEX_PROVIDER_ID:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Local Codex reuse not supported for provider {provider_id!r}.",
            )
        user = await self.require_user()
        try:
            await _activate_codex_provider(self.llms, user.id)
        except CodexAuthError as exc:
            return self.response({"ok": False, "error": str(exc)})
        return self.response({"ok": True})


__all__ = [
    "ProvidersCatalogHandler",
    "MeProvidersHandler",
    "MeProviderItemHandler",
    "MeActiveModelHandler",
    "MeProviderTestHandler",
    "MeProviderToggleHandler",
    "MeProviderOAuthHandler",
    "MeProviderOAuthStatusHandler",
    "MeProviderOAuthCancelHandler",
    "MeProviderCodexLocalHandler",
]
