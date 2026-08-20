from types import SimpleNamespace

from bridgic.core.model.types import Role

from src.amphi_agent import AmphiContext, AmphiOTAContext
from src.amphi_agent._cognitive import VOLATILE_TAIL_EXTRA, MainThink


def _workspace(changed: list[str]) -> SimpleNamespace:
    return SimpleNamespace(
        checkpoints=SimpleNamespace(
            changed_files_context_lines=lambda **_options: list(changed),
            checkpoint_context_lines=lambda **_options: [],
        ),
        work_dir=SimpleNamespace(is_dir=lambda: False),
        mount_roots=lambda: [],
        build=None,
        run_workflow=None,
        build_checkpoint=lambda: None,
        run_workflow_checkpoint=lambda: None,
        environment=SimpleNamespace(
            os_name="Darwin",
            os_release="25.0.0",
            architecture="arm64",
            python_executable=None,
            python_version=None,
            node_executable=None,
            node_version=None,
        ),
    )


def _browser(title: str) -> SimpleNamespace:
    tab = SimpleNamespace(title=title, url="https://example.test/")

    async def state() -> SimpleNamespace:
        return SimpleNamespace(tabs=[tab], active_tab=tab)

    return SimpleNamespace(state=state)


async def test_live_state_stays_outside_the_stable_prompt_prefix() -> None:
    """Changing workspace and browser state only changes the volatile request tail."""
    worker = MainThink()
    ota_context = AmphiOTAContext(user_input="Inspect the workspace")
    first_context = AmphiContext.model_construct(
        workspace=_workspace(["- Changed files: none"]),
        browser=_browser("First tab"),
    )
    second_context = AmphiContext.model_construct(
        workspace=_workspace(["- Changed files:", "  - New File: notes.txt"]),
        browser=_browser("Second tab"),
    )

    first_prefix = await worker.assemble_messages(ota_context, first_context)
    second_prefix = await worker.assemble_messages(ota_context, second_context)
    first_request = await worker.append_runtime_state(first_prefix, ota_context, first_context)
    second_request = await worker.append_runtime_state(second_prefix, ota_context, second_context)

    assert first_request[:-1] == second_request[:-1]
    system = first_request[0].content
    assert "Changed files" not in system
    assert "First tab" not in system
    assert "Second tab" not in system

    first_tail = first_request[-1]
    second_tail = second_request[-1]
    assert first_tail.role is Role.USER
    assert second_tail.role is Role.USER
    assert (first_tail.extras or {}).get(VOLATILE_TAIL_EXTRA) is True
    assert (second_tail.extras or {}).get(VOLATILE_TAIL_EXTRA) is True
    assert "Changed files: none" in first_tail.content
    assert "First tab" in first_tail.content
    assert "New File: notes.txt" in second_tail.content
    assert "Second tab" in second_tail.content
