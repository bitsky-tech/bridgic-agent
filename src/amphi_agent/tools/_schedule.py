from typing import List, Optional

from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec

from .._schedules import Schedule, ScheduleLibrary
from ...amphi_service.i18n import backend_i18n


def _library() -> ScheduleLibrary:
    agent = current_agent.get(None)
    schedules = getattr(getattr(agent, "ctx", None), "schedules", None)
    if not isinstance(schedules, ScheduleLibrary):
        raise ValueError(backend_i18n.text("agent.schedule.catalogue_unavailable"))
    return schedules


_TRUE_STRINGS = frozenset({"true", "1", "yes", "on"})
_FALSE_STRINGS = frozenset({"false", "0", "no", "off"})
# The model's way of writing "don't filter by this flag". ``"None"`` (capital N =
# Python's ``str(None)``) was observed in the wild; accept the JSON spelling too.
# NOT including ``""`` — an empty string is garbage, not an omission.
_NULL_STRINGS = frozenset({"none", "null"})


def _coerce_optional_bool(value: object) -> Optional[bool]:
    """Coerce an LLM-supplied ``enabled`` flag to a real ``bool``.

    Tool arguments come from the model and — despite the boolean tool schema —
    may surface as the *strings* ``"True"`` / ``"false"`` / ``"1"`` etc. Passing
    those straight through reaches the boolean DB column and raises
    ``Not a boolean value: 'True'``. ``None`` (omitted field) stays ``None``;
    real bools pass through; recognised string / int forms map; anything else
    raises so a garbled value fails loudly instead of silently defaulting.

    Stringified nulls (``"None"`` / ``"null"``) also map to ``None``: that is the
    model spelling "don't filter by this flag", which is what tri-state ``None``
    already means. Rejecting them made the model retry with byte-identical
    arguments instead of self-correcting.
    """
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in _NULL_STRINGS:
            return None
        if lowered in _TRUE_STRINGS:
            return True
        if lowered in _FALSE_STRINGS:
            return False
    elif isinstance(value, int):  # 0/1 from some serializers (bool handled above)
        return bool(value)
    # Name the fix in the message — the model reads this and must be able to act
    # on it, otherwise it burns a round retrying the same value.
    raise ValueError(backend_i18n.text("agent.schedule.invalid_enabled", value=value))


_CRON_WRAPPERS = ("`", "'", '"')


def _normalize_cron(cron: Optional[str]) -> Optional[str]:
    """Strip whitespace and ONE layer of surrounding quotes/backticks the model
    often adds.

    The prompt and tool docs render cron in backticks, so the model readily
    echoes ``` `0 0 9 * * *` ``` or ``'0 0 9 * * *'`` — which croniter rejects
    outright (``CroniterNotAlphaError``). Unwrap a *matched* pair only; an
    unmatched quote is left untouched so a genuinely malformed value still fails
    loudly downstream rather than being silently "fixed" wrong. ``None`` stays
    ``None`` for update's 'omitted → unchanged' semantics.
    """
    if cron is None:
        return None
    text = cron.strip()
    for quote in _CRON_WRAPPERS:
        if len(text) >= 2 and text[0] == quote and text[-1] == quote:
            return text[1:-1].strip()
    return text


def _summary(schedule: Schedule) -> str:
    status = backend_i18n.text(
        "agent.schedule.status_enabled" if schedule.enabled else "agent.schedule.status_paused",
    )
    next_run = schedule.next_run_at.isoformat(timespec="minutes") if schedule.next_run_at else backend_i18n.text("agent.schedule.none")
    return (
        f"{schedule.name} (id={schedule.schedule_id}, status={status}, "
        f"cron=`{schedule.cron}`, next={next_run})"
    )


async def create_schedule(name: str, desc: str, cron: str, refs: Optional[List[str]] = None) -> str:
    """Create a recurring scheduled task from a complete natural-language goal.

    Parameters
    ----------
    name : str
        Short display name.
    desc : str
        Complete task to execute on every run.
    cron : str
        Six-field cron in ``sec min hour dom mon dow`` order.
    refs : list[str], optional
        Referenced Workflow IDs or Skill names for display.

    Returns
    -------
    str
        Confirmation containing the stable schedule id.
    """
    schedule = await _library().create(name, desc, _normalize_cron(cron), refs)
    return backend_i18n.text(
        "agent.schedule.created", summary=_summary(schedule), description=schedule.description,
    )


async def update_schedule(
    schedule_id: str,
    name: Optional[str] = None,
    desc: Optional[str] = None,
    cron: Optional[str] = None,
    enabled: Optional[bool] = None,
) -> str:
    """Update only the supplied fields of an existing scheduled task.

    Parameters
    ----------
    schedule_id : str
        Stable id obtained from ``<schedules>`` or ``list_schedules``.
    name, desc, cron, enabled : optional
        Fields to change; omitted fields are retained.

    Returns
    -------
    str
        Confirmation containing the resulting schedule state.
    """
    schedule = await _library().update(
        schedule_id,
        name=name,
        description=desc,
        # Unwrap quotes/backticks the model may add before croniter validates.
        cron=_normalize_cron(cron),
        # Model may send the bool as a string ("True"); coerce at the boundary
        # before it reaches the boolean DB column. See _coerce_optional_bool.
        enabled=_coerce_optional_bool(enabled),
    )
    return backend_i18n.text(
        "agent.schedule.updated", summary=_summary(schedule), description=schedule.description,
    )


async def _kill_inflight(schedule_id: str) -> None:
    """Best-effort cancel of any run the scheduler currently has in flight for
    this schedule, so deletion also stops a run already executing (parity with
    the REST ``DELETE``). The scheduler is reachable only through the runtime
    ``AgentInvocation`` bound to the Agent context; absent it (e.g. tests
    without a daemon) this is a no-op.
    """
    agent = current_agent.get(None)
    invocations = getattr(getattr(agent, "ctx", None), "invocations", None)
    killer = getattr(invocations, "kill_schedule", None)
    if killer is not None:
        await killer(schedule_id)


async def delete_schedule(schedule_id: str) -> str:
    """Delete an existing scheduled task and cancel any run already in flight.

    Parameters
    ----------
    schedule_id : str
        Stable id obtained from ``<schedules>`` or ``list_schedules``.

    Returns
    -------
    str
        Confirmation naming the deleted schedule.
    """
    schedule = await _library().delete(schedule_id)
    await _kill_inflight(schedule.schedule_id)
    return backend_i18n.text("agent.schedule.deleted", summary=_summary(schedule))


async def list_schedules(query: str = "", enabled: Optional[bool] = None) -> str:
    """List scheduled tasks, optionally filtered by text and enabled state.

    ``async`` (despite the sync body) so it runs in the agent task where the
    ``current_agent`` ContextVar is set — a sync tool runs in a thread-pool
    executor that drops contextvars, and ``_library()`` would then raise
    'No schedule catalogue is available'. Every other agent tool is async too.
    """
    # Same boundary coercion as update_schedule: a stringified filter would
    # otherwise silently match nothing (`schedule.enabled is 'true'` → False).
    schedules = _library().search(query, enabled=_coerce_optional_bool(enabled))
    if not schedules:
        return backend_i18n.text("agent.schedule.no_matches")
    return "\n".join(f"- {_summary(schedule)}" for schedule in schedules)


async def get_schedule(schedule_id: str) -> str:
    """Read one scheduled task's complete goal and current timing state.

    ``async`` for ContextVar access — see ``list_schedules`` (a sync tool runs
    in a thread-pool executor where ``current_agent`` is lost).
    """
    schedule = _library().get((schedule_id or "").strip())
    if schedule is None:
        raise ValueError(backend_i18n.text("agent.schedule.not_found", schedule_id=schedule_id))
    refs = ", ".join(schedule.refs) if schedule.refs else backend_i18n.text("agent.schedule.none")
    return backend_i18n.text(
        "agent.schedule.detail", summary=_summary(schedule), description=schedule.description, refs=refs,
    )


create_schedule_tool = FunctionToolSpec.from_raw(create_schedule)
update_schedule_tool = FunctionToolSpec.from_raw(update_schedule)
delete_schedule_tool = FunctionToolSpec.from_raw(delete_schedule)
list_schedules_tool = FunctionToolSpec.from_raw(list_schedules)
get_schedule_tool = FunctionToolSpec.from_raw(get_schedule)

__all__ = [
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
]
