"""Bridgic Agent backend.

The project has four explicit layers:

* ``src.amphi_cli`` - the software command dispatcher.
* ``src.amphi_service`` - the optional HTTP/WebSocket daemon and transport.
* ``src.amphi_agent`` - Agent execution, context, tools, and Workspace.
* ``src.amphi_store`` - durable records and repositories.

The command-line entry is ``python -m src <subcommand>`` (see
:mod:`.amphi_cli`).
"""

__version__ = "0.1.2"


__all__ = ["__version__"]
