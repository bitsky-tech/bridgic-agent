from typing import Dict, Iterable, List

from bridgic.core.agentic.tool_specs import ToolSpec

from .tools import (
    BROWSER_ADVANCED_TOOL_NAMES,
    BROWSER_BASIC_TOOL_NAMES,
    BROWSER_TOOL_NAMES,
    SKILLS_ADVANCED_TOOL_NAMES,
    WORKSPACE_ADVANCED_TOOL_NAMES,
    bash_tool,
    browser_tool_specs,
    create_schedule_tool,
    delete_schedule_tool,
    edit_workflow_tool,
    get_schedule_tool,
    generate_image_tool,
    list_schedules_tool,
    remove_workflow_tool,
    update_schedule_tool,
    edit_file_tool,
    glob_tool,
    grep_tool,
    help_tool,
    list_workflow_runs_tool,
    read_file_tool,
    read_workflow_run_tool,
    request_accept_rule_tool,
    request_build_tool,
    request_run_workflow_tool,
    request_human_choice_tool,
    request_human_task_confirm_tool,
    request_human_workflow_confirm_tool,
    report_workflow_step_tool,
    run_subagent_tool,
    start_subagent_tool,
    skills_tool_specs,
    web_fetch_tool,
    web_search_tool,
    workspace_tool_specs,
    write_file_tool,
)


class ToolLibrary:
    """The agent's tool catalog — every available tool by name (builtins now,
    grouped by the Think workers that expose them.

    Not user data (unlike skills): it's an agent capability, so a single static
    catalog. Each think_unit's ``select_tools`` queries it to decide its turn's
    visible set.
    """

    def __init__(self) -> None:
        specs = [
            bash_tool,
            read_file_tool,
            write_file_tool,
            edit_file_tool,
            glob_tool,
            grep_tool,
            help_tool,
            web_search_tool,
            web_fetch_tool,
            generate_image_tool,
            *browser_tool_specs,
            *workspace_tool_specs,
            *skills_tool_specs,
            request_accept_rule_tool,
            request_build_tool,
            request_run_workflow_tool,
            request_human_choice_tool,
            request_human_task_confirm_tool,
            request_human_workflow_confirm_tool,
            create_schedule_tool,
            delete_schedule_tool,
            edit_workflow_tool,
            get_schedule_tool,
            list_schedules_tool,
            remove_workflow_tool,
            update_schedule_tool,
            report_workflow_step_tool,
            list_workflow_runs_tool,
            read_workflow_run_tool,
            run_subagent_tool,
            start_subagent_tool,
        ]
        self._tools: Dict[str, ToolSpec] = {spec.tool_name: spec for spec in specs}

    def all(self) -> List[ToolSpec]:
        """Every tool in the catalog, in registration order."""
        return list(self._tools.values())

    def core_skills(self) -> List[ToolSpec]:
        """All catalog tools except advanced browser, workspace, and skills tools."""
        advanced_tool_names = (
            BROWSER_ADVANCED_TOOL_NAMES
            | WORKSPACE_ADVANCED_TOOL_NAMES
            | SKILLS_ADVANCED_TOOL_NAMES
        )
        return [s for s in self.all() if s.tool_name not in advanced_tool_names]

    def select(self, names: Iterable[str]) -> List[ToolSpec]:
        """The specs for ``names`` (catalog order, unknown names skipped)."""
        wanted = set(names)
        return [s for s in self.all() if s.tool_name in wanted]

    def get_browser_basic_tools(self) -> List[ToolSpec]:
        return self.select(BROWSER_BASIC_TOOL_NAMES)

    def get_browser_advanced_tools(self) -> List[ToolSpec]:
        return self.select(BROWSER_ADVANCED_TOOL_NAMES)

    def get_browser_tools(self, *, include_advanced: bool = False) -> List[ToolSpec]:
        names = BROWSER_TOOL_NAMES if include_advanced else BROWSER_BASIC_TOOL_NAMES
        return self.select(names)


TOOL_LIBRARY = ToolLibrary()

__all__ = [
    "ToolLibrary",
    "TOOL_LIBRARY",
]
