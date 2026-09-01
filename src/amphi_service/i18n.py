"""Backend-owned, request-scoped display-text localization.

The catalog in this module intentionally belongs only to the service.  HTTP
clients provide their language preference through the standard
``Accept-Language`` header; they never need to know these internal message
identifiers.  Existing API payload fields keep their established names, and
handlers only resolve display text at the edge.
"""

from __future__ import annotations

import logging
import re
from contextlib import contextmanager
from contextvars import ContextVar, Token
from itertools import islice
from typing import Iterator, Literal, Mapping

_logger = logging.getLogger(__name__)


Locale = Literal["zh", "en"]
# Matches the GUI's pre-boot default (`fallbackLng` in the renderer's i18n init): with no
# stated preference at all, both halves of the product now land on English. This was "zh"
# historically, which left a header-less client reading Chinese under an English UI.
DEFAULT_LOCALE: Locale = "en"


def locale_from_accept_language(value: str | None) -> Locale:
    """Choose a supported locale from an HTTP ``Accept-Language`` value.

    Unsupported or absent preferences fall back to the product default.
    Quality values determine preference order.  RFC 9110
    allows optional whitespace around ``;``, so the language tag is trimmed
    on its own.  A malformed or out-of-range quality (``q=bad``, ``inf``,
    ``1e5``) must not inherit the default 1.0 and outrank a well-formed
    entry: those entries rank below every valid one, keeping their source
    order.  ``q=0`` means "not acceptable" (RFC 9110), so those entries are
    dropped rather than ranked last — otherwise ``fr, en;q=0`` would select
    the one language the client explicitly refused.
    """
    if not value:
        return DEFAULT_LOCALE

    # (malformed-tier, -quality, source-index): valid entries sort by quality
    # then order; malformed ones sort after all of them, in order.
    preferences: list[tuple[int, float, int, str]] = []
    for index, part in enumerate(value.split(",")):
        language, *parameters = part.strip().split(";")
        language = language.strip()
        if not language:
            continue
        quality = 1.0
        malformed = False
        for parameter in parameters:
            name, separator, raw_value = parameter.strip().partition("=")
            if name.strip().lower() != "q" or not separator:
                continue
            try:
                quality = float(raw_value)
            except ValueError:
                malformed = True
            else:
                # NaN fails both comparisons and lands here too.
                if not 0.0 <= quality <= 1.0:
                    malformed = True
        if malformed:
            _logger.debug("Malformed Accept-Language quality in %r; ranked last", part.strip())
            preferences.append((1, -1.0, index, language.lower()))
        elif quality > 0:
            preferences.append((0, -quality, index, language.lower()))

    for _tier, _quality, _index, language in sorted(preferences):
        primary = language.split("-", 1)[0]
        if primary in {"zh", "en"}:
            return primary  # type: ignore[return-value]
    return DEFAULT_LOCALE


_FENCED_CODE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE = re.compile(r"`[^`]*`")
_PATH_LIKE = re.compile(r"\S*[/\\]\S*")
_LATIN_WORD = re.compile(r"[A-Za-z]+")
# The backend's single "is this text Chinese" predicate: BMP unified ideographs
# plus Ext-A and the compatibility block. Shared with the web-search tool's
# query-language inference so the two detectors can never drift apart.
CJK_CHAR_RE = re.compile(r"[㐀-䶿一-鿿豈-﫿]")
# An English *sentence* always has at least two words; a single Latin token is just as
# likely to be "ok", a command name, or a product name typed by a Chinese speaker.
_MIN_LATIN_WORDS = 2


def detect_locale(*texts: str | None) -> Locale | None:
    """Infer the language the user is writing in, newest message first.

    This is what the product's display text follows: everything the model writes already
    matches the user's input language (``_prompt.py``'s CRITICAL language rule), so the
    backend's own strings — security labels, conflict cards, tool returns — must key off
    the same signal or one approval card ends up mixing both languages.

    The two scripts are judged asymmetrically, on purpose. A single CJK character is
    unambiguous evidence that the author writes Chinese. Latin letters are not: they show up
    in commands, identifiers, product names and loanwords, so English needs a whole phrase
    (``_MIN_LATIN_WORDS``) before it counts. Without that threshold a Chinese speaker typing
    ``ok`` to approve a step flipped their entire session's display text to English.

    Code fences and inline code are dropped first — they are quoted data, not the author's
    prose, and a pasted log would otherwise outvote the sentence around it. Paths are
    stripped only for the Latin word count, AFTER the CJK check: Chinese glues to a path
    with no whitespace, so stripping paths first would delete the whole sentence (its only
    CJK evidence with it) and could even flip a Chinese message to English on the leftover
    Latin words.

    ``texts`` is scanned from the last entry backwards so the newest message wins and a
    mid-session language switch takes effect immediately; an entry with no verdict (a bare
    path, a one-word acknowledgement, a resume with no text at all) falls through to what
    the user said before. Returns ``None`` when nothing carries a signal, leaving the choice
    of fallback — the client's stated language, or the product default — to the caller.
    """
    for text in reversed(texts):
        if not text:
            continue
        prose = _INLINE_CODE.sub(" ", _FENCED_CODE.sub(" ", text))
        if CJK_CHAR_RE.search(prose):
            return "zh"
        # Count only up to the quorum: a pasted multi-hundred-KB document sits in the
        # message window for turns and would otherwise materialize every word each scan.
        words = _LATIN_WORD.finditer(_PATH_LIKE.sub(" ", prose))
        if sum(1 for _ in islice(words, _MIN_LATIN_WORDS)) >= _MIN_LATIN_WORDS:
            return "en"
    return None


_locale: ContextVar[Locale] = ContextVar("amphi_service_locale", default=DEFAULT_LOCALE)


@contextmanager
def use_locale(locale: Locale) -> Iterator[None]:
    """Activate a locale for the current request/task and restore it afterward."""
    token: Token[Locale] = _locale.set(locale)
    try:
        yield
    finally:
        _locale.reset(token)


def activate_locale(locale: Locale) -> None:
    """Set the locale for the remainder of the current task, with no scope to exit.

    Paired with :func:`use_locale` at the connection edge: the handler opens the scope with
    the client's stated language, then the agent narrows it once its turn starts and the
    user's own words are readable. Each turn runs in a fresh task that re-inherits the
    connection's value, so this never leaks into the next one.
    """
    _locale.set(locale)


class BackendI18n:
    """Resolve backend-private display strings for the active request locale."""

    _messages: Mapping[str, Mapping[Locale, str]] = {
        "provider.api_key_required": {
            "zh": "API Key 不能为空",
            "en": "API key is required.",
        },
        "provider.client_construct_failed": {
            "zh": "客户端构造失败：{detail}",
            "en": "Failed to create the provider client: {detail}",
        },
        "provider.response_timeout": {
            "zh": "供应商响应超时（{seconds:g} 秒），请检查网络或 Base URL",
            "en": "The provider timed out after {seconds:g} seconds. Check your network or Base URL.",
        },
        "provider.network_unreachable": {
            "zh": "网络无法连通：{detail}",
            "en": "Unable to reach the provider: {detail}",
        },
        "provider.non_json_endpoint": {
            "zh": "Base URL 指向的不是 API 端点（返回了非 JSON 内容），请检查是否漏了 /v1 等版本段",
            "en": "The Base URL is not an API endpoint (it returned non-JSON content). Check whether a version path such as /v1 is missing.",
        },
        "provider.authentication_failed": {
            "zh": "API Key 校验失败（{status_code}）",
            "en": "API key verification failed ({status_code}).",
        },
        "provider.model_or_endpoint_not_found": {
            "zh": "模型 / 端点不存在（404），请检查 Base URL 与 model id",
            "en": "The model or endpoint was not found (404). Check the Base URL and model ID.",
        },
        "provider.model_list_endpoint_not_found": {
            "zh": "模型列表端点不存在（404），请检查 Base URL",
            "en": "The model-list endpoint was not found (404). Check the Base URL.",
        },
        "provider.rate_limited": {
            "zh": "请求过于频繁（429），请稍后重试",
            "en": "Too many requests (429). Please try again later.",
        },
        "provider.response_status": {
            "zh": "供应商返回 {status_code}：{detail}",
            "en": "The provider returned {status_code}: {detail}",
        },
        "provider.response_status_without_detail": {
            "zh": "供应商返回 {status_code}",
            "en": "The provider returned {status_code}.",
        },
        "provider.models_parse_failed": {
            "zh": "无法解析供应商返回的模型列表：{detail}",
            "en": "Unable to parse the provider's model list: {detail}",
        },
        "provider.empty_model_list": {
            "zh": "供应商返回了空的模型列表",
            "en": "The provider returned an empty model list.",
        },
        "provider.codex_local_credentials_missing": {
            "zh": "未检测到本机 Codex 登录(~/.codex)。",
            "en": "No local Codex sign-in was found (~/.codex).",
        },
        "provider.oauth_port_occupied": {
            "zh": "端口 1455 被外部进程占用(可能有 codex CLI 登录在进行)，请结束后重试。",
            "en": "Port 1455 is in use by another process (possibly a Codex CLI sign-in). End it and try again.",
        },
        "workflow.import.archive_extension": {
            "zh": "请选择 {suffix} 工作流文件。",
            "en": "Select a {suffix} Workflow file.",
        },
        "workflow.import.name_conflict": {
            "zh": "工作流名称“{name}”已存在，无法重复导入。",
            "en": "A Workflow named “{name}” already exists and cannot be imported again.",
        },
        "workflow.import.failed": {
            "zh": "无法导入工作流：{reason}",
            "en": "Unable to import Workflow: {reason}",
        },
        "workflow.export.failed": {
            "zh": "无法导出工作流：{reason}",
            "en": "Unable to export Workflow: {reason}",
        },
        "workflow.rename.name_conflict": {
            "zh": "工作流名称“{name}”已存在。",
            "en": "A Workflow named “{name}” already exists.",
        },
        "codex.auth_missing_refresh_token": {
            "zh": "Codex 登录信息缺少刷新令牌，请重新登录。",
            "en": "Codex sign-in details are missing a refresh token. Please sign in again.",
        },
        "codex.rate_limited": {
            "zh": "Codex 请求过于频繁，请稍后重试。",
            "en": "Too many Codex requests. Please try again later.",
        },
        "codex.refresh_failed": {
            "zh": "刷新 Codex 登录信息失败（HTTP {status}）。",
            "en": "Failed to refresh the Codex sign-in (HTTP {status}).",
        },
        "codex.refresh_invalid_json": {
            "zh": "Codex 刷新接口返回了无法解析的响应，请重新登录。",
            "en": "The Codex refresh endpoint returned an unreadable response. Please sign in again.",
        },
        "codex.refresh_missing_access_token": {
            "zh": "Codex 刷新响应缺少访问令牌，请重新登录。",
            "en": "The Codex refresh response is missing an access token. Please sign in again.",
        },
        "codex.exchange_failed": {
            "zh": "交换 Codex 授权码失败（HTTP {status}）：{body}",
            "en": "Failed to exchange the Codex authorization code (HTTP {status}): {body}",
        },
        "codex.exchange_missing_access_token": {
            "zh": "Codex 授权响应缺少访问令牌。",
            "en": "The Codex authorization response is missing an access token.",
        },
        "codex.login_missing": {
            "zh": "未检测到 Codex 登录信息，请重新登录。",
            "en": "No Codex sign-in details were found. Please sign in again.",
        },
        "codex.oauth_success": {
            "zh": "Codex 登录成功，可以返回应用。",
            "en": "Codex sign-in succeeded. You can return to the app.",
        },
        "codex.oauth_launching_app": {
            "zh": "正在返回 {product}…",
            "en": "Returning to {product}…",
        },
        "codex.oauth_open_app": {
            "zh": "请返回 {product}。",
            "en": "Return to {product}.",
        },
        "codex.oauth_login_failed": {
            "zh": "Codex 登录失败：{error}",
            "en": "Codex sign-in failed: {error}",
        },
        "codex.connectivity_stream_interrupted": {
            "zh": "{details} | 连接已建立但流式响应中途被切断（常见于长响应经跨境链路或代理网关被 idle 或时长上限截断）。若为长耗时回合，请为该 Codex 渠道换用不缓冲、放宽读超时的直连或代理；短请求可正常说明是链路稳定性问题，而非鉴权或模型问题。",
            "en": "{details} | The connection was established but the streaming response was cut off. This commonly happens when a long response crosses a network path or proxy gateway with idle or duration limits. For long-running turns, use a direct connection or proxy that does not buffer responses and allows a longer read timeout; if short requests work, this is a network-stability issue rather than authentication or model access.",
        },
        "codex.connectivity_unreachable": {
            "zh": "{details} | 该端点位于 chatgpt.com；受限或跨境网络下该主机可能被阻断或超时，而同机的 API-Key 渠道（如 DeepSeek 等国内主机）不受影响。请确认可直连 {host}，或为该 Codex 渠道配置可用代理（base_url 会规整到 /codex/responses）。",
            "en": "{details} | This endpoint is hosted on chatgpt.com. Restricted or cross-border networks may block or time out this host, even when API-key providers on other hosts work. Confirm that {host} is reachable directly, or configure a working proxy for this Codex channel (base_url is normalized to /codex/responses).",
        },
        "agent.build_conflict.header": {
            "zh": "未完成构建",
            "en": "Unfinished build",
        },
        "agent.build_conflict.question_replace": {
            "zh": "我发现当前请求与未完成的构建可能存在冲突：{reason}\n\n是否放弃当前构建并开始编辑所选工作流？",
            "en": "This request may conflict with an unfinished build: {reason}\n\nDiscard the current build and edit the selected workflow?",
        },
        "agent.build_conflict.question_new": {
            "zh": "我发现当前请求与未完成的构建可能存在冲突：{reason}\n\n你希望如何处理？",
            "en": "This request may conflict with an unfinished build: {reason}\n\nHow would you like to proceed?",
        },
        "agent.build_conflict.option_keep": {
            "zh": "保留并继续",
            "en": "Keep and continue",
        },
        "agent.build_conflict.desc_keep": {
            "zh": "忽略这次请求，继续当前 Build。",
            "en": "Ignore this request and continue the current Build.",
        },
        "agent.build_conflict.option_merge": {
            "zh": "融合新需求",
            "en": "Merge new requirements",
        },
        "agent.build_conflict.desc_merge": {
            "zh": "保留 task.md，将新需求重新纳入澄清。",
            "en": "Keep task.md and bring the new requirements back into clarification.",
        },
        "agent.build_conflict.option_replace_edit": {
            "zh": "删除并编辑",
            "en": "Discard and edit",
        },
        "agent.build_conflict.desc_replace_edit": {
            "zh": "删除当前草稿，恢复并编辑所选工作流。",
            "en": "Discard the current draft, restore, and edit the selected Workflow.",
        },
        "agent.build_conflict.option_replace_new": {
            "zh": "删除并新建",
            "en": "Discard and start over",
        },
        "agent.build_conflict.desc_replace_new": {
            "zh": "删除现有草稿，使用这次请求重新开始。",
            "en": "Discard the current draft and start over with this request.",
        },
        "agent.workflow_run_choice.header": {
            "zh": "工作流运行",
            "en": "Workflow run",
        },
        "agent.workflow_run_choice.default_reason": {
            "zh": "目前无法确定用户想继续旧运行，还是按当前版本重新开始。",
            "en": "It is unclear whether to continue the existing run or restart from the current version.",
        },
        "agent.workflow_run_choice.question": {
            "zh": "当前会话还有未完成的工作流运行。{reason}\n\n你希望继续原运行，还是丢弃它并从头运行{target}？",
            "en": "This session has an unfinished Workflow run. {reason}\n\nContinue it, or discard it and start {target} again?",
        },
        "agent.workflow_run_choice.target_same": {
            "zh": "工作流“{name}”",
            "en": "Workflow “{name}”",
        },
        "agent.workflow_run_choice.target_other": {
            "zh": "另一个工作流“{name}”",
            "en": "another Workflow “{name}”",
        },
        "agent.workflow_run_choice.option_resume": {
            "zh": "继续原运行",
            "en": "Resume run",
        },
        "agent.workflow_run_choice.desc_resume": {
            "zh": "保留原快照、输入和执行进度，从当前步骤继续。",
            "en": "Keep the original snapshot, input, and progress, then continue from the current step.",
        },
        "agent.workflow_run_choice.option_restart": {
            "zh": "丢弃并重新运行",
            "en": "Discard and restart",
        },
        "agent.workflow_run_choice.desc_restart": {
            "zh": "准备当前保存版本的新快照，成功后删除原运行。",
            "en": "Prepare a fresh snapshot of the saved version, then discard the original run after success.",
        },
        "interaction.empty_selection": {
            "zh": "都不选择",
            "en": "Select none",
        },
        "security.label.system_dangerous_operation": {
            "zh": "系统级危险操作",
            "en": "System-level dangerous operation",
        },
        "security.label.sensitive_file_access": {
            "zh": "读写敏感文件",
            "en": "Access sensitive files",
        },
        "security.label.execute_command": {
            "zh": "执行命令",
            "en": "Execute command",
        },
        "security.label.network_access": {
            "zh": "联网",
            "en": "Access the network",
        },
        "security.label.external_tool_call": {
            "zh": "调用外部工具",
            "en": "Call an external tool",
        },
        "security.label.modify_builtin_skill": {
            "zh": "修改 Agent 内置技能",
            "en": "Modify an Agent built-in skill",
        },
        "security.label.edit_outside_workspace": {
            "zh": "编辑工作区外文件",
            "en": "Edit a file outside the workspace",
        },
        "security.label.edit_file": {
            "zh": "编辑文件",
            "en": "Edit a file",
        },
        "security.label.read_file": {
            "zh": "读取文件",
            "en": "Read a file",
        },
        "security.label.in_app_write": {
            "zh": "应用内写操作",
            "en": "In-app write operation",
        },
        "security.label.management_operation": {
            "zh": "管理操作",
            "en": "Management operation",
        },
        "security.classifier.unavailable": {
            "zh": "安全检查不可用，已转人工确认。",
            "en": "Safety check is unavailable; manual confirmation is required.",
        },
        "security.classifier.uncovered": {
            "zh": "安全检查未覆盖该项，已转人工确认。",
            "en": "Safety check did not cover this item; manual confirmation is required.",
        },
        "security.denied_by_policy": {
            "zh": "被安全政策拒绝。",
            "en": "Denied by the security policy.",
        },
        "security.confirmation_required": {
            "zh": "需要你确认。",
            "en": "Confirmation is required.",
        },
        "security.approval.allowed_mark": {
            "zh": "✅ 允许",
            "en": "✅ allowed",
        },
        "security.approval.denied_mark": {
            "zh": "⛔ 拒绝",
            "en": "⛔ denied",
        },
        "security.approval.target": {
            "zh": "目标: {target}",
            "en": "target: {target}",
        },
        "mount.path_must_be_absolute": {
            "zh": "挂载路径必须为绝对路径：{path!r}。",
            "en": "Mount path must be absolute: {path!r}.",
        },
        "mount.path_not_found": {
            "zh": "Agent 主机上不存在该路径：{path!r}。",
            "en": "No such path on the agent host: {path!r}.",
        },
        "mount.workspace_not_removable": {
            "zh": "会话工作区挂载不可移除。",
            "en": "The Session workspace mount cannot be removed.",
        },
        "mount.not_found": {
            "zh": "不存在该挂载：{id!r}。",
            "en": "No such mount: {id!r}.",
        },
        "mount.upload_too_large": {
            "zh": "会话附件超过 64 MiB 上传上限。",
            "en": "Session attachment exceeds the 64 MiB upload limit.",
        },
        "mount.default_session_title": {
            "zh": "新对话",
            "en": "New conversation",
        },
        "session.duplicate.only_finished": {
            "zh": "只有已完成的会话可以复制。",
            "en": "Only finished Sessions can be duplicated.",
        },
        "session.duplicate.failed": {
            "zh": "复制会话失败：{detail}",
            "en": "Failed to duplicate session: {detail}",
        },
        "session.create.failed": {
            "zh": "创建会话失败：{detail}",
            "en": "Failed to create session: {detail}",
        },
        "session.delete.not_registered": {
            "zh": "会话 {session_id!r} 未注册。",
            "en": "Session {session_id!r} is not registered.",
        },
        "session.file.path_required": {
            "zh": "路径必须是非空的会话工作区相对路径。",
            "en": "Path must be a non-empty workspace-relative path.",
        },
        "session.file.path_escapes": {
            "zh": "路径超出了会话工作区。",
            "en": "Path escapes the session workspace.",
        },
        "session.file.not_found": {
            "zh": "会话 {session_id!r} 中不存在文件 {path!r}。",
            "en": "No file at {path!r} in session {session_id!r}.",
        },
        "session.child_default_title": {
            "zh": "子 Agent",
            "en": "Sub-agent",
        },
        "session.workflow_run_choice.fallback_question": {
            "zh": "工作流运行方式",
            "en": "Workflow run options",
        },
        "session.accept_rule.execution_only.response": {
            "zh": "该工作流未设置完成标准，运行时只执行步骤，无需结果校验；执行报错仍会正常失败。",
            "en": "This Workflow has no completion criteria. It will run the steps without validating the result; execution errors will still fail normally.",
        },
        "session.accept_rule.execution_only.question": {
            "zh": "已选择不设置完成标准",
            "en": "No completion criteria selected",
        },
        "session.accept_rule.later.question": {
            "zh": "完成标准稍后再对齐",
            "en": "Completion criteria will be aligned later",
        },
        "session.accept_rule.aligned.question": {
            "zh": "完成标准已对齐",
            "en": "Completion criteria aligned",
        },
        "session.build_conflict.fallback_question": {
            "zh": "未完成构建处理",
            "en": "Unfinished build handling",
        },
        "session.workflow_build.confirmation_question": {
            "zh": "工作流构建确认",
            "en": "Workflow build confirmation",
        },
        "session.workflow_save.confirmation_question": {
            "zh": "工作流保存确认",
            "en": "Workflow save confirmation",
        },
        "session.task_spec.confirmation_question": {
            "zh": "任务说明书确认",
            "en": "Task specification confirmation",
        },
        "llm.selected_model": {
            "zh": "所选模型",
            "en": "the selected model",
        },
        "llm.model_not_found": {
            "zh": "模型 ID {model_display} 无效或不存在(provider 返回 model-not-found / 404)。请核对该厂商的真实模型 ID(例如 DeepSeek 用 deepseek-chat / deepseek-reasoner),或在模型设置里改成有效 ID。",
            "en": "Model ID {model_display} is invalid or unavailable (the provider returned model-not-found / 404). Check the provider's model ID and select a valid model.",
        },
        "llm.daily_quota_exhausted": {
            "zh": "当天配额(每日请求上限)已用完,退避重试无意义(次日才重置)。请明天再试,或在模型选择里切换到其他厂商 / 模型。",
            "en": "The daily request quota has been used up, so retrying will not help until it resets tomorrow. Try again tomorrow or switch to another provider or model.",
        },
        "llm.kimi.k3_access_denied": {
            "zh": "Kimi 服务端报告当前 API Key 所属账号没有 k3 权限。如果该账号已经是 Moderato，请在同一账号的 Kimi Code 控制台重新创建 API Key；仍未生效时请联系 Kimi 检查会员权益同步。",
            "en": "Kimi reports that the API key's account does not have access to k3. If the account is already on Moderato, create a new API key in the Kimi Code console for the same account; if it still does not work, contact Kimi to check whether the subscription benefits have synced.",
        },
        "llm.kimi.highspeed_access_denied": {
            "zh": "当前 Kimi Code 订阅无权使用 kimi-for-coding-highspeed；请改用 kimi-for-coding，或升级到 Allegretto 或更高等级。",
            "en": "The current Kimi Code subscription cannot use kimi-for-coding-highspeed. Use kimi-for-coding instead, or upgrade to Allegretto or above.",
        },
        "llm.codex_credentials_missing": {
            "zh": "未找到用户 {user_id!r} 的 Codex 登录信息。完成 Codex 订阅授权后重试(POST /me/providers/openai-codex/oauth/start)。",
            "en": "No Codex credentials for user {user_id!r}. Complete Codex subscription authorization and try again (POST /me/providers/openai-codex/oauth/start).",
        },
        "agent.error.context_too_large": {
            "zh": "这次对话内容太多，当前模型无法继续处理。请精简内容，或新建一个对话后再试。",
            "en": "This conversation has too much content for the current model. Shorten it or start a new conversation and try again.",
        },
        "agent.error.empty_answer": {
            "zh": "抱歉，这次任务没有生成回复。请重新运行一次；如果仍然没有回复，可以换一个模型再试。",
            "en": "Sorry, no response was generated for this task. Run it again, or try another model if it still produces no response.",
        },
        "agent.error.image_input_unsupported": {
            "zh": "当前模型“{model_display}”不支持图片输入。请切换到支持图片/视觉输入的模型，或移除消息中的图片后重试。",
            "en": "The current model, {model_display}, does not support image input. Switch to a vision-capable model or remove the images and try again.",
        },
        "agent.error.image_input_invalid": {
            "zh": "图片无法作为模型输入。请确认图片是 PNG、JPEG、GIF 或 WebP 格式，单张不超过 5 MB，并重新添加后再试。",
            "en": "The image could not be sent to the model. Re-add a PNG, JPEG, GIF, or WebP image no larger than 5 MB and try again.",
        },
        "agent.error.model_not_found": {
            "zh": "当前选择的模型无法使用。请前往模型设置，选择其他模型后再试。",
            "en": "The selected model cannot be used right now. Choose another model in settings and try again.",
        },
        "agent.error.quota_exhausted": {
            "zh": "当前模型的使用次数已用完。请稍后再试，或换一个模型。",
            "en": "The current model has no usage remaining. Try again later or choose another model.",
        },
        "agent.error.rate_limited": {
            "zh": "当前服务繁忙，请稍后再试。",
            "en": "The service is busy right now. Please try again later.",
        },
        "agent.error.authentication_failed": {
            "zh": "当前模型需要重新连接。请前往模型设置，完成连接后再试。",
            "en": "The selected model needs to be reconnected. Open model settings, reconnect it, and try again.",
        },
        "agent.error.login_required": {
            "zh": "当前模型的登录已失效。请重新登录后再试。",
            "en": "The selected model's sign-in has expired. Sign in again and try again.",
        },
        "agent.error.content_rejected": {
            "zh": "这次输入的部分内容无法处理。请调整相关内容后再试。",
            "en": "Some of this message could not be processed. Adjust that content and try again.",
        },
        "agent.error.permission_denied": {
            "zh": "当前账号不能使用这个模型。请换一个模型，或联系管理员开通权限。",
            "en": "Your account cannot use this model. Choose another model or ask your administrator for access.",
        },
        "agent.error.model_or_endpoint_not_found": {
            "zh": "当前模型的连接设置有问题。请前往模型设置检查，或换一个模型后再试。",
            "en": "There is a problem with the selected model's connection. Check it in model settings or choose another model.",
        },
        "agent.error.request_rejected": {
            "zh": "当前模型无法处理这次内容。请换一种说法、精简内容，或换一个模型后再试。",
            "en": "The selected model could not handle this message. Reword or shorten it, or choose another model and try again.",
        },
        "agent.error.stream_interrupted": {
            "zh": "回复生成到一半时连接中断了。请重新试一次；如果仍然失败，请检查网络连接。",
            "en": "The connection was interrupted while the response was being generated. Try again, and check your network if it keeps happening.",
        },
        "agent.error.request_timeout": {
            "zh": "等待回复的时间过长，本次任务已停止。请重新试一次，并确认网络连接正常。",
            "en": "The response took too long, so this task was stopped. Try again and make sure your network is working.",
        },
        "agent.error.network_unreachable": {
            "zh": "暂时无法连接服务。请检查网络后再试。",
            "en": "The service could not be reached. Check your network and try again.",
        },
        "agent.error.provider_unavailable": {
            "zh": "当前服务暂时不可用。请稍后再试，或换一个模型。",
            "en": "The service is temporarily unavailable. Try again later or choose another model.",
        },
        "agent.error.trace_too_large": {
            "zh": "这次任务包含的步骤太多，结果无法完整保存。请把任务拆成几个较小的步骤后再试。",
            "en": "This task produced too much information to save completely. Break it into smaller tasks and try again.",
        },
        "agent.error.internal": {
            "zh": "处理任务时出现了问题。请重新试一次；如果仍然失败，请稍后再试。",
            "en": "Something went wrong while handling this task. Try again, or wait a moment if it keeps happening.",
        },
        "agent.describe.system_prompt": {
            "zh": "你在向不懂命令行的普通用户解释 Agent 即将执行的操作。把每条工具调用用一句简短中文说明它实际会做什么：说人话、聚焦效果，不要罗列参数或术语。\n只输出 JSON 数组并与输入顺序一一对应，每项格式为\n{{\"index\": 序号, \"summary\": \"一句中文说明\"}}，不要输出其他内容。\n",
            "en": "Explain each pending Agent tool call to a non-technical user in one short plain-English sentence. State what it will do in practical terms; do not list parameters or jargon.\nOutput only a JSON array in the same order as the input. Each item must be {{\"index\": number, \"summary\": \"one concise English sentence\"}}. Do not output anything else.\n",
        },
        "agent.describe.pending_count": {
            "zh": "返回恰好 {count} 项。",
            "en": "Return exactly {count} items.",
        },
        "agent.describe.pending_heading": {
            "zh": "待解释的调用：",
            "en": "Calls to explain:",
        },
        "agent.input.build_intent": {
            "zh": "我明确要求将后续需求构建成一个可复用的 Workflow。构建需求：",
            "en": "I explicitly request that the following requirement be built into a reusable Workflow. Build requirement:",
        },
        "agent.input.workflow_run_intent": {
            "zh": "我明确要求运行已保存的 Workflow“{label}”（workflow_id: `{workflow_id}`）。运行输入：",
            "en": "I explicitly request to run the saved Workflow “{label}” (workflow_id: `{workflow_id}`). Run input:",
        },
        "scheduler.notification.failed_title": {"zh": "定时任务失败", "en": "Scheduled task failed"},
        "scheduler.notification.failed_body": {"zh": "「{name}」本次运行失败", "en": "“{name}” failed this run."},
        "scheduler.notification.action_required_title": {"zh": "定时任务需要你处理", "en": "Scheduled task needs your attention"},
        "scheduler.notification.action_required_body": {"zh": "「{name}」有一步操作等待你确认", "en": "“{name}” has an action waiting for your confirmation."},
        "agent.schedule.not_found": {"zh": "未找到定时任务 {schedule_id!r}。", "en": "Scheduled task {schedule_id!r} not found."},
        "agent.schedule.mutation_blocked": {"zh": "定时任务运行期间不能创建或修改定时任务。", "en": "Scheduled tasks cannot be created or modified while a scheduled run is in progress."},
        "agent.schedule.status_enabled": {"zh": "已启用", "en": "enabled"},
        "agent.schedule.status_paused": {"zh": "已暂停", "en": "paused"},
        "agent.schedule.none": {"zh": "无", "en": "none"},
        "agent.schedule.created": {"zh": "已创建定时任务：{summary}。任务：{description}", "en": "Created scheduled task: {summary}. Task: {description}"},
        "agent.schedule.updated": {"zh": "已更新定时任务：{summary}。任务：{description}", "en": "Updated scheduled task: {summary}. Task: {description}"},
        "agent.schedule.deleted": {"zh": "已删除定时任务：{summary}", "en": "Deleted scheduled task: {summary}"},
        "agent.schedule.no_matches": {"zh": "没有匹配的定时任务。", "en": "No matching scheduled tasks."},
        "agent.schedule.detail": {"zh": "{summary}\n任务：{description}\n引用：{refs}", "en": "{summary}\nTask: {description}\nReferences: {refs}"},
        "agent.schedule.required_fields": {"zh": "名称、任务描述和 cron 都不能为空。", "en": "Name, task description, and cron are all required."},
        "agent.schedule.invalid_cron": {"zh": "无效的 cron 表达式 {cron!r}；请使用六字段格式：秒 分 时 日 月 周。", "en": "Invalid cron expression {cron!r}; use six fields: sec min hour dom mon dow."},
        "agent.schedule.catalogue_unavailable": {"zh": "当前 Agent 上下文中没有可用的定时任务目录。", "en": "No schedule catalogue is available in this Agent context."},
        "agent.schedule.invalid_enabled": {"zh": "无效的 enabled 值：{value!r}。省略该字段可跳过筛选，或传入 true / false。", "en": "Invalid value for enabled: {value!r}. Omit the field to skip filtering, or pass true / false."},
        "chat.reply_in_progress": {
            "zh": "当前回复仍在生成，请等待完成或先停止，再发送新消息。",
            "en": "A reply is still being generated. Wait for it to finish or stop it before sending another message.",
        },
    }

    def current_locale(self) -> Locale:
        return _locale.get()

    def text(self, message_id: str, *, locale: Locale | None = None, **values: object) -> str:
        """Return a localized service message, failing clearly for unknown ids."""
        try:
            template = self._messages[message_id][locale or self.current_locale()]
        except KeyError as exc:
            raise KeyError(f"Unknown backend i18n message: {message_id}") from exc
        return template.format(**values)


backend_i18n = BackendI18n()
