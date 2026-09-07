"""Composable system-prompt templates for the agent's cognitive modes.

Root modules own general-agent prompts, shared fragments, and rendering helpers.
Each mode package owns its shared fragments and one module per stage. Mode
prompts may import root fragments; root modules must not import mode packages.
Package exports preserve the existing public imports used by cognitive workers
and the legacy ``amphi_agent._prompt`` facade.
"""
