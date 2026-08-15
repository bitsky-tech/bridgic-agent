from bridgic.core.model.types import Message, Response, Role

from src.amphi_agent._describe import describe_commands
from src.amphi_service.i18n import use_locale


class _Llm:
    def __init__(self) -> None:
        self.messages: list[list[Message]] = []

    async def achat(self, messages: list[Message]) -> Response:
        self.messages.append(messages)
        return Response(message=Message.from_text(
            '[{"index": 0, "summary": "读取项目配置"}]',
            role=Role.AI,
        ))


async def test_describe_commands_keeps_fixed_instructions_in_a_stable_system_prefix() -> None:
    llm = _Llm()

    first = await describe_commands(llm, [{"tool": "read_file", "arguments": {"path": "a"}}])
    second = await describe_commands(llm, [{"tool": "read_file", "arguments": {"path": "b"}}])

    assert first == second == ["读取项目配置"]
    assert [message.role for message in llm.messages[0]] == [Role.SYSTEM, Role.USER]
    assert llm.messages[0][0].content == llm.messages[1][0].content
    assert '"path": "a"' in llm.messages[0][1].content
    assert '"path": "b"' in llm.messages[1][1].content


async def test_describe_commands_uses_the_active_backend_locale_for_both_prompts() -> None:
    llm = _Llm()

    with use_locale("en"):
        await describe_commands(llm, [{"tool": "read_file", "arguments": {"path": "a"}}])

    system, user = llm.messages[0]
    assert "non-technical user" in system.content
    assert "Return exactly 1 items." in user.content
    assert "Calls to explain:" in user.content
