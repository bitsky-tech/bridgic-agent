from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

import httpx
import pytest

from src.amphi_store import Repository
from tests._support.sandbox import IsolatedPaths

if TYPE_CHECKING:
    from src.amphi_service._app import ServiceApp


@pytest.fixture
async def service_app(test_sandbox: IsolatedPaths) -> AsyncIterator["ServiceApp"]:
    """Build one isolated production ServiceApp without running background services."""
    from src.amphi_agent import SkillLibrary
    from src.amphi_service._app import ServiceApp
    from src.amphi_service.auth import LOCAL_USER_ID, seed_local_user

    await Repository.close()
    service: ServiceApp | None = None
    try:
        service = ServiceApp(bind_host="127.0.0.1", bind_port=0)
        service.bind_shutdown(lambda: None)
        await Repository.init_schema()
        await seed_local_user()
        await SkillLibrary(LOCAL_USER_ID).sync_builtins()
        yield service
    finally:
        try:
            if service is not None:
                try:
                    await service.state.agent_env.stop()
                finally:
                    try:
                        await service.state.scheduler.stop()
                    finally:
                        try:
                            await service.state.invocations.shutdown()
                        finally:
                            await service.state.browser_host.shutdown()
        finally:
            await Repository.close()


@pytest.fixture
async def service_client(service_app: "ServiceApp") -> AsyncIterator[httpx.AsyncClient]:
    """Call the isolated ServiceApp through its authenticated HTTP boundary."""
    transport = httpx.ASGITransport(app=service_app.app, raise_app_exceptions=True)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://127.0.0.1",
        headers={
            "Authorization": f"Bearer {service_app.state.auth.current_token}",
            "Accept-Language": "en",
        },
    ) as client:
        yield client
