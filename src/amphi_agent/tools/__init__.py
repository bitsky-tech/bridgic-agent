"""This agent's own tool surface — owned here so we control their behavior.

* filesystem (``read_file`` / ``write_file`` / ``edit_file`` / ``glob`` /
  ``grep``) — reimplemented (not the framework built-ins) so a path argument
  defaults to the session workspace: relative paths resolve against the
  Session work directory, while absolute paths still work. Keeps the
  read-before-modify invariant and line-numbered, truncation-aware output.
* ``bash_tool`` — self-contained shell execution requiring an explicit
  absolute cwd on every call.
* ``web_search_tool`` — searches the public web through DuckDuckGo, Bing, or
  Baidu and returns links with snippets.
* ``web_fetch_tool`` — fetches public web content, converts HTML to markdown,
  and applies a prompt with the running agent's LLM.
* ``generate_image_tool`` — routes a text prompt to an enabled image-output
  model and saves the generated image in the Session workspace for preview.
* workspace versioning (``workspace_status`` / ``workspace_diff`` /
  ``workspace_history`` / checkpoint / restore) — product-level workspace
  management backed by the session-local Git repository.
* ``request_human_choice_tool`` — this agent's own fixed-option HITL ask
  (its description carries the questions-JSON contract; the act phase
  suspends the turn on its empty result).
* ``run_subagent_tool`` — delegates one focused goal to an isolated Child
  Session and folds its final answer back into the parent tool result.
* ``start_subagent_tool`` — starts the same Child Session as background work
  and lets the parent continue immediately.
* ``remove_workflow_tool`` — removes one saved Workflow definition and its
  canonical source package while retaining Run results.
* ``view_skill_tool`` — reads a Skill's ``SKILL.md`` (or one supporting file)
  from an enabled installed location or the candidate catalogue, confining
  ``file_path`` to the supplied absolute Skill directory.
* skill management tools — ``manage_skills`` lazily loads import/list/enable/
  uninstall tools so the default surface stays small.
* ``switch`` / ``switch_tool`` — the model's write access to the per-turn think
  state (``mode`` + ``stage``). ``switch_tool`` registers it for execution; build
  stages show it explicitly, while normal chat does not.
"""

from __future__ import annotations

from ._bash import bash_tool
from ._browser import (
    BROWSER_ADVANCED_TOOL_NAMES,
    BROWSER_BASIC_TOOL_NAMES,
    BROWSER_TOOL_NAMES,
    browser_tool_specs,
)
from ._filesystem import (
    FILE_SYSTEM_TOOL_NAMES,
    edit_file_tool,
    glob_tool,
    grep_tool,
    read_file_tool,
    write_file_tool,
)
from ._help import help, help_tool
from ._image import generate_image, generate_image_tool
from ._request_human import (
    request_accept_rule_tool,
    request_build_tool,
    request_run_workflow_tool,
    request_human_choice_tool,
    request_human_task_confirm_tool,
    request_human_workflow_confirm_tool,
)
from ._schedule import (
    create_schedule,
    create_schedule_tool,
    delete_schedule,
    delete_schedule_tool,
    get_schedule,
    get_schedule_tool,
    list_schedules,
    list_schedules_tool,
    update_schedule,
    update_schedule_tool,
)
from ._subagent import run_subagent, run_subagent_tool, start_subagent, start_subagent_tool
from ._skills import (
    SKILLS_ADVANCED_TOOL_NAMES,
    SKILLS_BASIC_TOOL_NAMES,
    SKILLS_TOOL_NAMES,
    import_skills,
    import_skills_tool,
    list_skills,
    list_skills_tool,
    manage_skills,
    manage_skills_tool,
    set_skill_enabled,
    set_skill_enabled_tool,
    skills_tool_specs,
    uninstall_skill,
    uninstall_skill_tool,
    view_skill,
    view_skill_tool,
)
from ._switch import switch, switch_tool
from ._web_fetch import web_fetch_tool
from ._web_search import web_search_tool
from ._workflow import (
    EditWorkflow,
    WorkflowStepReport,
    edit_workflow,
    edit_workflow_tool,
    list_workflow_runs,
    list_workflow_runs_tool,
    read_workflow_run,
    read_workflow_run_tool,
    remove_workflow,
    remove_workflow_tool,
    report_workflow_step,
    report_workflow_step_tool,
)
from ._workspace import (
    WORKSPACE_ADVANCED_TOOL_NAMES,
    WORKSPACE_BASIC_TOOL_NAMES,
    WORKSPACE_TOOL_NAMES,
    load_workspace_tools_tool,
    workspace_basic_tool_specs,
    workspace_advanced_tool_specs,
    workspace_checkpoint_tool,
    workspace_diff_tool,
    workspace_history_tool,
    workspace_restore_file_tool,
    workspace_restore_tool,
    workspace_status_tool,
    workspace_tool_specs,
)

__all__ = [
    "bash_tool",
    "help",
    "help_tool",
    "generate_image",
    "generate_image_tool",
    "web_search_tool",
    "web_fetch_tool",
    "edit_workflow",
    "edit_workflow_tool",
    "report_workflow_step",
    "report_workflow_step_tool",
    "list_workflow_runs",
    "list_workflow_runs_tool",
    "read_workflow_run",
    "read_workflow_run_tool",
    "remove_workflow",
    "remove_workflow_tool",
    "EditWorkflow",
    "WorkflowStepReport",
    "browser_tool_specs",
    "BROWSER_BASIC_TOOL_NAMES",
    "BROWSER_ADVANCED_TOOL_NAMES",
    "BROWSER_TOOL_NAMES",
    "read_file_tool",
    "write_file_tool",
    "edit_file_tool",
    "glob_tool",
    "grep_tool",
    "FILE_SYSTEM_TOOL_NAMES",
    "workspace_status_tool",
    "workspace_diff_tool",
    "workspace_history_tool",
    "workspace_checkpoint_tool",
    "workspace_restore_file_tool",
    "workspace_restore_tool",
    "load_workspace_tools_tool",
    "workspace_basic_tool_specs",
    "workspace_advanced_tool_specs",
    "workspace_tool_specs",
    "WORKSPACE_BASIC_TOOL_NAMES",
    "WORKSPACE_ADVANCED_TOOL_NAMES",
    "WORKSPACE_TOOL_NAMES",
    "request_accept_rule_tool",
    "request_human_choice_tool",
    "request_build_tool",
    "request_run_workflow_tool",
    "request_human_task_confirm_tool",
    "request_human_workflow_confirm_tool",
    "create_schedule",
    "create_schedule_tool",
    "delete_schedule",
    "delete_schedule_tool",
    "get_schedule",
    "get_schedule_tool",
    "list_schedules",
    "list_schedules_tool",
    "update_schedule",
    "update_schedule_tool",
    "run_subagent",
    "run_subagent_tool",
    "start_subagent",
    "start_subagent_tool",
    "SKILLS_BASIC_TOOL_NAMES",
    "SKILLS_ADVANCED_TOOL_NAMES",
    "SKILLS_TOOL_NAMES",
    "view_skill",
    "manage_skills",
    "import_skills",
    "list_skills",
    "set_skill_enabled",
    "uninstall_skill",
    "view_skill_tool",
    "manage_skills_tool",
    "import_skills_tool",
    "list_skills_tool",
    "set_skill_enabled_tool",
    "uninstall_skill_tool",
    "skills_tool_specs",
    "switch",
    "switch_tool",
]
