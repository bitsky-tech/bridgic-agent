"""Command-line entry point for local PPT template index maintenance."""

from .amphi_agent.ppt_rag import ppt_rag_cli


if __name__ == "__main__":
    raise SystemExit(ppt_rag_cli())
