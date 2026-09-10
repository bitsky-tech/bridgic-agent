"""Composable system-prompt templates for the agent's cognitive modes.

Root modules own shared fragments, utility prompts, and rendering helpers.
Normal conversation templates live in the normal package. Each business-mode
package owns its shared fragments and one module per stage. Mode prompts may
import root fragments; general prompt code must not import business-mode packages.
Mode package exports expose their templates to cognitive workers.
"""
