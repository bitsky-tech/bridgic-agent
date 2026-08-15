"""Class-based request handlers for the L2 service.

Each URL pattern owns one :class:`BaseHandler` subclass whose
HTTP-verb-named methods (``get`` / ``post`` / ``put`` / ``delete`` /
``patch``) are auto-discovered and bound by
:meth:`BaseHandler.bind`. The top-level :class:`ServiceApp`
(``src/amphi_service/_app.py``) is the only consumer of these classes — it
calls ``Handler.bind(router, path, state)`` once per URL.

Public surface re-exported here so ``_app.py`` can import everything
from one place.
"""

from __future__ import annotations

from ._agent_handler import AgentRunHandler, AgentStatusHandler, SubAgentRunHandler
from ._browser_handler import BrowserControllerHandler
from ._base import BaseHandler, ServiceState, WsHandler
from ._gateway_handler import (
    GatewayClientsHandler,
    GatewayHealthHandler,
    GatewayInfoHandler,
    GatewayShutdownHandler,
)
from ._command_handler import (
    InteractionHandledHandler,
    ReadHandler,
    ResetHandler,
    StopHandler,
    TokensHandler,
)
from ._mounts_handler import (
    SessionMountListHandler,
    SessionMountUploadHandler,
    SessionMountsHandler,
)
from ._me_handler import (
    MeCredentialsHandler,
    MeExecutionModeHandler,
    MeMemoryItemHandler,
    MeMemoryListHandler,
    MeModelHandler,
    MeProfileHandler,
    me_profile,
)
from ._providers_handler import (
    MeActiveModelHandler,
    MeProviderCodexLocalHandler,
    MeProviderItemHandler,
    MeProviderOAuthCancelHandler,
    MeProviderOAuthHandler,
    MeProviderOAuthStatusHandler,
    MeProvidersHandler,
    MeProviderApiKeyHandler,
    MeProviderFetchModelsHandler,
    MeProviderTestHandler,
    MeProviderToggleHandler,
    ProvidersCatalogHandler,
)
from ._session_handler import (
    SessionDetailHandler,
    SessionDuplicateHandler,
    SessionListHandler,
    SessionFileHandler,
    SessionMessagesHandler,
    session_detail,
    session_summary,
)
from ._skills_handler import (
    SkillItemHandler,
    SkillToggleHandler,
    SkillsHandler,
)
from ._skills_import_handler import (
    SkillsImportCheckHandler,
    SkillsImportExecuteHandler,
    SkillsImportScanHandler,
)
from ._workflows_handler import (
    WorkflowItemHandler,
    WorkflowRunFileHandler,
    WorkflowRunItemHandler,
    WorkflowRunsHandler,
    WorkflowsHandler,
)
from ._schedules_handler import (
    ScheduleItemHandler,
    ScheduleKillHandler,
    ScheduleRunNowHandler,
    SchedulesHandler,
)
from ._chat_handler import ChatHandler

__all__ = [
    # base
    "BaseHandler",
    "ServiceState",
    # local Agent RPC
    "AgentRunHandler",
    "AgentStatusHandler",
    "BrowserControllerHandler",
    "SubAgentRunHandler",
    # /me family
    "MeProfileHandler",
    "MeCredentialsHandler",
    "MeModelHandler",
    "MeExecutionModeHandler",
    "MeMemoryListHandler",
    "MeMemoryItemHandler",
    "me_profile",
    # providers (multi-provider)
    "ProvidersCatalogHandler",
    "MeProvidersHandler",
    "MeProviderItemHandler",
    "MeActiveModelHandler",
    "MeProviderCodexLocalHandler",
    "MeProviderOAuthCancelHandler",
    "MeProviderOAuthHandler",
    "MeProviderOAuthStatusHandler",
    "MeProviderTestHandler",
    "MeProviderFetchModelsHandler",
    "MeProviderApiKeyHandler",
    "MeProviderToggleHandler",
    # sessions
    "SessionListHandler",
    "SessionDetailHandler",
    "SessionDuplicateHandler",
    "SessionFileHandler",
    "SessionMessagesHandler",
    "SessionMountListHandler",
    "SessionMountUploadHandler",
    "SessionMountsHandler",
    "session_detail",
    "session_summary",
    # chat (the turn engine itself lives in amphi_service.runtime)
    # commands
    "ResetHandler",
    "TokensHandler",
    "StopHandler",
    "ReadHandler",
    "InteractionHandledHandler",
    # gateway
    "GatewayHealthHandler",
    "GatewayInfoHandler",
    "GatewayClientsHandler",
    "GatewayShutdownHandler",
    # skills
    "SkillsHandler",
    "SkillItemHandler",
    "SkillToggleHandler",
    "SkillsImportScanHandler",
    "SkillsImportCheckHandler",
    "SkillsImportExecuteHandler",
    # workflows
    "WorkflowsHandler",
    "WorkflowItemHandler",
    "SchedulesHandler",
    "ScheduleItemHandler",
    "ScheduleRunNowHandler",
    "ScheduleKillHandler",
    "WorkflowRunFileHandler",
    "WorkflowRunItemHandler",
    "WorkflowRunsHandler",
    # WS transport base + chat business
    "WsHandler",
    "ChatHandler",
]
