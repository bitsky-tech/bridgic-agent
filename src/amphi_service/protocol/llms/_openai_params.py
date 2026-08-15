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


def is_openai_endpoint(base_url: Optional[str]) -> bool:
    """True when the endpoint is official OpenAI (the default, or *.openai.com).

    OpenAI-compat services such as DeepSeek/GLM/OpenRouter use their own host → False;
    their parameter rules differ from the official ones, and the sanitizer stays entirely
    out of their way.
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
    """Apply endpoint-specific parameter rules for OpenAI-compatible APIs.

    Kimi Code currently accepts only ``temperature=1`` for its coding models.
    Official OpenAI endpoints rename ``max_tokens`` and reject sampling
    parameters on reasoning models. Other compatible endpoints pass through.
    """
    if is_kimi_code_endpoint(base_url):
        out = dict(params)
        if "temperature" in out:
            out["temperature"] = 1
        return out
    if not is_openai_endpoint(base_url):
        return params
    out = dict(params)
    if "max_tokens" in out:
        # Rename only (the value is unchanged); max_completion_tokens is accepted by
        # every OpenAI Chat model.
        out["max_completion_tokens"] = out.pop("max_tokens")
    if is_openai_reasoning_model(str(out.get("model") or "")):
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
    if isinstance(body, dict):
        err = body.get("error") or {}
        code = code or err.get("code")
        param = param or err.get("param")
    if code == "unsupported_parameter" and isinstance(param, str) and param:
        return param
    return None
