# CLAUDE.md

These project rules take precedence over an agent's personal or global
configuration. Where the two disagree, this file wins.

## Language

**Everything that lands in this repository MUST be written in English** —
code, comments, docstrings, tests (case names included), docs, commit
messages, and pull request descriptions. The single exception is the i18n
catalogs (`desktop/packages/shared/src/i18n/locales/`): they ARE the
translated copy. Display strings belong there, never inline.

Comments are gated: `bun run check:chinese` fails on any Chinese comment in
`.ts`, `.tsx`, or `.py`, across both halves of the repo. Run it instead of
eyeballing the diff.

The check still skips `__tests__/`, `tests/`, `*.test.ts(x)`, and `docs/`.
That is legacy, not license: the Chinese content already there predates this
rule and has not been migrated yet. New content in those places must be
English like everything else — nothing enforces that yet, so it is on you.
Commit messages and PR descriptions are likewise unchecked.

Two things no check can see:

- **Your personal defaults.** If your global configuration prefers another
  language for comments, ignore it inside this repository.
- **Conversation.** Talk to the user in whatever language they are using. This
  rule governs what lands in the repository, not the chat.

## Coding guidelines

Behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial
tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes,
simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it
work") require constant clarification.

## Verification

The repo has two halves and CI gates them separately. Run the side you touched;
run both when a change spans the wire between them.

```bash
# desktop/ — Electron main, preload, renderer
cd desktop
bun run test          # NOT bare `bun test` — the script loads test-setup.ts,
                      # which pins the i18n language the assertions expect
bun run typecheck
bun run lint
bun run check:chinese # spans the Python backend too, despite living here

# src/ — Python backend, from the repository root
uv run pytest -q --timeout=300 --timeout-method=thread
```

The pytest flags are not decoration. The suite contains a known hang, and
`--timeout-method=signal` (the default) cannot unwind it — the run simply sits
there. Drop the flags once the hang is fixed.
