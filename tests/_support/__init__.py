"""Reusable test infrastructure shared by multiple test suites.

Helpers are imported from their explicit submodules so a Store-only test run
does not import the Service, Uvicorn, or LLM stacks.
"""
