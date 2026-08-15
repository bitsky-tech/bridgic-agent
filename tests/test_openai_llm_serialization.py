"""Serialization round-trip test for OpenAICompatLlm.

Invariant: a serialized OpenAICompatLlm must reload as an OpenAICompatLlm (with
stream_turn), NOT a bare bridgic OpenAILlm. bridgic's _msgpackx serializer records
the concrete class FQN as the "t" key and reloads via cls.__new__(cls) +
obj.load_from_dict(...). This test pins that contract so a future change that
accidentally inherits the wrong dump_to_dict/load_from_dict doesn't silently
drop stream_turn on reload.

Serialization API (bridgic.core.utils._msgpackx):
  dump_bytes(obj) → msgpack bytes; records {"t": <fqn>, "d": obj.dump_to_dict()}
  load_bytes(data) → deserializes; uses t as fqn, __new__+load_from_dict for Serializable
"""

from bridgic.core.utils._msgpackx import dump_bytes, load_bytes
from bridgic.llms.openai import OpenAIConfiguration

from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm


def _make_llm() -> OpenAICompatLlm:
    """Construct a minimal OpenAICompatLlm matching the factory shape."""
    return OpenAICompatLlm(
        api_key="test-key",
        api_base=None,
        configuration=OpenAIConfiguration(model="gpt-4o", temperature=0.0),
    )


def test_openai_compat_llm_serialization_round_trip() -> None:
    """dump_bytes → load_bytes must reload as OpenAICompatLlm, not bare OpenAILlm.

    This is the riskiest invariant of the streaming-inversion refactor: if
    OpenAICompatLlm accidentally lost its dump_to_dict/load_from_dict or the
    framework fell back to the parent OpenAILlm's serializer, the reloaded
    object would miss stream_turn and break Agent execution after deserialization.
    """
    original = _make_llm()

    # --- serialize ---
    data: bytes = dump_bytes(original)
    assert isinstance(data, bytes) and len(data) > 0

    # --- deserialize ---
    reloaded = load_bytes(data)

    # Must come back as our subclass, not the bare bridgic OpenAILlm.
    assert isinstance(reloaded, OpenAICompatLlm), (
        f"Expected OpenAICompatLlm, got {type(reloaded)}"
    )

    # Protocol marker must survive.
    assert reloaded.protocol == "openai", f"protocol={reloaded.protocol!r}"

    # stream_turn must be present (and be the OpenAICompatLlm override, not missing).
    assert hasattr(reloaded, "stream_turn"), "stream_turn missing after deserialization"

    # Core ctor fields must round-trip.
    assert reloaded.api_key == "test-key"
    assert reloaded.configuration.model == "gpt-4o"
