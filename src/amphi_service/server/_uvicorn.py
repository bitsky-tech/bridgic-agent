"""Foreground Uvicorn hosting for the Bridgic Agent service."""

from __future__ import annotations

import copy
import inspect
import logging
import os
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional, TYPE_CHECKING

import uvicorn

from ._logging import (
    configure_console_logging,
    configure_daemon_logging,
    log_crash_net_size,
)

if TYPE_CHECKING:
    from ._manager import (
        ServerInstance,
        ServerInstanceLock,
        ServerOptions,
        ServerRegistration,
    )


LifecycleHook = Callable[[], Optional[Awaitable[None]]]

#: How ``--log-level`` reaches a reload worker, which uvicorn spawns as a
#: fresh process that inherits environment but not arguments.
RELOAD_LOG_LEVEL_ENV = "AMPHI_RELOAD_LOG_LEVEL"

logger = logging.getLogger(__name__)


def log_config() -> dict[str, Any]:
    """Uvicorn's default logging, timestamped so field reports can be dated.

    Reload (dev) mode only. The managed path passes ``log_config=None`` so
    uvicorn's loggers propagate to the root handlers installed by
    ``configure_daemon_logging`` instead of owning a console of their own —
    otherwise every uvicorn line would land twice in ``server.log`` whenever a
    supervisor redirects the console there.
    """
    config = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
    for formatter in config["formatters"].values():
        formatter["fmt"] = f"%(asctime)s {formatter['fmt']}"
        formatter["datefmt"] = "%Y-%m-%d %H:%M:%S"
    return config


def reconfigure_streams() -> None:
    """Make the console streams UTF-8 and line buffered.

    Redirected output is block buffered, so a crashing process loses the tail
    of its own log, and a non-UTF-8 Windows console mojibakes OS error strings.
    Both turn a log file into a guessing game when it is the only evidence.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except (OSError, ValueError):
            continue


class GracefulServer(uvicorn.Server):
    """Run hooks after socket startup and before connection shutdown."""

    def __init__(
        self,
        config: uvicorn.Config,
        *,
        post_startup: Optional[LifecycleHook] = None,
        pre_shutdown: Optional[LifecycleHook] = None,
    ) -> None:
        super().__init__(config)
        self._post_startup = post_startup
        self._pre_shutdown = pre_shutdown

    async def startup(self, sockets: Any = None) -> None:
        await super().startup(sockets=sockets)
        if not self.should_exit:
            await self._run_hook(self._post_startup, swallow=False)

    async def shutdown(self, sockets: Any = None) -> None:
        await self._run_hook(self._pre_shutdown, swallow=True)
        await super().shutdown(sockets=sockets)

    @staticmethod
    async def _run_hook(
        hook: Optional[LifecycleHook],
        *,
        swallow: bool,
    ) -> None:
        if hook is None:
            return
        try:
            result = hook()
            if inspect.isawaitable(result):
                await result
        except Exception as exc:  # noqa: BLE001 - shutdown must continue
            if not swallow:
                raise
            logger.warning("[GracefulServer] lifecycle hook failed: %s", exc)


class UvicornRunner:
    """Own one managed foreground process from lock acquisition to cleanup."""

    def __init__(
        self,
        *,
        registration: ServerRegistration,
        instance_lock: ServerInstanceLock,
    ) -> None:
        self.registration = registration
        self.instance_lock = instance_lock

    def run(self, options: ServerOptions) -> None:
        """Run Uvicorn in the foreground using ``options``."""
        reconfigure_streams()
        if options.reload:
            self._run_reload(options)
            return

        self.instance_lock.acquire()
        published: Optional[ServerInstance] = None
        try:
            # Before ServiceApp import: application construction already logs.
            # The path lives beside runtime.json because that is the one
            # directory every client can discover; a None result (unwritable
            # dir) degrades to console-only logging instead of failing start.
            from ._manager import LOG_FILE, STDERR_LOG_FILE

            log_path = self.registration.path.parent / LOG_FILE.name
            handler = configure_daemon_logging(log_path, log_level=options.log_level)
            # None means the daemon is logging to the console instead, so the
            # registration must not advertise a file that holds nothing.
            log_file: Optional[Path] = log_path if handler is not None else None
            # Point the reader at any crash output earlier runs left behind —
            # a KeepAlive crash loop appends tracebacks there and nothing in
            # server.log would otherwise say the file exists.
            log_crash_net_size(self.registration.path.parent / STDERR_LOG_FILE.name)

            from .._app import ServiceApp

            service = ServiceApp(
                bind_host=options.host,
                bind_port=options.port,
            )

            def publish_registration() -> None:
                nonlocal published
                gateway = service.state.gateway
                published = self.registration.write(
                    instance_lock=self.instance_lock,
                    host=options.host,
                    port=options.port,
                    pid=os.getpid(),
                    started_at=gateway.started_at,
                    token=service.state.auth.current_token,
                    lock_file=self.instance_lock.path,
                    ws_path=gateway.ws_path,
                    version=gateway.version,
                    log_file=log_file,
                )

            config = uvicorn.Config(
                service.app,
                host=options.host,
                port=options.port,
                log_level=options.log_level,
                # None on purpose: uvicorn then skips dictConfig entirely and
                # its loggers propagate to the root handlers installed above.
                log_config=None,
                # That propagation is also why access logging has to go: with
                # a dictConfig uvicorn gives uvicorn.access its own handler
                # and propagate=False, so it never touched the app's log. Now
                # it would share server.log's 5 MB × 2 rotation budget, and a
                # health check every 30 s (PythonClient) plus normal API
                # traffic would rotate away the tracebacks this file exists to
                # keep. The --reload path keeps its access log: it uses
                # log_config() and writes to a terminal, not to the budget.
                access_log=False,
            )
            server = GracefulServer(
                config,
                post_startup=publish_registration,
                pre_shutdown=service.pre_shutdown_hook,
            )
            service.bind_shutdown(lambda: setattr(server, "should_exit", True))
            server.run()
        finally:
            if published is not None:
                self.registration.clear(
                    published,
                    instance_lock=self.instance_lock,
                )
            self.instance_lock.release()

    @staticmethod
    def _run_reload(options: ServerOptions) -> None:
        """Run an unmanaged development reloader."""
        # The worker is a separate process, so the flag has to travel as
        # environment rather than as an argument. See create_reload_app.
        os.environ[RELOAD_LOG_LEVEL_ENV] = options.log_level
        uvicorn.run(
            "src.amphi_service.server._uvicorn:create_reload_app",
            factory=True,
            host=options.host,
            port=options.port,
            log_level=options.log_level,
            log_config=log_config(),
            reload=True,
        )


def create_reload_app() -> Any:
    """Create the unmanaged ASGI application used by Uvicorn reload workers.

    Logging is configured here, not in :meth:`UvicornRunner._run_reload`:
    uvicorn spawns a fresh process per reload, so the parent's configuration
    never reaches the worker that actually runs the application. Without this
    the root logger has no handler and the whole reason ``_logging`` exists —
    application records reaching a log at all — would not hold in dev.

    ``--log-level`` has to travel the same distance. Uvicorn hands the worker
    its own three loggers at the requested level, but the application loggers
    ``APP_LOGGER_NAMES`` exists to control are configured here; defaulting
    them to INFO discarded ``--log-level debug`` in the one mode where a
    developer asks for it by name.
    """
    from .._app import ServiceApp

    configure_console_logging(log_level=os.environ.get(RELOAD_LOG_LEVEL_ENV, "info"))
    return ServiceApp(bind_host=None, bind_port=None).app


__all__ = [
    "GracefulServer",
    "LifecycleHook",
    "UvicornRunner",
    "log_config",
    "reconfigure_streams",
]
