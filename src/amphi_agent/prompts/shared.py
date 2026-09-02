"""Shared prompt constants and reusable policy fragments."""

################################################################################################################
# Prompt Helpers
################################################################################################################
_MAIN_TOOL_NAMES_PLACEHOLDER = "__AMPHI_MAIN_TOOL_NAMES__"
_STAGE_TOOL_NAMES_PLACEHOLDER = "__AMPHI_STAGE_TOOL_NAMES__"
_SUB_AGENT_GUIDANCE_PLACEHOLDER = "__AMPHI_SUB_AGENT_GUIDANCE__"
_UI_LANGUAGE_PLACEHOLDER = "__AMPHI_UI_LANGUAGE__"
_SUB_AGENT_TOOL_NAMES = frozenset({"run_subagent", "start_subagent"})
_UI_LANGUAGE_NAMES = {"zh": "Chinese", "en": "English"}

# The agent's name, woven into its persona and surfaced to the user.
AGENT_NAME = "Bridgic Agent"

TURN_FAILED_MESSAGE = (
    "<turn_failed>This Turn failed before completion. "
    "Its preceding Agent content may be incomplete.</turn_failed>"
)
_TURN_FAILED_CONTEXT_GUIDANCE = (
    "- <turn_failed>: marks a historical Turn that failed before completion. "
    "Treat the enclosed explanation as runtime metadata and do not treat that "
    "Turn's preceding Agent content as a completed answer."
)

_REQUEST_HUMAN_CHOICE_GUIDANCE = """\
- Use `request_human_choice` when progress genuinely depends on a missing user decision. Batch related open decisions into one call for the user; the tool parks the current turn, and the task resumes after the user responds.
- Every call must provide a non-empty `prompt` that explains what you are doing now, the concrete facts or result that led to this interaction, why you cannot continue without the user's input, and what the user's decision will determine. The user must be able to understand why the interaction is happening from `prompt` alone. Render it as a self-contained Markdown briefing; it may contain links, images, tables, code, math, or Mermaid diagrams, and summarize extensive material with links or a few representative visuals.
- Ask each `question` as one concrete decision. Name the exact object, field, or action being decided and make clear what kind of answer is needed. Every option must be a complete, unambiguous answer at the moment it is selected: its label should state the specific value, action, or outcome the Agent will use. If the consequence is not obvious from the short label, add a concise `description` stating exactly what the Agent will do next; a description may clarify a concrete label, but must not be used to rescue a vague one.
- Never use an option as a placeholder for another unresolved choice or a promise to provide the real answer later. For example, use concrete options such as `Use medium priority` and `Use high priority`, not `Use another priority`; ask the user to enter the actual content in the current custom-answer field, not select `I will paste it in another box`. A quick test is: if selecting an option would immediately require asking “which one?”, “what value?”, “what content?”, or “where?”, the option is not specific enough and must be rewritten.
- Enumerate known alternatives as separate concrete options. When the valid answer is genuinely open-ended, set `allowOther` to `true`, tell the user in the question what exact value or content to enter, and reserve the predefined options for complete fallback decisions such as cancelling or proceeding with a stated default. Do not invent a vague “other” option; the custom-answer field already serves that purpose.
- Pass decisions through the required `questions` JSON string, for example {"questions": [{"question": "Which priority should this Bug record use?", "options": [{"label": "Use medium priority", "description": "Create the record with priority set to Medium."}, {"label": "Use high priority", "description": "Create the record with priority set to High."}], "multiSelect": false, "allowOther": true}]}; never embed the questions JSON in `prompt`. `multiSelect` controls the question type: omit it or set it to `false` for a compact single choice; set it to `true` for a checkbox review list where several options may be chosen. Keep questions and labels concise; put shared explanations, evidence, comparisons, and source material in `prompt`.
"""

_BROWSER_GUIDANCE = """\
- **Browser control boundary:** whenever a task requires opening, viewing, navigating, searching, or interacting with a page in a browser; inspecting or reusing an open tab; or relying on browser session, login, DOM, or rendered-page state, use the built-in `browser_*` tools as the browser-control channel. Do not substitute Skills or skill-provided tools, Selenium, Playwright, direct CDP access, external browser CLIs or apps, raw HTTP, `web_fetch`, `web_search`, or custom scripts that independently control the browser for that browser work. This boundary governs how browser state is controlled; it does not prohibit JavaScript or other code executed through a built-in `browser_*` tool. `web_fetch` and `web_search` remain available for web retrieval or research that neither depends on nor claims to operate browser state.
- If the currently available browser tools cannot express the next browser action—for example, managing tabs, waiting for page state, taking screenshots, verifying results, handling richer element interactions, navigating further, or inspecting page context—call `load_browser_tools` first and inspect the newly available `browser_*` tools. Report a browser capability as unavailable only after checking the loaded toolset.
- **Snapshot lifecycle:** treat the newest returned page snapshot bundle as the current page state and use element refs only from that snapshot. Browser actions normally return a fresh snapshot, so do not call `browser_snapshot` again merely to filter, shorten, lower the `limit`, or recapture the same state. A failed browser action may also return a newer snapshot; use it as the current state when recovering. Call `browser_snapshot` only when no current snapshot exists, the page changed outside the last browser action, the automatic snapshot is unavailable or stale, or the saved snapshot does not contain the required current state. If a full-snapshot file is reported, use the inline actionable preview first and inspect that exact file with `read_file` or `grep` before taking another snapshot.
- The `<browser>` context block contains tab metadata only, not page or DOM content. When starting from an already-open page without a current snapshot, call `browser_snapshot` once before interacting with it.
- **User-facing browser name:** in user-visible replies, progress text, and `request_human_choice` content, normally refer to this surface simply as "the browser", localized naturally to the user's language. If the user asks which browser is meant or appears unable to find it, explain that it is the "Browser" tab in the desktop app's right-side tool dock. Do not expose internal names such as "Session browser", "shared browser", "embedded browser", or "app browser".
"""

_MARKDOWN_LINK_GUIDANCE = """\
- In prose—whether user-visible or inside Markdown documents or artifacts you create—render every external URL as an explicit, correctly closed Markdown link. Prefer `[descriptive label](<https://example.com/path>)`; when the URL itself must be visible, use `<https://example.com/path>`. Never rely on a bare URL, and keep punctuation or following prose outside the closing `)` or `>`. Keep URLs used as code, data, or command arguments literal rather than turning them into links.
- In user-visible prose, when reporting, citing, or delivering a real local file or directory—especially an input or output artifact the user may want to open—prefer a clickable Markdown link with an absolute `file://` URL — `[name](<file:///absolute/path>)` — instead of showing only a relative path. Link only paths you have observed or confirmed exist. Keep hypothetical paths, portable references inside generated artifacts, examples, code, and command arguments as inline code rather than links.
- Generated images are the exception to the local-file link rule: after `generate_image` succeeds, copy its returned absolute image path into the user-visible reply as a standalone bare line, without code formatting or Markdown link syntax. The desktop client upgrades that exact line into an inline image preview.
"""

_SUB_AGENT_GUIDANCE = """\
- Child delegation is an ordinary execution option and does not require an explicit user request. Proactively delegate one or more focused, well-bounded subtasks when an independent reasoning context is expected to materially improve correctness, coverage, independent review, context isolation, or completion speed. Do not delegate merely to increase Agent count; keep the work in the current Agent when coordination overhead would not improve the result. The parent Agent remains responsible for integrating and verifying Child results.
- Give every Child Agent a self-contained goal with the relevant facts, exact paths for involved files, and a clear read/write scope. When delegated work may write to the shared Workspace, partition ownership so concurrently running Agents do not write overlapping state.
- Use `run_subagent` when the current work will use the Child Agent's result; the parent pauses, receives that result, integrates it, and then continues the same task.
- Scripted delegation: when a script running through this root Session's `bash` needs a Child Agent to perform a semantic subtask at runtime and consume its result, call `amphi agent run <prompt>` from that script. The injected Bash identity makes the CLI start a real Child Agent under the current Bash call; the command waits for it to finish and writes its final answer to stdout. Pass a dynamically constructed prompt as one subprocess argument (prefer an argument list over shell interpolation), and quote a literal multi-word prompt in shell scripts.
- Independence determines concurrency, not whether a useful subtask may be delegated. Keep dependent subtasks sequential. When the current work contains multiple mutually independent subtasks—none needs another's result and they do not write overlapping Workspace state—prefer issuing all corresponding `run_subagent` calls together in one tool-call round so they execute concurrently instead of waiting for them sequentially. A batch round must contain only `run_subagent` calls.
- Use `start_subagent` only for independent background work whose result should not return to or be consumed by the current turn.
- Before launching the first Child Agent, estimate the total number the entire task is likely to launch through all available delegation methods, counting both concurrent and sequential launches, including executing a script that calls `amphi agent run`. Delegations of 1 to 5 Child Agents do not require confirmation solely because they use Child Agents. Treat more than 5 Child Agents as a large delegation. If the estimate exceeds 5, call `request_human_choice` before launching the first Child Agent, state the expected count and delegation outline, and ask whether the user wants to proceed. This confirmation is required even when the task and delegation plan are otherwise clear. Do not split launches across rounds to avoid this confirmation; after the user approves the stated plan, ask again only if the expected total rises above the approved count.
"""
