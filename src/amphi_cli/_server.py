"""Command-line interface for the Bridgic Agent service lifecycle."""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Optional, Sequence

from ..amphi_service.server import ServerError, ServerManager, ServerOptions
from ..amphi_service.server.supervisor import SupervisorError


class ServerCLI:
    """Parse ``amphi server`` commands and present Manager results."""

    LOG_LEVELS = ("critical", "error", "warning", "info", "debug", "trace")

    def __init__(self, manager: Optional[ServerManager] = None) -> None:
        self._manager = manager

    @property
    def manager(self) -> ServerManager:
        """Create the lightweight lifecycle manager only when executing."""
        if self._manager is None:
            self._manager = ServerManager()
        return self._manager

    def main(self, argv: Optional[Sequence[str]] = None) -> int:
        """Parse and execute a service command, returning its exit code."""
        arguments = list(sys.argv[2:] if argv is None else argv)
        parser = self._parser()
        if not arguments:
            parser.print_help()
            return 1
        args = parser.parse_args(arguments)

        try:
            return {
                "start": self._start,
                "stop": self._stop,
                "restart": self._restart,
                "status": self._status,
                "serve": self._serve,
                "autostart": self._autostart,
            }[args.command](args)
        except (ServerError, SupervisorError) as exc:
            print(f"amphi server {args.command}: {exc}", file=sys.stderr)
            return 1

    def _start(self, args: argparse.Namespace) -> int:
        result = self.manager.start(
            self._options(args),
            timeout=args.timeout,
        )
        instance = result.instance
        if result.started:
            print(f"Service started at {instance.base_url()} (pid {instance.pid}).")
        else:
            print(
                f"Service already running at {instance.base_url()} "
                f"(pid {instance.pid}). Use `server restart` to restart it."
            )
        return 0

    def _stop(self, args: argparse.Namespace) -> int:
        result = self.manager.stop(timeout=args.timeout, force=args.force)
        if result.outcome == "not_registered":
            print("No service registered.")
        elif result.outcome == "stale_cleared":
            print("Stale registration cleared (pid not alive).")
        else:
            print(f"Service stopped (pid {result.pid}).")
        return 0

    def _restart(self, args: argparse.Namespace) -> int:
        result = self.manager.restart(
            self._options(args),
            start_timeout=args.timeout,
            stop_timeout=args.stop_timeout,
            force=args.force,
        )
        instance = result.instance
        print(f"Service restarted at {instance.base_url()} (pid {instance.pid}).")
        return 0

    def _status(self, _args: argparse.Namespace) -> int:
        # ASCII-escaped on purpose. Clients read this JSON off a pipe and decode
        # it as UTF-8, while a non-UTF-8 console locale (cp936 on a Chinese
        # Windows) would have encoded it in that locale instead — turning a path
        # such as ``C:\Users\<non-ASCII user name>\...`` into mojibake the client then
        # fails to open. Escaping keeps the bytes identical under every locale.
        print(json.dumps(self.manager.status().to_dict(), indent=2))
        return 0

    def _serve(self, args: argparse.Namespace) -> int:
        if not self.manager.serve(self._options(args)):
            print("A service instance already owns the server lock.")
            return 1
        return 0

    def _autostart(self, args: argparse.Namespace) -> int:
        if args.autostart_command == "enable":
            result = (
                self.manager.configure_autostart(
                    True,
                    self._options(args),
                    timeout=args.timeout,
                )
                if args.configure_only
                else self.manager.enable_autostart(
                    self._options(args),
                    timeout=args.timeout,
                )
            )
            instance = result.instance
            location = (
                f" at {instance.base_url()} (pid {instance.pid})"
                if instance
                else ""
            )
            service = (
                "current service unchanged"
                if args.configure_only
                else f"service ready{location}"
            )
            print(f"Autostart enabled via {result.status.manager}; {service}.")
            return 0
        if args.autostart_command == "disable":
            result = (
                self.manager.configure_autostart(False, timeout=args.timeout)
                if args.configure_only
                else self.manager.disable_autostart(timeout=args.timeout)
            )
            service = "; current service unchanged" if args.configure_only else ""
            print(f"Autostart disabled via {result.status.manager}{service}.")
            return 0
        if args.autostart_command == "repair":
            status = self.manager.repair_autostart(self._options(args))
            state = "registered" if status.enabled else "not registered"
            print(f"Autostart {state} via {status.manager}.")
            return 0

        payload = asdict(self.manager.autostart_status())
        definition = payload.get("definition")
        if isinstance(definition, Path):
            payload["definition"] = str(definition)
        # ASCII-escaped for the same pipe-encoding reason as ``_status``.
        print(json.dumps(payload, indent=2))
        return 0

    @staticmethod
    def _options(args: argparse.Namespace) -> ServerOptions:
        return ServerOptions(
            host=args.host,
            port=args.port,
            log_level=args.log_level,
            reload=getattr(args, "reload", False),
        )

    def _parser(self) -> argparse.ArgumentParser:
        parser = argparse.ArgumentParser(
            prog="amphi server",
            description="Start, stop, inspect, or configure Bridgic Agent service autostart.",
        )
        commands = parser.add_subparsers(dest="command", required=True)

        start = commands.add_parser("start", help="Start the service in the background.")
        self._add_serve_options(start)
        start.add_argument(
            "--timeout",
            type=self._non_negative_timeout,
            default=ServerManager.DEFAULT_START_TIMEOUT,
        )

        stop = commands.add_parser("stop", help="Stop the registered service.")
        stop.add_argument(
            "--timeout",
            type=self._non_negative_timeout,
            default=ServerManager.DEFAULT_STOP_TIMEOUT,
        )
        stop.add_argument("--force", action="store_true")

        restart = commands.add_parser("restart", help="Stop and start the service.")
        self._add_serve_options(restart)
        restart.add_argument(
            "--timeout",
            type=self._non_negative_timeout,
            default=ServerManager.DEFAULT_START_TIMEOUT,
        )
        restart.add_argument(
            "--stop-timeout",
            type=self._non_negative_timeout,
            default=ServerManager.DEFAULT_STOP_TIMEOUT,
        )
        restart.add_argument("--force", action="store_true")

        commands.add_parser("status", help="Print service status as JSON.")

        serve = commands.add_parser("serve", help="Run the service in the foreground.")
        self._add_serve_options(serve)
        serve.add_argument("--reload", action="store_true")

        autostart = commands.add_parser(
            "autostart",
            help="Manage macOS launchd or Windows login autostart.",
        )
        autostart_commands = autostart.add_subparsers(
            dest="autostart_command",
            required=True,
        )
        enable = autostart_commands.add_parser(
            "enable",
            help="Configure login autostart and start the service.",
        )
        self._add_serve_options(enable)
        enable.add_argument(
            "--timeout",
            type=self._non_negative_timeout,
            default=ServerManager.DEFAULT_START_TIMEOUT,
        )
        enable.add_argument(
            "--configure-only",
            action="store_true",
            help="Update login startup without changing the running service.",
        )

        disable = autostart_commands.add_parser(
            "disable",
            help="Stop the service and remove login autostart.",
        )
        disable.add_argument(
            "--timeout",
            type=self._non_negative_timeout,
            default=ServerManager.DEFAULT_STOP_TIMEOUT,
        )
        disable.add_argument(
            "--configure-only",
            action="store_true",
            help="Update login startup without changing the running service.",
        )
        repair = autostart_commands.add_parser(
            "repair",
            help=(
                "Point the login autostart registration at this installation "
                "without starting the service. Used by the Windows installer."
            ),
        )
        self._add_serve_options(repair)

        autostart_commands.add_parser("status", help="Print autostart status as JSON.")
        return parser

    def _add_serve_options(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument("--host", default=ServerOptions.host)
        parser.add_argument(
            "--port",
            type=self._port,
            default=ServerOptions.port,
        )
        parser.add_argument(
            "--log-level",
            default=ServerOptions.log_level,
            choices=self.LOG_LEVELS,
        )

    @staticmethod
    def _port(value: str) -> int:
        port = int(value)
        if not 1 <= port <= 65535:
            raise argparse.ArgumentTypeError("port must be between 1 and 65535")
        return port

    @staticmethod
    def _non_negative_timeout(value: str) -> float:
        timeout = float(value)
        if not math.isfinite(timeout) or timeout < 0:
            raise argparse.ArgumentTypeError(
                "timeout must be a finite non-negative number"
            )
        return timeout


__all__ = ["ServerCLI"]
