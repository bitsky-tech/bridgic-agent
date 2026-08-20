import base64

from bridgic.core.agentic.tool_specs import FunctionToolSpec
from bridgic.core.model.types import Message, Role
from bridgic.llms.openai import OpenAIConfiguration
from google.genai import types

from src.amphi_agent._cognitive import VOLATILE_TAIL_EXTRA
from src.amphi_service.protocol.llms._openai_params import sanitize_openai_params, unsupported_param_of
from src.amphi_service.protocol.llms._streaming import convert_tools
from src.amphi_service.protocol.llms.anthropic_llm import AnthropicConfiguration, AnthropicLlm
from src.amphi_service.protocol.llms.codex_llm import CodexConfiguration, CodexResponsesLlm, parse_sse_event
from src.amphi_service.protocol.llms.google_llm import GoogleConfiguration, GoogleLlm
from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm


def test_openai_parameter_rules_follow_the_model_and_endpoint() -> None:
    source = {
        "model": "gpt-5.5",
        "temperature": 0.2,
        "top_p": 0.9,
        "max_tokens": 128,
    }
    official = sanitize_openai_params(source, base_url=None)
    assert official == {"model": "gpt-5.5", "max_completion_tokens": 128}

    compatible = sanitize_openai_params(source, base_url="https://api.deepseek.com/v1")
    assert compatible == official

    standard = {"model": "deepseek-chat", "temperature": 0.2, "max_tokens": 128}
    assert sanitize_openai_params(standard, base_url="https://api.deepseek.com/v1") is standard

    kimi = sanitize_openai_params(source, base_url="https://api.kimi.com/coding/v1")
    assert kimi["temperature"] == 1
    assert kimi["max_tokens"] == 128

    moonshot_source = {"model": "kimi-k2.6", "temperature": 0.0, "max_tokens": 128}
    moonshot = sanitize_openai_params(moonshot_source, base_url="https://api.moonshot.cn/v1")
    assert moonshot["temperature"] == 1

    class InvalidParameterError(RuntimeError):
        body = {"error": {"message": "invalid temperature: only 1 is allowed"}}

    assert unsupported_param_of(InvalidParameterError()) == "temperature"


async def test_openai_wire_omits_the_volatile_cache_marker() -> None:
    """Runtime state remains visible to the model without leaking its internal routing flag."""
    tail_extras = {VOLATILE_TAIL_EXTRA: True}
    messages = [
        Message.from_text("go", role=Role.USER),
        Message.from_text("<runtime_state>changed</runtime_state>", role=Role.USER, extras=tail_extras),
    ]
    configuration = OpenAIConfiguration(model="gpt-4o")
    llm = OpenAICompatLlm(api_key="test-key", api_base="https://relay.example.test/v1", configuration=configuration)
    try:
        wire = llm._build_parameters(messages=messages)["messages"]
    finally:
        llm.client.close()
        await llm.async_client.close()

    assert wire[-1]["content"].startswith("<runtime_state>")
    assert VOLATILE_TAIL_EXTRA not in wire[-1]
    assert messages[-1].extras == {VOLATILE_TAIL_EXTRA: True}


async def test_anthropic_wire_contract_preserves_tools_and_role_order() -> None:
    async def run_command(command: str) -> str:
        """Run a command and return its output."""
        return command

    llm = AnthropicLlm(
        api_key="test-key",
        configuration=AnthropicConfiguration(model="claude-test"),
    )
    try:
        tools = convert_tools([FunctionToolSpec.from_raw(run_command).to_tool()], "anthropic")
        system, messages = llm._extract_system_and_messages(
            [
                Message.from_text("system", role=Role.SYSTEM),
                Message.from_text("first", role=Role.USER),
                Message.from_text("second", role=Role.USER),
            ]
        )
        assert system == "system"
        assert tools[0]["name"] == "run_command"
        assert "command" in tools[0]["input_schema"]["properties"]
        assert [message["role"] for message in messages] == ["user"]
        assert [block["text"] for block in messages[0]["content"]] == ["first", "second"]
    finally:
        llm.client.close()
        await llm.async_client.close()


async def test_google_wire_contract_round_trips_tool_signatures() -> None:
    signature = b"thought-signature"
    llm = GoogleLlm(
        api_key="test-key",
        configuration=GoogleConfiguration(model="gemini-test"),
    )
    try:
        messages = [
            Message.from_text("system", role=Role.SYSTEM),
            Message.from_text("inspect", role=Role.USER),
            Message.from_tool_call(
                tool_calls=[{"id": "call-1", "name": "inspect", "arguments": {"path": "."}}],
                extras={"thought_signatures": [base64.b64encode(signature).decode()]},
            ),
            Message.from_tool_result(tool_id="call-1", content="result"),
        ]
        system, contents = llm._messages_to_contents(messages)
        call = contents[1]["parts"][0]
        response = contents[2]["parts"][0]["function_response"]
        assert system == "system"
        assert call["thought_signature"] == signature
        assert call["function_call"] == {"name": "inspect", "args": {"path": "."}, "id": "call-1"}
        assert response == {"name": "inspect", "response": {"result": "result"}, "id": "call-1"}
        for content in contents:
            types.Content.model_validate(content)
    finally:
        llm.client.close()
        await llm.async_client.aclose()


async def test_codex_wire_contract_builds_a_responses_request() -> None:
    async def inspect(path: str) -> str:
        """Inspect one path."""
        return path

    llm = CodexResponsesLlm(
        access_token="access-token",
        account_id="account-id",
        configuration=CodexConfiguration(model="gpt-codex", temperature=0.7),
    )
    try:
        tools = convert_tools([FunctionToolSpec.from_raw(inspect).to_tool()], "responses")
        body = llm._build_parameters(
            [
                Message.from_text("system", role=Role.SYSTEM),
                Message.from_text("inspect this", role=Role.USER),
            ],
            tools=tools,
        )
        assert llm.responses_url.endswith("/codex/responses")
        assert body["model"] == "gpt-codex"
        assert body["store"] is False and body["stream"] is True
        assert body["instructions"] == "system"
        assert "temperature" not in body
        assert body["tools"][0]["name"] == "inspect"
        assert parse_sse_event('data: {"type":"response.completed"}') == {
            "type": "response.completed"
        }
        assert parse_sse_event("data: [DONE]") is None
    finally:
        llm.client.close()
        await llm.async_client.aclose()
