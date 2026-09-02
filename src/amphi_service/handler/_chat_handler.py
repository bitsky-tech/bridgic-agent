import asyncio
from typing import Any, Dict, Optional

from ...amphi_agent import (
    InvocationBusyError,
    InvocationStaleAnswerError,
    InvocationStateError,
)
from ..protocol import (
    WsBuildConfirmMessage,
    WsChatMessage,
    WsChoiceAnswerMessage,
    WsHelloMessage,
    WsMessageError,
    WsPermissionAnswer,
    WsSetLocaleMessage,
    WsSubscribeMessage,
    WsTaskConfirmMessage,
    WsUnsubscribeMessage,
    WsWorkflowConfirmMessage,
    parse_client_message,
)
from ...amphi_store import (
    SessionRecord,
    SessionRepository,
)
from ._base import WsHandler
from ..i18n import backend_i18n, locale_from_accept_language, use_locale

_SYSTEM_TOPIC = "system"


################################################################################################################
# ChatHandler
################################################################################################################


# TODO: split WsSubscribeMessage / WsUnsubscribeMessage into their own handler
#       once the WS protocol outgrows chat.

class ChatHandler(WsHandler):
    """Bind: ``/ws`` — the multiplexed chat WebSocket (subscribe + chat)."""

    ############################################################################
    # Core Methods
    ############################################################################
    async def _dispatch(self, message: Dict[str, Any]) -> None:
        # Validate the inbound frame.
        try:
            msg = parse_client_message(message)
        except WsMessageError as exc:
            session_id = message.get("session_id")
            await self.websocket.send_json({
                "type": "cmd_error",
                "for": exc.for_type,
                **({"session_id": session_id} if isinstance(session_id, str) else {}),
                "message": str(exc),
            })
            return

        # Already past handshake; a second hello is a protocol bug.
        if isinstance(msg, WsHelloMessage):
            await self.websocket.send_json({
                "type": "cmd_error",
                "for": "hello",
                "message": "Already authenticated.",
            })
            return

        if isinstance(msg, WsSetLocaleMessage):
            await self._on_set_locale(msg)
            return

        if isinstance(msg, WsSubscribeMessage):
            await self._on_subscribe(msg)
            return

        if isinstance(msg, WsUnsubscribeMessage):
            await self._on_unsubscribe(msg)
            return

        if isinstance(msg, (
            WsChatMessage,
            WsBuildConfirmMessage,
            WsTaskConfirmMessage,
            WsWorkflowConfirmMessage,
            WsPermissionAnswer,
            WsChoiceAnswerMessage,
        )):
            await self._on_message(msg)
            return

    async def _on_set_locale(self, msg: WsSetLocaleMessage) -> None:
        """Retarget display text for the turns that follow; the current one is untouched
        (``_chat`` captured its locale when it started)."""
        self.locale = locale_from_accept_language(msg.locale)
        await self.websocket.send_json({
            "type": "ack",
            "for": "set_locale",
            "locale": self.locale,
        })

    async def _on_subscribe(self, msg: WsSubscribeMessage) -> None:
        for topic in msg.topics:
            # The daemon-wide topic relays the process bus; sessions relay theirs.
            if topic == _SYSTEM_TOPIC:
                self._ensure_system_relay(topic)
                continue

            session_id = self._topic_to_session_id(topic)
            if session_id is None:
                continue
            self._ensure_session_relay(topic, session_id)

        await self.websocket.send_json({
            "type": "ack",
            "for": "subscribe",
            "topics": list(msg.topics),
        })

    async def _on_unsubscribe(self, msg: WsUnsubscribeMessage) -> None:
        for topic in msg.topics:
            task = self.relay_tasks.pop(topic, None)
            if task is not None and not task.done():
                task.cancel()

        await self.websocket.send_json({
            "type": "ack",
            "for": "unsubscribe",
            "topics": list(msg.topics),
        })

    async def _on_message(
        self,
        msg: WsChatMessage | WsBuildConfirmMessage | WsTaskConfirmMessage | WsWorkflowConfirmMessage | WsPermissionAnswer | WsChoiceAnswerMessage,
    ) -> None:
        # Check user
        user = await self.require_user()

        # Check API key
        if not user.api_key and user.protocol != "openai-codex":
            # Codex (protocol='openai-codex') has no api_key — its creds live in ~/.codex. Need specifically check this.
            await self.websocket.send_json({
                "type": "cmd_error",
                "for": msg.type,
                "session_id": msg.session_id,
                "message": (
                    f"No AI provider key configured for user {user.id!r}. "
                    "POST /me/credentials at runtime."
                ),
            })
            return

        # Check session
        record: Optional[SessionRecord] = await SessionRepository().load(msg.session_id, user.id)
        if record is None:
            await self.websocket.send_json({
                "type": "cmd_error",
                "for": msg.type,
                "session_id": msg.session_id,
                "message": (
                    f"Session {msg.session_id!r} is not registered "
                    "(create via POST /sessions first)."
                ),
            })
            return

        # Model-switch notice
        active_model = user.current_model
        previous_model = record.last_used_model
        if previous_model and previous_model != active_model:
            await self.websocket.send_json({
                "type": "model_switch_warning",
                "session_id": msg.session_id,
                "previous_model": previous_model,
                "current_model": active_model,
            })

        # TODO: Maybe push to a per-session message queue and consume in order?

        # Run agent
        try:
            with use_locale(self.locale):
                await self.invocations.arun(record.id, msg)
        except InvocationStaleAnswerError:
            # Stale/duplicate structured answers are idempotent control traffic.
            await self.websocket.send_json({
                "type": "ack",
                "for": msg.type,
                "session_id": msg.session_id,
            })
            return
        except InvocationBusyError:
            await self.websocket.send_json({
                "type": "cmd_error",
                "for": msg.type,
                "session_id": msg.session_id,
                "message": backend_i18n.text("chat.reply_in_progress", locale=self.locale),
            })
            return
        except InvocationStateError as exc:
            await self.websocket.send_json({
                "type": "cmd_error",
                "for": msg.type,
                "session_id": msg.session_id,
                "message": str(exc),
            })
            return
        except Exception as exc:
            await self.websocket.send_json({
                "type": "cmd_error",
                "for": msg.type,
                "session_id": msg.session_id,
                "message": str(exc),
            })
            return
        else:
            await self.websocket.send_json({
                "type": "ack",
                "for": msg.type,
                "session_id": msg.session_id,
            })

    ############################################################################
    # Helper methods
    ############################################################################
    def _ensure_session_relay(self, topic: str, session_id: str) -> None:
        """Start this connection's persistent relay loop for a session topic.

        Idempotent: one loop per subscribed topic. It remains subscribed across
        Agent attempts, so a re-subscribe is a no-op. The relay itself lives in
        the transport base; this method only decides when to spawn it.
        """
        existing = self.relay_tasks.get(topic)
        if existing is not None and not existing.done():
            return
        self.relay_tasks[topic] = asyncio.create_task(self._relay_session(session_id))

    def _ensure_system_relay(self, topic: str) -> None:
        """Start the process-bus relay for the ``system`` topic if not running."""
        existing = self.relay_tasks.get(topic)
        if existing is not None and not existing.done():
            return
        self.relay_tasks[topic] = asyncio.create_task(self._relay_system())

    @staticmethod
    def _topic_to_session_id(topic: str) -> Optional[str]:
        """Return the session id encoded in a ``session:<id>`` topic; else ``None``."""
        if topic.startswith("session:") and len(topic) > len("session:"):
            return topic[len("session:"):]
        return None

__all__ = ["ChatHandler"]
