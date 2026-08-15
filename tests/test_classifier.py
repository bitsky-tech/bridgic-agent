"""分类器契约:ClassifyItem 携带 running cwd、提示词展示"当前目录"。

覆盖分类器接收 running cwd 并在提示词中展示当前目录的契约。
"""

from __future__ import annotations

from pathlib import Path

from bridgic.amphibious import StepToolCall, ToolArgument

from src.amphi_agent.security._classifier import (
    ClassifyItem,
    ClassifyVerdict,
    LlmSafetyClassifier,
    _build_system_prompt,
    _build_user_prompt,
    _parse,
)
from src.amphi_agent.security._default_policy import DEFAULT_POLICY
from src.amphi_agent.security._engine import PermissionEngine
from src.amphi_agent.security._policy import Policy, soft_deny_ids, soft_deny_title
from src.amphi_agent.security._types import ExecutionMode
from src.amphi_service.i18n import use_locale


def _call(cmd: str) -> StepToolCall:
    return StepToolCall(tool="bash", tool_arguments=[
        ToolArgument(name="command", value=cmd),
        ToolArgument(name="cwd", value="/workspace"),
    ])


async def test_classifier_item_carries_running_cwd() -> None:
    captured: dict = {}

    class _Capture:
        async def judge(self, items, user_messages, roots, agent_reasoning="", session_approvals=None, named_paths=None):
            captured["items"] = items
            return [ClassifyVerdict(verdict="allow", reason="ok") for _ in items]

    engine = PermissionEngine("/workspace", [], ExecutionMode.AUTO, classifier=_Capture())
    await engine.evaluate([_call("cd /data && rm -rf $VAR")])
    assert captured["items"][0].cwd == "/data"


def test_system_prompt_is_static_policy_only_and_complete() -> None:
    policy = Policy(
        allow=("允许-读只读",),
        soft_deny=("软拦-越权",),
        hard_deny=("硬拦-数据外发",),
        environment=("信任边界-仅工作区",),
    )
    prompt = _build_system_prompt(policy)
    assert prompt == _build_system_prompt(policy)
    for token in (
        "允许-读只读",
        "软拦-越权",
        "硬拦-数据外发",
        "信任边界-仅工作区",
        "deny",
        "ask",
        "allow",
    ):
        assert token in prompt, token

    default_prompt = _build_system_prompt(DEFAULT_POLICY)
    for token in ("SOFT DENY", "HARD DENY", "Cross-check", "Decisions already made this session", "no need to unfold"):
        assert token in default_prompt, token
    assert DEFAULT_POLICY.soft_deny[0][:6] in default_prompt
    assert DEFAULT_POLICY.hard_deny[0][:6] in default_prompt

    for dynamic in ("ARGS_MARK_A", "CWD_MARK_B", "USERREQ_MARK_C", "ROOT_MARK_D", "REASONING_MARK_Q"):
        assert dynamic not in prompt


def test_user_prompt_contains_only_present_dynamic_context() -> None:
    item = ClassifyItem(
        tool="bash",
        arguments={"command": "ARGS_MARK_A"},
        capability="execute",
        boundary="none",
        label="执行命令",
        cwd="CWD_MARK_B",
    )
    prompt = _build_user_prompt(
        [item],
        ["USERREQ_MARK_C"],
        ["ROOT_MARK_D"],
        "REASONING_MARK_Q 需回传登录码",
        ["✅ 允许 `bash`: APPROVAL_MARK_E"],
    )
    for token in (
        "ARGS_MARK_A",
        "CWD_MARK_B",
        "USERREQ_MARK_C",
        "ROOT_MARK_D",
        "REASONING_MARK_Q",
        "APPROVAL_MARK_E",
        "untrusted",
        "cross-checked",
        "approved",
    ):
        assert token in prompt, token

    minimal = _build_user_prompt([item], ["req"], ["/ws"], "", None)
    assert "Agent reasoning" not in minimal
    assert "approved" not in minimal


def test_user_prompt_carries_reasoning_labeled_untrusted() -> None:
    # 待核验通道:Agent 推理进 user 侧,且明确标注"不可信 + 须交叉核验"。
    item = ClassifyItem(tool="bash", arguments={"command": "x"}, capability="execute", boundary="none", label="", cwd=None)
    up = _build_user_prompt([item], ["登录飞书"], ["/ws"], "REASONING_MARK_Z 需回传登录码")
    assert "REASONING_MARK_Z" in up
    assert "untrusted" in up and "cross-checked" in up


def test_reasoning_absent_section_omitted() -> None:
    # 无推理时不硬塞空段。
    item = ClassifyItem(tool="bash", arguments={"command": "x"}, capability="execute", boundary="none", label="", cwd=None)
    assert "Agent reasoning" not in _build_user_prompt([item], ["req"], ["/ws"], "")


def test_reasoning_stays_out_of_system_prompt() -> None:
    # 动态推理只进 user 侧,不污染可缓存的系统前缀。
    sp = _build_system_prompt(Policy(soft_deny=("s",)))
    item = ClassifyItem(tool="bash", arguments={}, capability="execute", boundary="none", label="", cwd=None)
    up = _build_user_prompt([item], [], ["/ws"], "REASONING_MARK_Q")
    assert "REASONING_MARK_Q" in up and "REASONING_MARK_Q" not in sp


def test_system_prompt_has_cross_verify_rule() -> None:
    # 交叉核验规则是静态政策级,进系统提示词(仍可缓存)。
    assert "Cross-check" in _build_system_prompt(DEFAULT_POLICY)


def test_system_prompt_states_default_pass_baseline() -> None:
    # auto 铁律:除【明显风险】【可能风险】外一律默认通过。风险清单是例外、不是审查清单。
    prompt = _build_system_prompt(DEFAULT_POLICY)
    assert "passes by default" in prompt
    assert "obvious risk" in prompt and "possible risk" in prompt


def test_system_prompt_sets_soft_deny_hit_threshold() -> None:
    # 24 条软拦摆在眼前会诱发"总能匹配上一条"的清单效应;必须给命中门槛,
    # 并把拿不准的默认值定为"不命中"(与旧的一律转人工相反)。
    prompt = _build_system_prompt(DEFAULT_POLICY)
    assert "is adjacent to some entry" in prompt
    assert "treat it as no match" in prompt
    assert "SOFT DENY — block by default" not in prompt  # 标题本身不得暗示"默认拦"


def test_system_prompt_triages_by_reversibility_not_blanket_ask() -> None:
    # auto 的默认倾向:灰色地带按后果可逆性分流,而非一律保守转人工。
    # 弹窗要留给"用户真有可能拒绝"的操作;必然被点允许的常规步骤问了等于没问。
    # "拿不准"的默认值由 test_system_prompt_sets_soft_deny_hit_threshold 断言,这里只管可逆性口径。
    prompt = _build_system_prompt(DEFAULT_POLICY)
    assert "irreversible" in prompt and "rollback-able" in prompt
    assert "when in doubt, escalate" not in prompt  # 旧的一刀切措辞须移除


def test_user_prompt_carries_session_approvals() -> None:
    # 可信通道之二:本会话用户已决策,进 user 侧,标注为可信(等同点名)。
    item = ClassifyItem(tool="bash", arguments={"command": "x"}, capability="execute", boundary="none", label="", cwd=None)
    up = _build_user_prompt([item], ["req"], ["/ws"], "", ["✅ 允许 `bash`: 运行部署脚本"])
    assert "运行部署脚本" in up and "approved" in up


def test_session_approvals_absent_section_omitted() -> None:
    item = ClassifyItem(tool="bash", arguments={"command": "x"}, capability="execute", boundary="none", label="", cwd=None)
    assert "approved" not in _build_user_prompt([item], ["req"], ["/ws"], "", None)


def test_system_prompt_has_session_decision_rule() -> None:
    prompt = _build_system_prompt(DEFAULT_POLICY)
    assert "Decisions already made this session" in prompt
    # 已批准的同类操作是**硬规则**而非倾向:逐字节相同的重复调用已被代码层拦下,
    # 能走到模型面前的必然是有差异的变体,不能因为字面不同就重新问一遍。
    assert "it must be allow" in prompt


def test_user_prompt_carries_workspace_root() -> None:
    # 工作区根移到 user 侧(配合缓存友好布局)。
    item = ClassifyItem(tool="bash", arguments={"command": "ls"}, capability="read", boundary="in_workspace", label="", cwd="/ws")
    assert "/ws-root" in _build_user_prompt([item], ["req"], ["/ws-root"])


def test_parse_three_way_and_unknown_downgrades_to_ask() -> None:
    content = (
        '[{"index":0,"verdict":"allow","rule":"","reason":"ok"},'
        '{"index":1,"verdict":"deny","rule":"Data Exfiltration","reason":"外发"},'
        '{"index":2,"verdict":"weird","rule":"","reason":"未知"}]'
    )
    out = _parse(content, 3, DEFAULT_POLICY)
    assert out[0].verdict == "allow"
    assert out[1].verdict == "deny" and out[1].rule == "Data Exfiltration"
    assert out[2].verdict == "ask"  # 未知裁决保守转人工


def test_parse_malformed_fails_closed_to_ask() -> None:
    for bad in ("", "not json", '{"verdict":"allow"}', '[{"verdict":"allow"}]'):  # 最后一个长度不符(需 2)
        out = _parse(bad, 2, DEFAULT_POLICY)
        assert len(out) == 2 and all(v.verdict == "ask" for v in out)


def test_classifier_fallback_reason_uses_the_request_locale() -> None:
    """The classifier's fail-closed copy is part of the approval-card payload."""
    from src.amphi_agent.security._classifier import _fallback

    with use_locale("en"):
        fallback = _fallback(1)

    assert fallback[0].verdict == "ask"
    assert fallback[0].reason == "Safety check is unavailable; manual confirmation is required."


def test_parse_reorders_by_index() -> None:
    # 模型乱序输出:必须按 index 归位,危险调用(位 0)不能拿到别处的 allow。
    content = (
        '[{"index":1,"verdict":"allow","reason":"ok"},'
        '{"index":0,"verdict":"deny","rule":"X","reason":"no"}]'
    )
    out = _parse(content, 2, DEFAULT_POLICY)
    assert out[0].verdict == "deny" and out[1].verdict == "allow"


def test_parse_bad_index_fails_closed() -> None:
    # 重复 index:模型自己混乱了,采信第一条可能把本该 deny 的调用配成 allow → 冲突的都丢。
    # 部分缺 index:那条裁决属于哪个调用不可知,与"乱序按位置对齐"是同一类 fail-open。
    for content in (
        '[{"index":0,"verdict":"allow"},{"index":0,"verdict":"deny"}]',   # 重复
        '[{"index":0,"verdict":"allow"},{"verdict":"deny"}]',             # 部分缺 index
    ):
        out = _parse(content, 2, DEFAULT_POLICY)
        assert all(v.verdict == "ask" for v in out), content


def test_parse_degrades_per_item_not_whole_batch() -> None:
    """语义变更(原为整批 ask):个别项有问题时**逐条**降级,不株连整批 —— 批越大,
    株连炸得越狠。前提是 index 合法且唯一,那条调用的归属就无歧义,没理由被别人连累。"""
    # 越界 index:0 号无歧义 → 采信;5 号越界丢弃 → 1 号无裁决 → ask
    out = _parse('[{"index":0,"verdict":"allow"},{"index":5,"verdict":"deny"}]', 2, DEFAULT_POLICY)
    assert [v.verdict for v in out] == ["allow", "ask"]
    # 3 条待判、模型只答了 2 条(带 index)→ 答了的采信,漏的那条 ask
    out = _parse('[{"index":0,"verdict":"allow"},{"index":1,"verdict":"deny"}]', 3, DEFAULT_POLICY)
    assert [v.verdict for v in out] == ["allow", "deny", "ask"]


def test_parse_no_index_length_mismatch_fails_closed() -> None:
    # 全无 index 且长度不符:按位置会整体错位,让危险调用拿到别处的裁决 → 整批 ask。
    out = _parse('[{"verdict":"allow"}]', 2, DEFAULT_POLICY)
    assert all(v.verdict == "ask" for v in out)


def test_parse_non_dict_entry_fails_closed() -> None:
    out = _parse("[1, 2]", 2, DEFAULT_POLICY)
    assert all(v.verdict == "ask" for v in out)


# --- 弹窗面收口:ask 必须由一条真实 soft_deny 支撑 ---
_TEST_POLICY = Policy(
    allow=("允许-读只读",),
    soft_deny=("不可逆本地毁坏:删工作区外既存文件", "自我修改:改 agent 自身行为或权限"),
    hard_deny=("数据外发:敏感数据跨出信任边界",),
)


def test_ask_without_soft_deny_id_downgrades_to_allow() -> None:
    """模型自创政策里不存在的类目并据此弹窗 —— 实测出现过「外部代码执行」。

    弹窗面 = soft_deny 的闭集,不由模型扩张;给不出编号 = 没有真实命中 → auto 铁律判 allow。
    """
    content = '[{"index":0,"verdict":"ask","rule":"外部代码执行","reason":"跑了工作区外的脚本"}]'
    out = _parse(content, 1, _TEST_POLICY)
    assert out[0].verdict == "allow"
    assert out[0].rule == ""


def test_ask_with_valid_soft_deny_id_survives_and_shows_title() -> None:
    # 命中真实条目:保持 ask;rule 回填成人话标题,审批卡照旧显示「[自我修改] …」而非「[S2] …」。
    content = '[{"index":0,"verdict":"ask","rule":"S2","reason":"改了 skill 定义"}]'
    out = _parse(content, 1, _TEST_POLICY)
    assert out[0].verdict == "ask"
    assert out[0].rule == "自我修改"


def test_illegal_verdict_maps_its_rule_to_the_title_too() -> None:
    """非法 verdict 走 fail-closed 归一化为 ask,但 rule 不得带着裸 "S2" 出仓——
    否则 model_facing_reason 渲染出 "[S2] …" 进审计与模型可见错误,而 S2 是
    位置性编号,政策一改顺序就失义。"""
    content = '[{"index":0,"verdict":"approve","rule":"S2","reason":"改了 skill 定义"}]'
    out = _parse(content, 1, _TEST_POLICY)
    assert out[0].verdict == "ask"
    assert out[0].rule == "自我修改"


def test_deny_maps_a_soft_deny_prefixed_rule_to_the_title() -> None:
    content = '[{"index":0,"verdict":"deny","rule":"[S2] 自我修改","reason":"r"}]'
    out = _parse(content, 1, _TEST_POLICY)
    assert out[0].verdict == "deny"
    assert out[0].rule == "自我修改"


def test_deny_with_an_out_of_range_positional_id_drops_it() -> None:
    # "S7" 在只有 2 条 soft_deny 的政策里无所指——位置编号不指向任何真实类目时
    # 宁可为空,也不能让裸编号进入审计与模型可见错误。类目名文本(见上一测试)照旧透传。
    content = '[{"index":0,"verdict":"deny","rule":"S7","reason":"r"}]'
    out = _parse(content, 1, _TEST_POLICY)
    assert out[0].verdict == "deny"
    assert out[0].rule == ""


def test_soft_deny_id_extraction_tolerates_wrapping() -> None:
    # 模型常把编号包在方括号里或缀上标题;容忍这些形态,但"没有编号"仍按未命中处理。
    for raw in ("S2", "s2", "[S2]", "[S2] 自我修改", "S2 自我修改"):
        out = _parse(f'[{{"index":0,"verdict":"ask","rule":"{raw}","reason":"r"}}]', 1, _TEST_POLICY)
        assert out[0].verdict == "ask", raw


def test_out_of_range_soft_deny_id_downgrades() -> None:
    # 政策只有 2 条,模型却报 S7 —— 同样是无据之 ask。
    out = _parse('[{"index":0,"verdict":"ask","rule":"S7","reason":"r"}]', 1, _TEST_POLICY)
    assert out[0].verdict == "allow"


def test_code_fallback_asks_are_not_downgraded() -> None:
    """区分"检查判无风险"与"检查没跑成功":后者仍 fail-closed,不受降级影响。

    否则超时 / 解析失败 / 模型输出非法裁决这几条兜底路径会被一起放行,
    把 fail-closed 的安全地板一并拆掉。
    """
    # 模型给了非法 verdict → 代码归一为 ask(带的 rule 也不是编号),不得降级
    out = _parse('[{"index":0,"verdict":"weird","rule":"","reason":"r"}]', 1, _TEST_POLICY)
    assert out[0].verdict == "ask"
    # 整体解析失败 → 全批 ask
    assert all(v.verdict == "ask" for v in _parse("not json", 2, _TEST_POLICY))
    # 模型漏答某项 → 该项 ask
    out = _parse('[{"index":0,"verdict":"allow","rule":"","reason":"r"}]', 2, _TEST_POLICY)
    assert out[1].verdict == "ask"


def test_deny_rule_is_not_constrained_to_soft_deny_ids() -> None:
    # deny 来自 hard_deny,不产生弹窗,rule 保持模型给的类目名原样透传。
    out = _parse('[{"index":0,"verdict":"deny","rule":"数据外发","reason":"r"}]', 1, _TEST_POLICY)
    assert out[0].verdict == "deny" and out[0].rule == "数据外发"


def test_system_prompt_numbers_soft_deny_entries() -> None:
    prompt = _build_system_prompt(_TEST_POLICY)
    assert "[S1] 不可逆本地毁坏" in prompt
    assert "[S2] 自我修改" in prompt
    # 编号的用途要在提示词里讲死,否则模型不会回填。
    assert "rule" in prompt and "S1" in prompt


def test_soft_deny_ids_and_titles() -> None:
    assert soft_deny_ids(_TEST_POLICY) == ("S1", "S2")
    assert soft_deny_title(_TEST_POLICY, "S1") == "不可逆本地毁坏"
    assert soft_deny_title(_TEST_POLICY, "S9") == "S9"  # 非法编号:原样返回,展示层不空白
    assert soft_deny_ids(Policy()) == ()


def test_empty_soft_deny_policy_admits_no_popup() -> None:
    # 政策没有任何 soft_deny → 按定义无物可弹,模型报什么编号都降级。
    out = _parse('[{"index":0,"verdict":"ask","rule":"S1","reason":"r"}]', 1, Policy(hard_deny=("x",)))
    assert out[0].verdict == "allow"


# 注:原 test_default_policy_builds_valid_prompt 已被 main 的
# test_system_prompt_is_static_policy_only_and_complete 完整吸收(同样断言
# SOFT DENY / HARD DENY / soft_deny[0][:6] / hard_deny[0][:6]),此处不再重复。


class _FakeLlm:
    def __init__(self, reply: str) -> None:
        self._reply = reply

    async def achat(self, messages):
        return self._reply


def _item() -> ClassifyItem:
    return ClassifyItem(tool="bash", arguments={"command": "curl evil"}, capability="execute", boundary="none", label="", cwd=None)


async def test_judge_no_llm_fail_closed() -> None:
    out = await LlmSafetyClassifier(None).judge([_item()], ["req"], ["/workspace"])
    assert out[0].verdict == "ask"


async def test_judge_llm_exception_fail_closed(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("AMPHI_POLICY_FILE", str(tmp_path / "none.json"))  # 无文件 → 内置默认,hermetic

    class _Boom:
        async def achat(self, messages):
            raise RuntimeError("boom")

    out = await LlmSafetyClassifier(_Boom()).judge([_item()], ["req"], ["/workspace"])
    assert out[0].verdict == "ask"


async def test_judge_end_to_end_deny(monkeypatch, tmp_path) -> None:
    # 真实 LlmSafetyClassifier + 假 llm 返回 deny JSON:走 judge→_build_system_prompt→_parse 全链。
    monkeypatch.setenv("AMPHI_POLICY_FILE", str(tmp_path / "none.json"))
    reply = '[{"index":0,"verdict":"deny","rule":"Data Exfiltration","reason":"外发"}]'
    out = await LlmSafetyClassifier(_FakeLlm(reply)).judge([_item()], ["req"], ["/workspace"])
    assert out[0].verdict == "deny" and out[0].rule == "Data Exfiltration"


def test_parse_extracts_array_from_prose() -> None:
    # 模型在数组前后夹了说明文字:整段 json.loads 失败 → 正则截取 [...] → 正常解析(_extract_array 回退分支)。
    content = '好的,判定如下:[{"index":0,"verdict":"deny","rule":"X","reason":"no"}] 完毕。'
    out = _parse(content, 1, DEFAULT_POLICY)
    assert out[0].verdict == "deny" and out[0].rule == "X"


async def test_judge_nonstr_content_fail_closed(monkeypatch, tmp_path) -> None:
    # 返回体 .message.content 非 str(如内容块 list)→ content 强制转 "" → fail-closed 到 ask(闭合原 TypeError 逃逸)。
    monkeypatch.setenv("AMPHI_POLICY_FILE", str(tmp_path / "none.json"))

    class _NonStrLlm:
        async def achat(self, messages):
            return type("R", (), {"message": type("M", (), {"content": [{"text": "x"}]})()})()

    out = await LlmSafetyClassifier(_NonStrLlm()).judge([_item()], ["req"], ["/workspace"])
    assert out[0].verdict == "ask"


async def test_judge_injects_reasoning_off_for_glm(monkeypatch, tmp_path) -> None:
    # glm-4.6(hybrid 推理模型):judge 的 achat 应注入 extra_body 关思维链,避免超时降级。
    monkeypatch.setenv("AMPHI_POLICY_FILE", str(tmp_path / "none.json"))
    captured: dict = {}

    class _GlmLlm:
        protocol = "openai"
        configuration = type("C", (), {"model": "glm-4.6"})()
        api_base = "https://open.bigmodel.cn/api/paas/v4"

        async def achat(self, messages, **kwargs):
            captured.update(kwargs)
            return '[{"index":0,"verdict":"allow","rule":"","reason":"ok"}]'

    out = await LlmSafetyClassifier(_GlmLlm()).judge([_item()], ["req"], ["/workspace"])
    assert out[0].verdict == "allow"
    assert captured.get("extra_body") == {"thinking": {"type": "disabled"}}


async def test_judge_selfheal_strips_reasoning_when_rejected(monkeypatch, tmp_path) -> None:
    # 强制推理模型:带 reasoning 参数第一次被拒 → 剥参重试成功(自愈,非 fail-closed),无需硬编码名单。
    monkeypatch.setenv("AMPHI_POLICY_FILE", str(tmp_path / "none.json"))
    calls: list = []

    class _RejectsReasoning:
        protocol = "openai"
        configuration = type("C", (), {"model": "openai/gpt-oss-120b"})()
        api_base = "https://openrouter.ai/api/v1"

        async def achat(self, messages, **kwargs):
            calls.append(kwargs)
            if kwargs:  # 带 reasoning 参数 → 模拟 400 "Reasoning is mandatory"
                raise RuntimeError("400 Reasoning is mandatory ... cannot be disabled")
            return '[{"index":0,"verdict":"allow","rule":"","reason":"ok"}]'

    out = await LlmSafetyClassifier(_RejectsReasoning()).judge([_item()], ["req"], ["/workspace"])
    assert out[0].verdict == "allow"  # 自愈重试成功
    assert len(calls) == 2 and calls[0] != {} and calls[1] == {}  # 先带参数、再剥掉


async def test_judge_selfheal_both_fail_closes(monkeypatch, tmp_path) -> None:
    # 两次都失败(如 402 / 网络)→ 仍 fail-closed 到 ask,自愈不吞真失败。
    monkeypatch.setenv("AMPHI_POLICY_FILE", str(tmp_path / "none.json"))

    class _AlwaysFails:
        protocol = "openai"
        configuration = type("C", (), {"model": "qwen/qwen3-coder"})()
        api_base = "https://openrouter.ai/api/v1"

        async def achat(self, messages, **kwargs):
            raise RuntimeError("402 insufficient credits")

    out = await LlmSafetyClassifier(_AlwaysFails()).judge([_item()], ["req"], ["/workspace"])
    assert out[0].verdict == "ask"


def test_system_prompt_requests_brevity() -> None:
    # prompt 层从简引导(对 hybrid / 弱推理有边际帮助,无害补充)。
    assert "no need to unfold" in _build_system_prompt(DEFAULT_POLICY)


# ---------------------------------------------------------------------------
# 上下文补齐:目标是否已存在 / 用户点名路径 / 挂载去重 / 批量语义
# ---------------------------------------------------------------------------
async def test_classify_item_carries_target_exists() -> None:
    """写类调用带上"目标此刻在不在",分类器不必再猜"可能覆盖既存文件"。

    目标须落在**工作区外**才会进分类器(工作区 / 临时目录内的写在规则层就放行了),
    故拿本测试文件所在目录当锚点 —— 只 stat、不写盘。
    """
    captured: dict = {}

    class _Capture:
        async def judge(self, items, user_messages, roots, agent_reasoning="", session_approvals=None, named_paths=None):
            captured["items"] = items
            return [ClassifyVerdict(verdict="allow") for _ in items]

    here = Path(__file__).resolve()
    existing = here                          # 本文件,必然存在
    fresh = here.parent / "no" / "such.tsx"  # 新目录下的新文件

    engine = PermissionEngine("/workspace", [], ExecutionMode.AUTO, classifier=_Capture())
    await engine.evaluate([
        StepToolCall(tool="write_file", tool_arguments=[
            ToolArgument(name="file_path", value=str(fresh)),
            ToolArgument(name="content", value="hi"),
        ]),
        StepToolCall(tool="write_file", tool_arguments=[
            ToolArgument(name="file_path", value=str(existing)),
            ToolArgument(name="content", value="hi"),
        ]),
    ])
    assert captured["items"][0].target_exists is False  # 新建
    assert captured["items"][1].target_exists is True   # 覆盖既存


def test_prompt_shows_target_exists_only_when_known() -> None:
    known = ClassifyItem(
        tool="write_file", arguments={"file_path": "/repo/new.tsx"},
        capability="edit", boundary="out_of_bounds", label="", target_exists=False,
    )
    unknown = ClassifyItem(
        tool="bash", arguments={"command": "ls"},
        capability="execute", boundary="none", label="",
    )
    assert "target file exists" in _build_user_prompt([known], [], ["/ws"])
    assert "target file exists" not in _build_user_prompt([unknown], [], ["/ws"])


def test_prompt_carries_named_paths_section() -> None:
    text = _build_user_prompt(
        [ClassifyItem(tool="bash", arguments={}, capability="execute", boundary="none", label="")],
        ["继续"], ["/ws"], named_paths=["/Users/me/repo"],
    )
    assert "/Users/me/repo" in text and "named in this session" in text


def test_prompt_dedups_workspace_out_of_mounts() -> None:
    # 运行时会把工作区自己也塞进 mount_roots;渲染时不该显示成"用户主动挂载"。
    text = _build_user_prompt(
        [ClassifyItem(tool="bash", arguments={}, capability="execute", boundary="none", label="")],
        [], ["/ws", "/ws"],
    )
    assert "User mounts: (none)" in text


def test_prompt_marks_batch_as_one_task() -> None:
    items = [
        ClassifyItem(tool="bash", arguments={"command": c}, capability="execute", boundary="none", label="")
        for c in ("a", "b")
    ]
    assert "consecutive steps" in _build_user_prompt(items, [], ["/ws"])
    assert "consecutive steps" not in _build_user_prompt(items[:1], [], ["/ws"])


def test_system_prompt_defines_same_kind_and_target_exists() -> None:
    text = _build_system_prompt(DEFAULT_POLICY)
    assert "same kind" in text and "target file exists" in text
