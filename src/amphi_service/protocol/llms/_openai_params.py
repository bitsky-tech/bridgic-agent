import re
from typing import Any, Dict, Optional
from urllib.parse import urlparse

# Sampling parameters that reasoning models (the o series / gpt-5.x) hard-reject on Chat
# Completions.
REASONING_UNSUPPORTED = frozenset({
    "temperature", "top_p", "presence_penalty", "frequency_penalty",
    "logprobs", "top_logprobs", "logit_bias", "n",
})

_O_SERIES = re.compile(r"^(o1|o3|o4|codex-mini)(-|$)")

# Request parameters a 400 may legitimately name as unsupported; anything else
# mentioned in an error text is not something we can strip and retry.
_HEALABLE_PARAMS = REASONING_UNSUPPORTED | frozenset({
    "max_tokens", "max_completion_tokens", "stop", "tool_choice",
    "parallel_tool_calls", "response_format", "reasoning_effort", "stream_options",
})

# Relay wording when the structured ``code``/``param`` fields are absent:
#   LiteLLM  "gpt-5 models (...) don't support temperature=0.0. Only temperature=1 ..."
#            "O-series models don't support temperature=0.0. ..."
#   OpenAI   "Unsupported parameter: 'top_p' is not supported with this model."
_UNSUPPORTED_TEXT = re.compile(
    r"(?:don't|do not|does not) support [`']?(\w+)[`']?\s*="
    r"|Unsupported parameter:? [`']?(\w+)[`']?"
    r"|[`'](\w+)[`'] is not supported",
    re.IGNORECASE,
)


def is_openai_endpoint(base_url: Optional[str]) -> bool:
    """True when the endpoint is official OpenAI (the default, or *.openai.com).

    OpenAI-compat services such as DeepSeek/GLM/OpenRouter use their own host → False.
    The host only gates the ``max_tokens`` rename for *non-reasoning* models; the
    reasoning-model rules are keyed on the model name (see ``sanitize_openai_params``).
    """
    if not (base_url or "").strip():
        return True  # empty → the openai SDK defaults to api.openai.com
    host = (urlparse(base_url).hostname or "").lower()
    return host == "api.openai.com" or host.endswith(".openai.com")


def is_kimi_code_endpoint(base_url: Optional[str]) -> bool:
    """Return whether ``base_url`` targets the Kimi Code subscription API."""
    parsed = urlparse((base_url or "").strip())
    host = (parsed.hostname or "").lower()
    path = parsed.path.rstrip("/").lower()
    return host == "api.kimi.com" and (path == "/coding" or path.startswith("/coding/"))


def is_openai_reasoning_model(model: str) -> bool:
    """Heuristic: the o series / gpt-5.x are reasoning models; the ``*-chat*`` aliases are
    the non-reasoning counterexamples.

    There is no official capability endpoint, and the heuristic covers every current
    model; anything it misses is caught by stream_turn's self-healing fallback.
    """
    m = (model or "").lower()
    if "chat" in m:                    # gpt-5-chat-latest / gpt-5.1-chat are non-reasoning
        return False
    if _O_SERIES.match(m):
        return True
    return m.startswith("gpt-5")


def sanitize_openai_params(params: Dict[str, Any], *, base_url: Optional[str]) -> Dict[str, Any]:
    """Apply OpenAI parameter rules for OpenAI-compatible APIs.

    * Kimi Code currently accepts only ``temperature=1`` for its coding models.
    * OpenAI reasoning models (o-series / gpt-5.x) reject ``temperature`` / ``top_p``
      / penalties / logprobs and only take ``max_completion_tokens`` — a property of
      the MODEL, so it applies on every host: official, new-api, LiteLLM … (a relay
      that validates strictly, e.g. LiteLLM without ``drop_params``, 400s otherwise;
      a lenient one silently drops the params — either way they must not be sent).
    * On the official endpoint ``max_tokens`` is renamed for every model; other
      compatible endpoints pass non-reasoning models through untouched.
    """
    if is_kimi_code_endpoint(base_url):
        out = dict(params)
        if "temperature" in out:
            out["temperature"] = 1
        return out
    reasoning = is_openai_reasoning_model(str(params.get("model") or ""))
    if not reasoning and not is_openai_endpoint(base_url):
        return params
    out = dict(params)
    if "max_tokens" in out:
        # Rename only (the value is unchanged); max_completion_tokens is accepted by
        # every OpenAI Chat model and is the only form reasoning models take.
        out["max_completion_tokens"] = out.pop("max_tokens")
    if reasoning:
        for key in REASONING_UNSUPPORTED:
            out.pop(key, None)
    return out


def unsupported_param_of(exc: Exception) -> Optional[str]:
    """Read the named parameter out of an OpenAI 400 ``unsupported_parameter`` error,
    otherwise None.

    The openai SDK's ``BadRequestError`` carries ``.code`` / ``.param``, and its ``.body``
    contains ``{"error": {"code", "param", ...}}``. Try both, for a robust read.
    """
    code = getattr(exc, "code", None)
    param = getattr(exc, "param", None)
    body = getattr(exc, "body", None)
    message = ""
    if isinstance(body, dict):
        err = body.get("error") or {}
        code = code or err.get("code")
        param = param or err.get("param")
        if isinstance(err.get("message"), str):
            message = err["message"]
    if code == "unsupported_parameter" and isinstance(param, str) and param:
        return param
    # Relays (LiteLLM) enforce the same rules but only name the parameter in the
    # message text, with code "400" and param null — fall back to the wording.
    match = _UNSUPPORTED_TEXT.search(message or str(exc))
    if match:
        name = next(g for g in match.groups() if g)
        if name in _HEALABLE_PARAMS:
            return name
    return None
