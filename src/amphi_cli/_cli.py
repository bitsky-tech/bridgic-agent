"""Top-level ``amphi`` command dispatcher."""

from __future__ import annotations

import sys
from collections.abc import Sequence

USAGE = (
    "usage: amphi {server|gateway|agent|serve} [args...]\n"
    "\n"
    "Subcommands:\n"
    "  server start    Start through launchd on macOS when enabled, else detach.\n"
    "  server stop     Stop the currently-registered service.\n"
    "  server restart  Restart while preserving autostart configuration.\n"
    "  server status   Report whether a service is registered and alive.\n"
    "  server serve    Run the service in the foreground (development).\n"
    "  server autostart {enable|disable|status}\n"
    "                  Manage macOS launchd or Windows login autostart.\n"
    "  gateway ...     Alias for `server ...` (GUI-facing nomenclature).\n"
    "  agent run       Run an Agent through the local daemon.\n"
    "  serve           DEPRECATED alias for `server serve`.\n"
    "\n"
    "Run a subcommand with -h to see its own options:\n"
    "  amphi server start -h\n"
    "  amphi agent run -h\n"
    "\n"
    "Low-level equivalent: `python -m src <subcommand>` also works.\n"
)


def dispatch(argv: Sequence[str] | None = None) -> None:
    """Route an ``amphi`` invocation to the matching backend command.

    Parameters
    ----------
    argv : Sequence[str] | None
        Arguments without the program name. ``None`` reads ``sys.argv[1:]``.

    Notes
    -----
    Subcommand implementations are imported lazily so help and error paths do
    not initialize the service or Agent RPC client.
    """
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments or arguments[0] in ("-h", "--help"):
        print(USAGE)
        raise SystemExit(0 if arguments else 1)

    subcommand, rest = arguments[0], arguments[1:]
    if subcommand in ("server", "gateway"):
        from ._server import ServerCLI

        exit_code = ServerCLI().main(rest)
        if exit_code:
            raise SystemExit(exit_code)
        return

    if subcommand == "serve":
        from ._server import ServerCLI

        exit_code = ServerCLI().main(["serve", *rest])
        if exit_code:
            raise SystemExit(exit_code)
        return

    if subcommand == "agent":
        from ._agent import AgentCLI

        raise SystemExit(AgentCLI().main(rest))

    print(f"unknown subcommand: {subcommand!r}\n", file=sys.stderr)
    print(USAGE, file=sys.stderr)
    raise SystemExit(2)


__all__ = ["USAGE", "dispatch"]
