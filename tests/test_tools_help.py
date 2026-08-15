from src.amphi_agent._agent import AmphiAgent
from src.amphi_agent._cognitive import BuildThink, MainThink, WorkflowRunThink
from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_agent.tools._help import PRODUCT_CAPABILITIES_HELP, help


async def test_help_returns_product_capabilities() -> None:
    result = await help()

    assert result == PRODUCT_CAPABILITIES_HELP
    assert "/build" in result
    assert "Modify a saved Workflow" in result
    assert "overwrite the original Workflow or save the edited version as a new Workflow" in result
    assert "Remove a saved Workflow" in result
    assert "no explicit user request or separate multi-Agent slash command is required" in result
    assert "`/how-to` is the built-in `how-to` Skill" in result
    assert "Choose an existing Schedule from the `/` menu to run it once" in result
    assert "`/` selects an action or capability" in result
    assert "`@` identifies the concrete material" in result


def test_help_is_main_only_and_hidden_from_tool_events() -> None:
    registered = {spec.tool_name for spec in TOOL_LIBRARY.all()}

    assert "help" in registered
    assert "help" in MainThink.allowed_tools
    assert "help" not in BuildThink.allowed_tools
    assert "help" not in WorkflowRunThink.allowed_tools
    assert "help" in AmphiAgent().no_display_tools
