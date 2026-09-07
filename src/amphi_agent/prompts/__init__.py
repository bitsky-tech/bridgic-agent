"""Composable system-prompt templates for the agent's cognitive modes.

Root modules own general-agent prompts, shared fragments, and rendering helpers.
Each mode package owns its shared fragments and one module per stage. Mode
prompts may import root fragments; root modules must not import mode packages.
Mode package exports expose their stage templates to cognitive workers.
"""
