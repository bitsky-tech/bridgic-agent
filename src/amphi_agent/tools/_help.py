from bridgic.core.agentic.tool_specs import FunctionToolSpec


PRODUCT_CAPABILITIES_HELP = """\
# What this Agent is designed for

This Agent can take a goal from conversation to verified work. It can reason with the current conversation, inspect and change files, write and run code, use the web or an interactive browser, apply specialized Skills, and leave durable artifacts that can be inspected and reused.

For ordinary one-off work, describe the desired outcome directly. Include the relevant files with `@`, define constraints or completion criteria when they matter, and let the Agent choose an appropriate combination of tools. It can plan, implement, run commands and tests, inspect the result, and explain what changed. It verifies completed work where practical and asks for approval when an action requires it.

# Reusable Workflows

Workflows turn a successful way of doing something into a reusable, reviewable process. They can combine ordered instructions, deterministic scripts, Agent judgment, tool use, and human decisions instead of behaving like a fixed macro.

- Build a Workflow with `/build`: Choose `/build` from the `/` menu for a repeatable task, especially when its steps or deliverables should be made explicit. The Build process clarifies the task, explores real tools and Skills, generates the Workflow, verifies it, and asks for confirmation before saving it.
  - Example: Choose `/build`, then enter: `Given a folder of customer interviews, group recurring themes, cite the source files, and produce a Markdown report with traceable evidence.`
- Run a saved Workflow: Choose it from the `/` menu and add the inputs or requirements for this Run. A Run uses a stable snapshot of the Workflow, can continue after interruption, executes its sections in order, and publishes a durable result when execution reaches a terminal outcome.
  - Example: Choose `Customer interview analysis` from the `/` menu, then add: `Analyze @Interviews/ and write the final report in Chinese.`
- Modify a saved Workflow: Reference its definition with `@` and describe the change in natural language. The Agent reopens the Build process in edit mode and preserves unaffected requirements and files. After review and verification, you can either overwrite the original Workflow or save the edited version as a new Workflow.
  - Example: `@Customer interview analysis Add a duplicate-check step before clustering themes, and keep everything else unchanged.`
- Remove a saved Workflow: Reference it with `@` and ask the Agent to delete it. The saved definition and source package are removed, while active pinned Runs and published Run results remain available.
  - Example: `Delete @Customer interview analysis; keep its past Run results.`
- Reuse past results: Reference a completed Workflow Run with `@` to inspect its result files, compare Runs, or use an earlier result as input to new work.
  - Example: `Compare @Customer interview analysis · latest result with the previous result and summarize what changed.`

A useful distinction: selecting a saved Workflow from `/` executes it; selecting the Workflow definition or one of its past results from `@` only brings that resource into the current context.

# Multi-Agent work

The Agent may proactively delegate a focused, well-bounded part of a task when an independent reasoning context is expected to improve correctness, coverage, review quality, or completion speed; no explicit user request or separate multi-Agent slash command is required. You can also ask for delegation directly in natural language.

- When the current answer depends on the delegated work, the parent Agent waits for the Child Agents, combines their results, and remains responsible for the final answer. Mutually independent parts can run in parallel; dependent parts can be delegated sequentially.
  - Example: `Use multiple Agents in parallel: have one inspect the backend, one trace the frontend flow, and one review the tests, then combine their findings into one recommendation.`
- For work that should continue independently, explicitly ask for a background Agent. It receives its own durable task that can be inspected or continued separately; its result is not automatically merged into the current turn.
  - Example: `Start a background Agent to audit the test suite while we continue designing the API here.`
- When a task is expected to use more than five Child Agents in total, the Agent first presents the expected count and delegation outline and asks whether to proceed.

# Skills and `/how-to`

Skills give the Agent specialized instructions and repeatable methods for particular domains. Choose an enabled Skill from the Skills section of the `/` menu to ask the Agent to use it for the current request, or ask the Agent to discover and manage Skills when a capability is missing.

`/how-to` is the built-in `how-to` Skill shown in the Skills section of the `/` menu. When it is enabled, give it a concrete task to search the curated Skill catalogue, select a small suitable set of Skills, inspect whether they fit the environment, and return an auditable implementation plan. Using `how-to` produces a plan in the current turn; it does not execute the plan. Ask the Agent to carry out the plan in a following turn.

- Example: `Choose /how-to, then ask: Find the best Skills for turning a month of meeting notes into a decision-and-action report.`
- During `/build`, the Explore stage also looks for suitable Skills before inventing an ad hoc implementation for non-trivial work.

# Scheduling and recurring work

Schedules turn a natural-language goal into recurring Agent work.

- Choose `/schedule` from the `/` menu to open a guided draft for the task description, Schedule name, and recurrence.
- Ask naturally to list, inspect, update, pause, resume, or delete Schedules.
- Choose an existing Schedule from the `/` menu to run it once immediately.
- Reference a Schedule with `@` when the goal is to inspect or change it without running it.

Each scheduled execution has its own task and history, so its progress and result remain inspectable.

# Composer shortcuts

Type `/` to open one menu for fixed commands and executable capabilities:

- `/help` reviews product capabilities and gives guidance grounded in the current conversation.
- `/build` starts the reusable Workflow Build process for the following request when selected from the menu.
- `/schedule` opens the guided Schedule draft when selected from the menu.
- `/<Skill name>` asks the Agent to use an enabled Skill for the current request; `/how-to` is one such built-in Skill.
- `/<Workflow name>` runs a saved Workflow.
- `/<Schedule name>` runs an existing Schedule once now.

Type `@` to attach a specific resource as context without executing it:

- A Session file or folder gives the Agent the exact material to read or change.
- A saved Workflow definition can be explained, compared, or modified.
- A past Workflow Run exposes its published result for inspection or reuse.
- A Schedule can be inspected, updated, paused, resumed, or deleted.

In short, `/` selects an action or capability; `@` identifies the concrete material or saved object that the action should use.

# Good requests to try

- `Review @src/ for reliability risks, fix the high-confidence issues, and run the relevant tests.`
- Choose `/build`, then enter: `Turn @raw-data/ into a weekly report with source citations.`
- `Modify @Weekly report so it also exports CSV, without changing the existing Markdown output.`
- `Use multiple Agents to research the alternatives independently, then recommend one with evidence.`
- Choose `/schedule`, then use a goal such as `Every weekday morning, review the latest project status and produce a short risk digest.`
"""


async def help() -> str:
    """Return the user-facing product capability reference."""
    return PRODUCT_CAPABILITIES_HELP


help_tool = FunctionToolSpec.from_raw(help)

__all__ = ["PRODUCT_CAPABILITIES_HELP", "help", "help_tool"]
