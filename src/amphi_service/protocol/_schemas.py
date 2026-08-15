from typing import List, Literal, Optional

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
)


# Session lifecycle
class CreateSessionRequest(BaseModel):
    """Body of ``POST /sessions``.

    ``model`` defaults to the user's current model. ``workspace_root`` remains
    accepted for wire compatibility, but new sessions always receive their own
    server-managed workspace.
    """

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    model: Optional[str] = Field(default=None, description="Override the service default model.")
    workspace_root: Optional[str] = Field(
        default=None,
        description="Deprecated; new sessions use a server-managed workspace.",
    )


class RenameSessionRequest(BaseModel):
    """Body of ``PATCH /sessions/{session_id}`` — set the display title."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    title: str = Field(min_length=1, max_length=200)


class CreateMountRequest(BaseModel):
    """Body of ``POST /sessions/{session_id}/mounts`` — pin a local path.

    ``path`` must be an absolute path that exists on the **daemon's**
    filesystem (the handler validates both); deleting a mount later only drops
    the registry row, never the real file.
    """

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    path: str = Field(min_length=1, description="Absolute local path to mount.")


# Schedules
class CreateScheduleRequest(BaseModel):
    """Body of ``POST /schedules`` — create a cron schedule."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    name: str = Field(min_length=1, max_length=200)
    desc: str = Field(min_length=1, description="Natural-language task; the run-time goal.")
    cron: str = Field(min_length=1, description="6-field cron (sec min hour dom mon dow).")
    refs: Optional[List[str]] = Field(
        default=None,
        description="Display-only referenced workflow/skill ids (D4: global scope).",
    )
    enabled: bool = Field(default=True)


class PatchScheduleRequest(BaseModel):
    """Body of ``PATCH /schedules/{schedule_id}`` — partial update.

    Only provided (non-``None``) fields change (PATCH semantics)."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    desc: Optional[str] = Field(default=None, min_length=1)
    cron: Optional[str] = Field(default=None, min_length=1)
    enabled: Optional[bool] = Field(default=None)


# Command-style actions
class SetModelRequest(BaseModel):
    """Body of ``POST /me/model`` — switch the user's current model."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    model: str


class SetExecutionModeRequest(BaseModel):
    """Body of ``POST /me/execution-mode`` — switch the tool-permission mode.

    ``mode`` is validated to the three modes; an out-of-set value 422s.
    """

    model_config = ConfigDict(extra="forbid")

    mode: Literal["request", "auto", "full"]


# Runtime credential configuration
class CredentialsRequest(BaseModel):
    """Body of ``POST /credentials`` - update the live AI provider credentials.

    All fields are optional; missing / empty fields leave the current
    value untouched. Use this to wire an API key at runtime (e.g. from
    an Electron settings panel) instead of restarting the service.
    """

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    api_key: Optional[str] = Field(
        default=None,
        description="AI provider API key. Sensitive; never echoed back.",
    )
    base_url: Optional[str] = Field(
        default=None,
        description="Custom OpenAI-compatible endpoint (DeepSeek, Ollama, vLLM, ...).",
    )


# /me — user-scoped resources
class CreateMemoryRequest(BaseModel):
    """Body of ``POST /me/memories``."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    content: str
    source: str = "manual"


# Providers (``/providers`` + ``/me/providers``)
class AddProviderRequest(BaseModel):
    """Body of ``POST /me/providers`` — add / update a provider credential.

    Phase 2 expansion: ``provider_id`` is now any user-chosen slug (the
    catalog at ``/providers`` is a UI prefill source, not a validation gate).
    ``protocol`` / ``display_name`` / ``models`` are new optional fields:
    None preserves existing values on update; on insert ``protocol`` defaults
    to ``"openai"`` and ``models`` to ``[]``.
    """

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    provider_id: str = Field(
        description="User-chosen slug. Catalog ids may be reused for built-ins; "
        "custom channels pick their own (e.g. 'company-gateway')."
    )
    auth_mode: str = Field(default="api_key", description="'api_key' | 'oauth'.")
    api_key: Optional[str] = Field(
        default=None, description="Provider API key. Sensitive; never echoed back."
    )
    base_url: Optional[str] = Field(default=None)
    protocol: Optional[str] = Field(
        default=None,
        description="Wire protocol the LLM client should speak: 'openai' | 'anthropic'. "
        "None preserves existing on update; insert defaults to 'openai'.",
    )
    display_name: Optional[str] = Field(
        default=None,
        description="User-given channel name; None falls back to provider_id for display.",
    )
    models: Optional[List[str]] = Field(
        default=None,
        description="Whitelist of model ids exposed to the picker. None preserves "
        "existing on update; insert defaults to [].",
    )


class SetActiveModelRequest(BaseModel):
    """Body of ``POST /me/active-model`` — pick the active provider+model."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    provider_id: str
    model: str


class ToggleProviderRequest(BaseModel):
    """Body of ``POST /me/providers/{provider_id}/toggle`` — flip is_enabled."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    enabled: bool


class ToggleSkillRequest(BaseModel):
    """Body of ``POST /skill/{skill_id}/toggle`` — flip enabled."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool


class TestProviderRequest(BaseModel):
    """Body of ``POST /me/providers/test`` — probe a provider's connectivity.

    All fields are sent fresh from the form (NOT looked up server-side from
    the user's stored row). This lets the GUI test typed-but-unsaved values
    before committing them. Successful test does NOT save the credentials —
    the client still has to POST /me/providers to persist.
    """

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    provider_id: str = Field(description="Slug used for log lines; not stored on save.")
    protocol: str = Field(default="openai", description="'openai' | 'anthropic'")
    api_key: str = Field(description="Plain key; never logged at info level.")
    base_url: Optional[str] = Field(default=None)
    model: str = Field(description="Model id used by generative probes; Kimi verifies via /models.")


class FetchModelsRequest(BaseModel):
    """Body of ``POST /me/providers/fetch-models`` — list a provider's models.

    Same "fresh from the form, nothing looked up server-side" contract as
    ``TestProviderRequest``. Deliberately has NO ``model`` field: listing is
    what lets a user discover model ids in the first place, so requiring one
    would reintroduce the chicken-and-egg the GUI has with "test connection".
    """

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    provider_id: str = Field(description="Slug used for log lines; not stored on save.")
    protocol: str = Field(default="openai", description="'openai' | 'anthropic' | 'google'")
    api_key: str = Field(description="Plain key; never logged at info level.")
    base_url: Optional[str] = Field(default=None)


# Workflows (``/workflows``) — saved build artifacts
class RenameWorkflowRequest(BaseModel):
    """Body of ``PATCH /workflows/{workflow_id}`` — rename one saved Workflow."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    name: str = Field(min_length=1, max_length=200)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        """Trim the display name and reject whitespace-only input."""
        name = value.strip()
        if not name:
            raise ValueError("Workflow name must be non-empty")
        return name


class WorkflowFile(BaseModel):
    """One generated source file inside a workflow's ``program`` field."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    path: str
    language: str = ""
    content: str = ""


class WorkflowProgram(BaseModel):
    """Workflow source files relative to the package's ``workflow/`` directory."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    files: List[WorkflowFile] = Field(default_factory=list)
    readme: Optional[str] = None


__all__ = [
    "CreateSessionRequest",
    "RenameSessionRequest",
    "CreateMountRequest",
    "SetModelRequest",
    "CredentialsRequest",
    "CreateMemoryRequest",
    "AddProviderRequest",
    "SetActiveModelRequest",
    "RenameWorkflowRequest",
    "WorkflowFile",
    "WorkflowProgram",
]
