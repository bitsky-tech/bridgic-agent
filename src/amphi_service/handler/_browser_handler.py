"""Authenticated registration of the Electron embedded-browser controller."""

from ipaddress import ip_address
from typing import Annotated, Any

from pydantic import AnyHttpUrl, BaseModel, Field, ValidationInfo, field_validator

from ._base import BaseHandler


class BrowserControllerRegistrationRequest(BaseModel):
    controller_id: Annotated[str, Field(min_length=1, max_length=128)]
    generation: Annotated[str, Field(min_length=1, max_length=128)]
    control_url: AnyHttpUrl
    control_token: Annotated[str, Field(min_length=16, max_length=512, repr=False)]
    cdp_endpoint: AnyHttpUrl
    owner_pid: Annotated[int, Field(ge=1)]

    @field_validator("control_url", "cdp_endpoint")
    @classmethod
    def require_loopback_origin(cls, value: AnyHttpUrl, info: ValidationInfo) -> AnyHttpUrl:
        host = value.host
        try:
            is_loopback = host is not None and ip_address(host).is_loopback
        except ValueError:
            is_loopback = False
        if not is_loopback:
            raise ValueError("browser controller endpoints must use a loopback IP")
        if value.username is not None or value.password is not None:
            raise ValueError("browser controller endpoints must not contain credentials")
        if value.query is not None or value.fragment is not None or value.path != "/":
            raise ValueError(
                f"{info.field_name} must be a loopback origin without a path, query, or fragment"
            )
        return value


class BrowserControllerDeleteRequest(BaseModel):
    controller_id: Annotated[str, Field(min_length=1, max_length=128)]


class BrowserControllerHandler(BaseHandler):
    """Bind: ``/api/browser/controller`` — Electron controller discovery."""

    tags = ["browser"]

    async def get(self) -> Any:
        return self.response(self.state.browser_host.controller_status())

    async def put(self, request: BrowserControllerRegistrationRequest) -> Any:
        await self.state.browser_host.register_controller(
            controller_id=request.controller_id,
            generation=request.generation,
            control_url=str(request.control_url).rstrip("/"),
            control_token=request.control_token,
            cdp_endpoint=str(request.cdp_endpoint).rstrip("/"),
            owner_pid=request.owner_pid,
        )
        return self.response(self.state.browser_host.controller_status())

    async def delete(self, request: BrowserControllerDeleteRequest) -> Any:
        removed = await self.state.browser_host.unregister_controller(request.controller_id)
        return self.response({"removed": removed})


__all__ = ["BrowserControllerHandler"]
