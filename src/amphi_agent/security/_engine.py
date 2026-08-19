"""The permission engine facade — chains the four layers to turn a batch of tool calls
into a batch of :class:`CallVerdict`.

``permission_check`` depends on this single entry point:

    engine = PermissionEngine(workspace_root, mount_roots, mode, classifier)
    verdicts = await engine.evaluate(calls, user_messages)

Flow: ①/② ``classify`` produces the judgement -> ③/④ ``decide`` produces the action ->
the calls whose action is ``CLASSIFY`` go to the safety classifier (with no classifier
available this fails closed to ASK) -> assemble ``CallVerdict`` (carrying verdict +
capability/boundary/reason).
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import List, Optional

from src.amphi_service.i18n import backend_i18n

from .._state import CallVerdict
from ._audit import write_verdict_record
from ._classifier import ClassifyItem, SafetyClassifier
from ._classify import classify, label_text
from ._mode_policy import decide
from ._routing import (
    append_routing,
    approved_signatures,
    call_signature,
    render_summary,
    routing_category,
)
from ._types import Action, ExecutionMode, Judgement

logger = logging.getLogger(__name__)

_ACTION_TO_VERDICT = {
    Action.ALLOW: "allow",
    Action.ASK: "ask",
    Action.DENY: "deny",
}


class PermissionEngine:
    """The single entry point (facade) for the system permission policy. Bound to one
    session's workspace / mount roots / execution mode, plus an optional safety classifier
    (used by auto mode)."""

    def __init__(
        self,
        workspace_root: str,
        mount_roots: Optional[List[str]] = None,
        mode: object = ExecutionMode.AUTO,
        classifier: Optional[SafetyClassifier] = None,
        audit_dir: Optional[Path] = None,
        writable_roots: Optional[List[str]] = None,
        gated_roots: Optional[List[str]] = None,
    ) -> None:
        self._ws = workspace_root or ""
        self._mounts = list(mount_roots or [])
        self._writable = list(writable_roots or [])
        # Gated roots: subtrees beneath them that are **not writable** do not get the temp/app_home
        # prefix allowance and are forced back to OOB for approval. Used for the workflow-run
        # space — only result/work are writable, while the framework's execution records under
        # background stay protected.
        self._gated = list(gated_roots or [])
        self._mode = mode if isinstance(mode, ExecutionMode) else ExecutionMode(str(mode))
        self._classifier = classifier
        self._audit_dir = audit_dir

    async def evaluate(
        self,
        calls: List[object],
        user_messages: Optional[List[str]] = None,
        agent_reasoning: str = "",
        session_approvals: Optional[List[str]] = None,
        named_paths: Optional[List[str]] = None,
    ) -> List[CallVerdict]:
        """Rule on a batch of tool calls and return a list of ``CallVerdict`` aligned with
        it.

        ``user_messages`` is the trusted basis for authorisation (multi-round user
        requests); ``session_approvals`` are the allow/deny decisions the user already made
        this session (trusted, equivalent to naming); ``named_paths`` are local paths the
        user named during the session (trusted, and they do not slide out with the message
        window); ``agent_reasoning`` is the agent's reasoning behind this batch, fed to the
        classifier as **untrusted context pending cross-verification** (all four matter
        only in the auto grey area)."""
        judgements = [classify(c, self._ws, self._mounts, self._writable, self._gated) for c in calls]
        actions = [decide(j, self._mode) for j in judgements]
        reasons = [label_text(j.label) for j in judgements]
        rules = [""] * len(calls)
        self._apply_session_grants(calls, actions)

        classify_idx = [i for i, a in enumerate(actions) if a is Action.CLASSIFY]
        classified = set(classify_idx)
        elapsed_ms: Optional[float] = None
        if classify_idx:
            started = time.monotonic()
            await self._resolve_classify(
                classify_idx, calls, judgements, actions, reasons, rules,
                user_messages, agent_reasoning, session_approvals, named_paths,
            )
            elapsed_ms = (time.monotonic() - started) * 1000.0

        verdicts = [
            self._to_verdict(calls[i], judgements[i], actions[i], reasons[i], rules[i])
            for i in range(len(calls))
        ]
        self._log_decisions(calls, judgements, verdicts)
        # Side-channel record: every call that passes through the permission module is logged in
        # full (rules → mode → final verdict); a failure here never affects the verdict.
        self._record_verdicts(calls, judgements, verdicts, classified)
        # Side-channel record: the session-level routing summary (sent to the model / no approval
        # needed / settled by the rule layer + classification latency).
        self._record_routing(calls, judgements, verdicts, classified, elapsed_ms)
        return verdicts

    def _apply_session_grants(self, calls: List[object], actions: List[Action]) -> None:
        """A call the user already explicitly allowed **in this session** is allowed again
        outright, without another review.

        Rewrites ``CLASSIFY`` to ``ALLOW`` in place. Three boundaries, all deliberate:

        * **Applies to ``CLASSIFY`` only** — a rule-layer-final ``ASK`` (deleting a
          sensitive file) or ``DENY`` (a system red line) is a circuit breaker cutting
          across all three modes and must not be hollowed out by session memory; the
          ``ASK`` of ``request`` mode is left alone too, since asking about everything is
          exactly what that mode promises.
        * **Exact signatures only** — the tool name plus every argument, byte for byte
          (see ``call_signature``). Approximate calls go to the classifier with context
          rather than having the user's authorisation extended for them here.
        * **allow only** — something previously denied is not auto-denied, so the task is
          not deadlocked when the user changes their mind.

        Silently skipped when there is no audit directory (no workspace bound): there are
        no decisions to read in that case either.
        """
        grants = approved_signatures(self._audit_dir)
        if not grants:
            return
        for i, action in enumerate(actions):
            if action is not Action.CLASSIFY:
                continue
            if call_signature(getattr(calls[i], "tool", ""), _args(calls[i])) in grants:
                actions[i] = Action.ALLOW
                logger.info(
                    "[permission] same call already approved this session, skipping review tool=%s",
                    getattr(calls[i], "tool", ""),
                )

    async def _resolve_classify(
        self,
        idxs: List[int],
        calls: List[object],
        judgements: List[Judgement],
        actions: List[Action],
        reasons: List[str],
        rules: List[str],
        user_messages: Optional[List[str]],
        agent_reasoning: str = "",
        session_approvals: Optional[List[str]] = None,
        named_paths: Optional[List[str]] = None,
    ) -> None:
        """Send the calls marked CLASSIFY to the classifier as a batch and reduce
        actions/reasons to allow/ask in place."""
        if self._classifier is None:
            logger.warning("[permission] no safety classifier, %d CLASSIFY calls fail-closed to ASK", len(idxs))
            for i in idxs:
                actions[i] = Action.ASK  # no classifier → fail closed
            return
        items = [
            ClassifyItem(
                tool=getattr(calls[i], "tool", ""),
                arguments=_args(calls[i]),
                capability=judgements[i].capability.value,
                boundary=judgements[i].boundary.value,
                # The classifier prompt is English throughout, so the label is pinned to
                # English here even when the user's locale is Chinese — a Chinese enum value
                # inside an English prompt only degrades instruction-following.
                label=label_text(judgements[i].label, locale="en"),
                cwd=judgements[i].cwd,
                target_exists=_target_exists(_args(calls[i]), judgements[i].cwd),
            )
            for i in idxs
        ]
        verdicts = await self._classifier.judge(
            items, list(user_messages or []), [self._ws, *self._writable, *self._mounts],
            agent_reasoning, list(session_approvals or []), list(named_paths or []),
        )
        if len(verdicts) < len(idxs):
            logger.warning(
                "[permission] classifier returned too few verdicts (got %d/need %d), missing ones fail closed to ASK", len(verdicts), len(idxs)
            )
        for k, i in enumerate(idxs):
            verdict = verdicts[k] if k < len(verdicts) else None
            outcome = verdict.verdict if verdict is not None else "ask"  # missing entry → conservatively ask
            if outcome == "allow":
                actions[i] = Action.ALLOW
                continue
            actions[i] = Action.DENY if outcome == "deny" else Action.ASK
            rules[i] = (getattr(verdict, "rule", "") or "").strip()
            text = (getattr(verdict, "reason", "") or "").strip()
            reasons[i] = text or reasons[i] or backend_i18n.text(
                "security.denied_by_policy" if outcome == "deny" else "security.confirmation_required"
            )

    def _log_decisions(
        self,
        calls: List[object],
        judgements: List[Judgement],
        verdicts: List[CallVerdict],
    ) -> None:
        """Log one line for every verdict that is not an allow.

        The decision point used to have no logging at all: even the most serious final
        refusal, ``hard_deny``, left no trace, and the only record was the markdown from
        ``_audit`` / ``_routing`` — which becomes an **entirely silent no-op** when
        ``audit_dir is None`` (as it is when the workspace is missing, a path along which
        an empty ``ws`` also makes every path judge as out of bounds). The result was
        users buried in dialogs while the backend logged nothing, leaving production
        completely undiagnosable.

        The line carries the tool and the verdict, never the call's arguments. Since
        the daemon gained a root file handler these records land in ``server.log`` —
        the file the GUI's "Open Logs" hands to the user and that users attach to bug
        reports — and a blocked ``curl -H "Authorization: Bearer ..."`` would be
        persisted verbatim. The full arguments stay on the audit side channel, which
        is written to the workspace rather than to a shareable log.
        """
        hard = [getattr(calls[i], "tool", "") for i, j in enumerate(judgements) if j.hard_deny]
        if hard:
            logger.warning("[permission] hard_deny matched mode=%s tools=%s", self._mode.value, hard)
        blocked = [
            (getattr(calls[i], "tool", ""), verdicts[i].verdict)
            for i in range(len(calls))
            if verdicts[i].verdict != "allow"
        ]
        if blocked:
            logger.info(
                "[permission] mode=%s batch=%d non_allow=%d %s",
                self._mode.value, len(calls), len(blocked), blocked,
            )

    def _record_verdicts(
        self,
        calls: List[object],
        judgements: List[Judgement],
        verdicts: List[CallVerdict],
        classified: set,
    ) -> None:
        """Persist a whole batch of verdicts (decision flags → final verdict + full
        arguments) on the side channel; a failure only logs and never affects the verdict."""
        write_verdict_record(
            self._audit_dir,
            self._mode.value,
            [
                {
                    "tool": getattr(calls[i], "tool", ""),
                    "arguments": _args(calls[i]),
                    "capability": judgements[i].capability.value,
                    "boundary": judgements[i].boundary.value,
                    "sensitive": judgements[i].sensitive,
                    "hard_deny": judgements[i].hard_deny,
                    "uncertain": judgements[i].uncertain_destruction,
                    "classified": i in classified,
                    "verdict": verdicts[i].verdict,
                    "reason": verdicts[i].reason or "",
                }
                for i in range(len(calls))
            ],
        )

    def _record_routing(
        self,
        calls: List[object],
        judgements: List[Judgement],
        verdicts: List[CallVerdict],
        classified: set,
        elapsed_ms: Optional[float],
    ) -> None:
        """Session-level routing summary: bucket each entry into the three categories,
        append to the JSONL and rewrite the summary; a failure never affects the verdict."""
        records = [
            {
                "tool": getattr(calls[i], "tool", ""),
                "summary": _summary(calls[i]),
                "capability": judgements[i].capability.value,
                "boundary": judgements[i].boundary.value,
                "category": routing_category(i in classified, verdicts[i].verdict),
                "verdict": verdicts[i].verdict,
                "batch_elapsed_ms": elapsed_ms if i in classified else None,
            }
            for i in range(len(calls))
        ]
        append_routing(self._audit_dir, records)
        render_summary(self._audit_dir)

    @staticmethod
    def _to_verdict(call: object, j: Judgement, action: Action, reason: str, rule: str) -> CallVerdict:
        verdict = _ACTION_TO_VERDICT[action]
        return CallVerdict(
            tool=getattr(call, "tool", ""),
            arguments=_args(call),
            verdict=verdict,
            reason=None if verdict == "allow" else (reason or None),
            rule=rule,
            label_id=j.label,
            capability=j.capability.value,
            boundary=j.boundary.value,
            # Decision flags are passed through to the frontend: the approval card derives the
            # risk level and "high-risk stripping" from them instead of guessing from Chinese
            # substrings.
            sensitive=j.sensitive,
            deletion=j.deletion,
            regenerable=j.regenerable,
            uncertain_destruction=j.uncertain_destruction,
            touches_risk_surface=j.touches_risk_surface,
        )


def _args(call: object) -> dict:
    return {a.name: a.value for a in (getattr(call, "tool_arguments", None) or [])}


def _target_exists(args: dict, cwd: Optional[str]) -> Optional[bool]:
    """Whether the target file of a write call **already exists right now**; for non-file
    calls or when the path cannot be resolved → ``None`` (unknown).

    The soft block on 'irreversible local destruction' targets "destroying existing
    content"; creating a new file is not in scope. The classifier previously had no access
    to this fact and could only guess — in practice it judged "writing a new file into a
    freshly mkdir'ed directory" as "might overwrite an existing file" and raised a dialog.
    This is an objective fact one ``exists()`` call settles, and the model should not have
    to guess it."""
    raw = args.get("file_path") or args.get("path") or ""
    if not isinstance(raw, str) or not raw.strip():
        return None
    path = raw.strip()
    if not os.path.isabs(path):
        if not cwd:
            return None
        path = os.path.join(cwd, path)
    try:
        return os.path.lexists(path)
    except OSError:
        return None


def _summary(call: object) -> str:
    """A short summary of one call (command or path, truncated). For display in the
    routing summary only."""
    args = _args(call)
    raw = args.get("command") or args.get("file_path") or args.get("path") or ""
    return str(raw).strip().replace("\n", " ")[:120]


def model_facing_reason(verdict: CallVerdict) -> str:
    """Fold the matched policy category back into the reason for the **model**.

    The rule name comes from ``policy.json`` / the built-in default policy, which is data
    the user can override and which has no localized form — showing it on the approval card
    put an English ``[Irreversible local destruction]`` in front of a Chinese reason. It
    still belongs in the failed step's error (it tells the model which category it hit, so
    it does not retry the same call) and in the audit record.
    """
    reason = verdict.reason or ""
    if verdict.rule and reason:
        return f"[{verdict.rule}] {reason}"
    return verdict.rule or reason
