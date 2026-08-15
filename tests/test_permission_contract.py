"""权限判据的前后端契约:枚举取值 + 审批卡 item 字段。

前端把 ``capability`` / ``boundary`` 当裸字符串比较(`permissions/icons.tsx` 的
``KNOWN_CAPABILITIES`` / ``TRUSTED_BOUNDARIES``),跨语言没有编译期检查 —— 后端加一个
新枚举值,前端 typecheck 照过、然后静默走兜底分支。历史上兜底方向是**放松**(未知能力
判 low、被算进"全部允许"),所以这里用冻结断言把它钉住:改后端枚举必须同步改前端。
"""

from __future__ import annotations

from src.amphi_agent._state import CallVerdict
from src.amphi_agent.security._types import Boundary, Capability

# 与 desktop/apps/electron/src/renderer/components/permissions/icons.tsx 手工同步。
_FRONTEND_KNOWN_CAPABILITIES = {
    "read", "edit", "network", "execute", "mcp", "manage", "manage_write", "control",
}
_FRONTEND_KNOWN_BOUNDARIES = {
    "in_workspace", "in_temp", "in_mount", "in_app_home", "in_app_builtin",
    "out_of_bounds", "none",
}
# 前端 ``TRUSTED_BOUNDARIES`` 的应有取值 —— 它决定"删非可再生文件算不算 high"。
# ``in_app_builtin`` 刻意**不在**其中:删产品自带的技能文件不可恢复,该判 high。
_FRONTEND_TRUSTED_BOUNDARIES = {"in_workspace", "in_temp", "in_mount", "in_app_home"}
# 审批卡定风险等级所依赖的客观判据 flag。少传任一个,前端只能退回猜。
_RISK_FLAGS = {
    "sensitive", "deletion", "regenerable", "uncertain_destruction", "touches_risk_surface",
}


def test_capability_enum_matches_frontend() -> None:
    assert {c.value for c in Capability} == _FRONTEND_KNOWN_CAPABILITIES, (
        "Capability 变了 —— 同步改 permissions/icons.tsx 的 KNOWN_CAPABILITIES,"
        "否则新能力会走前端兜底分支被判低风险并计入「全部允许」"
    )


def test_boundary_enum_matches_frontend() -> None:
    assert {b.value for b in Boundary} == _FRONTEND_KNOWN_BOUNDARIES, (
        "Boundary 变了 —— 同步改 permissions/icons.tsx 的 TRUSTED_BOUNDARIES"
    )


def test_trusted_boundaries_exclude_builtin_skills() -> None:
    """受信边界 ≠ 全部非越界边界。前端拿 ``TRUSTED_BOUNDARIES`` 判"删非可再生文件是否
    算 high",而内置技能目录虽然对读 / 执行可信,删掉它却无 checkpoint 可回滚 —— 一旦
    有人图省事把新边界一起塞进受信集合,删产品文件会静默降为 low 并计入「全部允许」。"""
    assert _FRONTEND_TRUSTED_BOUNDARIES < _FRONTEND_KNOWN_BOUNDARIES
    assert Boundary.IN_APP_BUILTIN.value not in _FRONTEND_TRUSTED_BOUNDARIES


def test_call_verdict_carries_risk_flags() -> None:
    # 这些 flag 是前端定风险等级的唯一客观依据(不能去解析 reason —— 那是 LLM 自由文本)。
    fields = set(CallVerdict.model_fields)
    assert _RISK_FLAGS <= fields, f"CallVerdict 缺判据 flag: {_RISK_FLAGS - fields}"
    assert {"capability", "boundary", "reason"} <= fields


def test_risk_flags_default_false_for_legacy_rows() -> None:
    # 旧持久化行没有这些字段,必须能原样加载(缺省 False → 前端按"不可评估"保守处理)。
    v = CallVerdict(tool="bash", verdict="ask")
    assert all(getattr(v, f) is False for f in _RISK_FLAGS)
