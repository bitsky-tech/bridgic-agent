import ast
import json
from typing import Any, Dict, List, Literal, Optional
from uuid import uuid4

from bridgic.core.agentic.tool_specs import FunctionToolSpec

from ...amphi_service.i18n import backend_i18n

__all__ = [
    "request_build_tool",
    "request_presentation_tool",
    "request_run_workflow_tool",
    "request_human_choice_tool",
    "request_human_task_confirm_tool",
    "request_human_workflow_confirm_tool",
    "RequestBuild",
    "RequestPresentation",
    "RequestRunWorkflow",
    "RequestHumanChoice",
    "RequestHumanTaskConfirm",
    "RequestHumanWorkflowConfirm",
    "RequestHumanRejection",
]


class RequestHumanRejection(Exception): ...


class RequestBuild:
    """A request to propose or immediately enter reusable Workflow Build."""

    def __init__(self, goal: str, mode: Literal["ask", "start"] = "ask", reason: Optional[str] = None, request_id: Optional[str] = None):
        self.goal = goal
        self.mode = mode
        self.reason = reason
        self.request_id = (request_id or f"build_confirm_{uuid4().hex}") if mode == "ask" else None


async def request_build(goal: str, mode: Literal["ask", "start"] = "ask", reason: str = "") -> RequestBuild:
    """Propose or immediately enter reusable Workflow Build.

    In Main, use ``start`` for explicit new or replacement Build intent. Use
    ``ask`` when a reusable Workflow may help but was not requested, or when a
    retained Build requires the user to choose whether to keep, merge, or
    replace it. In Build, use ``ask`` only for genuinely competing intents. Do
    not use this tool for ordinary one-off work.

    Parameters
    ----------
    goal : str
        Concise description of the reusable Workflow to build.
    mode : {"ask", "start"}, optional
        Whether to ask for confirmation or enter Build immediately.
    reason : str, optional
        Short explanation shown when ``mode`` is ``ask``.

    Returns
    -------
    RequestBuild
        Structured Build entry request handled by the Agent.

    Raises
    ------
    RequestHumanRejection
        If ``goal`` is empty.
    """
    goal = goal.strip()
    if not goal:
        raise RequestHumanRejection("request_build rejected: `goal` must be non-empty.")
    return RequestBuild(goal=goal, mode=mode, reason=reason.strip() or None)


class RequestPresentation:
    """A semantic request to enter the dedicated presentation pipeline."""

    def __init__(self, goal: str):
        self.goal = goal


async def request_presentation(goal: str) -> RequestPresentation:
    """Enter the dedicated presentation pipeline for an explicit deck request.

    Use this from Main when the user asks to create or substantially rebuild a
    PowerPoint presentation. Ordinary one-off questions about slides remain in
    Main. The pipeline begins by clarifying the communication goal before it
    plans, composes, and reviews the deck.

    Parameters
    ----------
    goal : str
        Concise description of the presentation to create or rebuild.

    Returns
    -------
    RequestPresentation
        Structured presentation entry request handled by the Agent.

    Raises
    ------
    RequestHumanRejection
        If ``goal`` is empty.
    """
    goal = goal.strip()
    if not goal:
        raise RequestHumanRejection("request_presentation rejected: `goal` must be non-empty.")
    return RequestPresentation(goal)


class RequestRunWorkflow:
    """A semantic decision for entering one Session-owned Workflow Run."""

    MAX_REASON_LENGTH = 300

    def __init__(
        self,
        workflow_id: str,
        action: Literal["start", "resume", "restart", "ask"],
        reason: Optional[str] = None,
    ):
        self.workflow_id = workflow_id
        self.action = action
        self.reason = reason


async def request_run_workflow(
    workflow_id: str,
    action: Literal["start", "resume", "restart", "ask"] = "start",
    reason: str = "",
) -> RequestRunWorkflow:
    """Start or resolve re-entry into a Session-owned Workflow Run.

    Choose ``start`` when the Session has no active Run, ``resume`` when the
    user's intent clearly continues its pinned snapshot, ``restart`` when the
    user clearly wants the currently saved Workflow from the beginning, and
    ``ask`` only when an existing Run makes the intent ambiguous.

    Parameters
    ----------
    workflow_id : str
        Saved Workflow requested by the user.
    action : {"start", "resume", "restart", "ask"}
        Agent's semantic entry or re-entry decision.
    reason : str, optional
        Concise explanation. Required when ``action`` is ``ask``.

    Returns
    -------
    RequestRunWorkflow
        Structured Run re-entry request handled by the Agent runtime.

    Raises
    ------
    RequestHumanRejection
        If the Workflow id or required explanation is invalid.
    """
    workflow_id = workflow_id.strip()
    reason = reason.strip()
    if not workflow_id:
        raise RequestHumanRejection(
            "request_run_workflow rejected: `workflow_id` must be non-empty.",
        )
    if action == "ask" and not reason:
        raise RequestHumanRejection(
            "request_run_workflow rejected: `reason` must explain the ambiguous Run intent.",
        )
    if len(reason) > RequestRunWorkflow.MAX_REASON_LENGTH:
        raise RequestHumanRejection(
            "request_run_workflow rejected: `reason` exceeds "
            f"{RequestRunWorkflow.MAX_REASON_LENGTH} characters.",
        )
    return RequestRunWorkflow(workflow_id, action, reason or None)


class RequestHumanChoice:
    MAX_QUESTIONS = 8
    MAX_OPTIONS = 50
    MAX_PROMPT_CHARS = 20_000

    def __init__(self, questions: List[Dict[str, Any]], prompt: str):
        self.questions = questions
        self.prompt = prompt

    @staticmethod
    def coerce_questions(value: Any) -> List[Dict[str, Any]]:
        """Parse questions from a JSON string, list, or wrapper object.

        Accept a bare list, a ``{"questions": [...]}`` object, or a Python-literal
        repr; anything unparseable yields ``[]``. Shared with persisted-history
        readers so live execution and replay parse the contract identically.
        """
        if isinstance(value, list):
            return value
        if isinstance(value, dict):
            questions = value.get("questions", [])
            return questions if isinstance(questions, list) else []
        if isinstance(value, str):
            for parse in (json.loads, ast.literal_eval):
                try:
                    parsed = parse(value)
                except (ValueError, SyntaxError):
                    continue
                if isinstance(parsed, dict):
                    parsed = parsed.get("questions", [])
                if isinstance(parsed, list):
                    return parsed
        return []

    @classmethod
    def normalize_questions(cls, value: Any) -> List[Dict[str, Any]]:
        """Validate and normalize questions for renderer-safe presentation."""
        questions = cls.coerce_questions(value)
        if not questions:
            raise RequestHumanRejection(
                "request_human_choice rejected: `questions` must be JSON containing "
                "a non-empty questions list."
            )
        if len(questions) > cls.MAX_QUESTIONS:
            raise RequestHumanRejection(
                f"request_human_choice rejected: at most {cls.MAX_QUESTIONS} questions are allowed."
            )

        normalized: List[Dict[str, Any]] = []
        for question_index, raw_question in enumerate(questions, start=1):
            if not isinstance(raw_question, dict):
                raise RequestHumanRejection(
                    f"request_human_choice rejected: question {question_index} must be an object."
                )
            question = cls._required_text(
                raw_question.get("question"), f"question {question_index}.question", 240
            )
            header = cls._optional_text(
                raw_question.get("header"), f"question {question_index}.header", 40
            )
            if "layout" in raw_question:
                raise RequestHumanRejection(
                    f"request_human_choice rejected: question {question_index}.layout is not accepted; "
                    "presentation is derived from `multiSelect`."
                )
            multi_select = cls._optional_bool(
                raw_question.get("multiSelect"), f"question {question_index}.multiSelect", False
            )
            layout = "review-list" if multi_select else "compact"

            raw_options = raw_question.get("options")
            if not isinstance(raw_options, list) or len(raw_options) < 2:
                raise RequestHumanRejection(
                    f"request_human_choice rejected: question {question_index} needs at least 2 options."
                )
            if len(raw_options) > cls.MAX_OPTIONS:
                raise RequestHumanRejection(
                    f"request_human_choice rejected: question {question_index} may contain at most "
                    f"{cls.MAX_OPTIONS} options."
                )
            options = [
                cls._normalize_option(option, question_index, option_index)
                for option_index, option in enumerate(raw_options, start=1)
            ]
            labels = [option["label"] for option in options]
            if len(set(labels)) != len(labels):
                raise RequestHumanRejection(
                    f"request_human_choice rejected: question {question_index} has duplicate option labels."
                )

            allow_other = cls._optional_bool(
                raw_question.get("allowOther"),
                f"question {question_index}.allowOther",
                layout != "review-list",
            )
            allow_empty = cls._optional_bool(
                raw_question.get("allowEmpty"), f"question {question_index}.allowEmpty", False
            )
            selection_limit = len(options) if multi_select else 1
            default_minimum = 0 if allow_empty else 1
            minimum = cls._optional_int(
                raw_question.get("minSelections"),
                f"question {question_index}.minSelections",
                default_minimum,
            )
            maximum = cls._optional_int(
                raw_question.get("maxSelections"),
                f"question {question_index}.maxSelections",
                selection_limit,
            )
            if minimum < 0 or maximum < 1 or minimum > maximum or maximum > selection_limit:
                raise RequestHumanRejection(
                    f"request_human_choice rejected: question {question_index} has invalid selection limits."
                )
            if not allow_empty and minimum == 0:
                raise RequestHumanRejection(
                    f"request_human_choice rejected: question {question_index}.minSelections must be at "
                    "least 1 unless allowEmpty is true."
                )
            if allow_empty and minimum != 0:
                raise RequestHumanRejection(
                    f"request_human_choice rejected: question {question_index}.minSelections must be 0 "
                    "when allowEmpty is true."
                )
            empty_label = cls._optional_text(
                raw_question.get("emptyLabel"), f"question {question_index}.emptyLabel", 40
            ) or backend_i18n.text("interaction.empty_selection")

            item: Dict[str, Any] = {
                "question": question,
                "options": options,
                "layout": layout,
                "multiSelect": multi_select,
                "allowOther": allow_other,
                "allowEmpty": allow_empty,
                "minSelections": minimum,
                "maxSelections": maximum,
            }
            if header:
                item["header"] = header
            if allow_empty:
                item["emptyLabel"] = empty_label
            normalized.append(item)
        return normalized

    @classmethod
    def _normalize_option(cls, raw_option: Any, question_index: int, option_index: int) -> Dict[str, str]:
        if not isinstance(raw_option, dict):
            raise RequestHumanRejection(
                f"request_human_choice rejected: question {question_index} option {option_index} "
                "must be an object."
            )
        prefix = f"question {question_index} option {option_index}"
        option = {"label": cls._required_text(raw_option.get("label"), f"{prefix}.label", 240)}
        description = cls._optional_text(raw_option.get("description"), f"{prefix}.description", 500)
        preview = cls._optional_text(raw_option.get("preview"), f"{prefix}.preview", 8_000)
        if description:
            option["description"] = description
        if preview:
            option["preview"] = preview
        return option

    @staticmethod
    def _required_text(value: Any, field: str, limit: int) -> str:
        if not isinstance(value, str) or not value.strip():
            raise RequestHumanRejection(f"request_human_choice rejected: {field} must be non-empty text.")
        text = value.strip()
        if len(text) > limit:
            raise RequestHumanRejection(
                f"request_human_choice rejected: {field} exceeds {limit} characters."
            )
        return text

    @classmethod
    def _optional_text(cls, value: Any, field: str, limit: int) -> Optional[str]:
        if value is None or value == "":
            return None
        return cls._required_text(value, field, limit)

    @staticmethod
    def _optional_bool(value: Any, field: str, default: bool) -> bool:
        if value is None:
            return default
        if not isinstance(value, bool):
            raise RequestHumanRejection(f"request_human_choice rejected: {field} must be a boolean.")
        return value

    @staticmethod
    def _optional_int(value: Any, field: str, default: int) -> int:
        if value is None:
            return default
        if not isinstance(value, int) or isinstance(value, bool):
            raise RequestHumanRejection(f"request_human_choice rejected: {field} must be an integer.")
        return value


async def request_human_choice(questions: str, prompt: str) -> Any:
    """Ask the user to decide; this ENDS your turn — stop after calling it.

    This is the ONLY way to put a decision to the user. Calling it surfaces the
    question and finishes the turn; the user's reply arrives as the next message,
    so do NOT keep working or answer your own question after this call.

    Batch every open decision into this ONE call as multiple short questions.
    Every call must provide a non-empty ``prompt`` using the same standard:
    explain what you are doing now, the concrete facts or result that led to the
    interaction, why you cannot continue without the user's input at this point,
    and what the user's decision will determine. The user must be able to
    understand why the interaction is happening from ``prompt`` alone. Render it
    as sanitized Markdown; it may contain links, images, tables, code, math, or
    Mermaid diagrams. Each question needs options (2+).
    ``multiSelect`` is the question's only selection-mode control. Omit it or
    set it to false for a compact single-choice question; set it to true for a
    checkbox review list where several options may be chosen. Do not pass a
    separate layout. Compact questions add a free-form "other" field by default.
    In a review list, put only a short title in each option's ``label``, one
    metadata line in ``description``, and candidate-specific Markdown in
    ``preview``.

    Args:
        questions: The questions as a JSON string:
            {"questions": [{"question": "...", "header": "short label",
            "options": [{"label": "...", "description": "optional",
            "preview": "optional markdown details"}, ...],
            "multiSelect": false, "allowOther": true, "allowEmpty": false,
            "minSelections": 1, "maxSelections": 1}, ...]}
        prompt: Required Markdown context shown once above the questions. It must
            explain the current work and why this interaction is necessary now.

        ``question`` is limited to 240 characters and ``prompt`` to 20,000.
        Keep questions and option labels concise. ``multiSelect`` alone selects
        both behavior and presentation for each question. Multi-select questions
        default ``allowOther`` to false and support ``allowEmpty`` with an
        optional ``emptyLabel``.

    Returns:
        A ``RequestHumanChoice`` carrying the Markdown prompt and parsed questions.

    Raises:
        RequestHumanRejection: the questions or prompt violate the card contract.
    """
    normalized_questions = RequestHumanChoice.normalize_questions(questions)
    normalized_prompt = RequestHumanChoice._required_text(
        prompt, "prompt", RequestHumanChoice.MAX_PROMPT_CHARS
    )
    return RequestHumanChoice(normalized_questions, normalized_prompt)


class RequestHumanTaskConfirm:
    """A request for the user to review the current ``task.md`` contract."""

    def __init__(self, request_id: Optional[str] = None):
        self.request_id = request_id or f"task_confirm_{uuid4().hex}"


async def request_human_task_confirm() -> RequestHumanTaskConfirm:
    """Ask the user to review and confirm ``task.md``; this ends the turn.

    Returns
    -------
    RequestHumanTaskConfirm
        A request identity used to correlate the user's structured response.
    """
    return RequestHumanTaskConfirm()


class RequestHumanWorkflowConfirm:
    def __init__(
        self,
        default_name: str,
        summary: Optional[str] = None,
        request_id: Optional[str] = None,
    ):
        self.request_id = request_id or f"workflow_confirm_{uuid4().hex}"
        self.default_name = default_name
        self.summary = summary

    @staticmethod
    def coerce_payload(prompt: Any) -> Dict[str, Any]:
        if isinstance(prompt, dict):
            return prompt
        if isinstance(prompt, str):
            for parse in (json.loads, ast.literal_eval):
                try:
                    value = parse(prompt)
                except (json.JSONDecodeError, ValueError, SyntaxError):
                    continue
                if isinstance(value, dict):
                    return value
        return {}


async def request_human_workflow_confirm(prompt: str) -> RequestHumanWorkflowConfirm:
    """Ask the user to name and confirm the verified workflow — this ENDS your turn.

    Use this only at the end of the build verify stage after Build Verify has
    completed. The UI surfaces a workflow naming card. The user's confirmation
    or cancellation arrives through the system resume path, so do NOT keep
    working after this call.

    Args:
        prompt: JSON payload:
            {"default_name": "workflow name", "summary": "optional short summary"}

    Returns:
        A ``RequestHumanWorkflowConfirm`` carrying the card payload.

    Raises:
        RequestHumanRejection: the payload is missing ``default_name``.
    """
    payload = RequestHumanWorkflowConfirm.coerce_payload(prompt)
    default_name = str(payload.get("default_name") or "").strip()
    summary = str(payload.get("summary") or "").strip() or None
    if not default_name:
        raise RequestHumanRejection(
            "request_human_workflow_confirm rejected: prompt must be JSON with "
            "a non-empty `default_name`, optionally `summary`."
        )
    return RequestHumanWorkflowConfirm(default_name=default_name, summary=summary)


request_build_tool: FunctionToolSpec = FunctionToolSpec.from_raw(request_build)
request_presentation_tool: FunctionToolSpec = FunctionToolSpec.from_raw(request_presentation)
request_run_workflow_tool: FunctionToolSpec = FunctionToolSpec.from_raw(request_run_workflow)
request_human_choice_tool: FunctionToolSpec = FunctionToolSpec.from_raw(request_human_choice)
request_human_task_confirm_tool: FunctionToolSpec = FunctionToolSpec.from_raw(request_human_task_confirm)
request_human_workflow_confirm_tool: FunctionToolSpec = FunctionToolSpec.from_raw(request_human_workflow_confirm)
