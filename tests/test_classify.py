"""② 判据层单测:classify(call) -> Judgement(capability / boundary / sensitive /
hard_deny),跑一张覆盖矩阵。工作区 = ``/workspace``,单个挂载 = ``/data``。

只断言判据(是什么),不涉及最终动作(那由规则层 + 模式层决定,另有测试)。
"""

from __future__ import annotations

import os

import pytest
from bridgic.amphibious import StepToolCall, ToolArgument

from src.amphi_agent.security._classify import _is_sensitive, classify
from src.amphi_agent.security._types import Boundary, Capability, Judgement


def _call(tool: str, **args: str) -> StepToolCall:
    return StepToolCall(
        tool=tool,
        tool_arguments=[ToolArgument(name=name, value=value) for name, value in args.items()],
    )


def _j(tool: str, **args: str) -> Judgement:
    if tool == "bash":
        args.setdefault("cwd", "/workspace")
    return classify(_call(tool, **args), "/workspace", ["/data"])


# (label, judgement, expected (capability, boundary, sensitive, hard_deny))
_MATRIX = [
    # --- 文件工具:能力 + 边界 ---
    ("read in workspace", _j("read_file", file_path="/workspace/a"), (Capability.READ, Boundary.IN_WORKSPACE, False, False)),
    ("read in mount", _j("read_file", file_path="/data/a"), (Capability.READ, Boundary.IN_MOUNT, False, False)),
    ("read out of bounds", _j("read_file", file_path="/elsewhere/x/a"), (Capability.READ, Boundary.OUT_OF_BOUNDS, False, False)),
    ("read sensitive .ssh", _j("read_file", file_path="/home/u/.ssh/id_rsa"), (Capability.READ, Boundary.OUT_OF_BOUNDS, True, False)),
    ("edit relative in workspace", _j("edit_file", file_path="a.py", old_string="x", new_string="y"), (Capability.EDIT, Boundary.IN_WORKSPACE, False, False)),
    ("write out of bounds", _j("write_file", file_path="/elsewhere/x/a", content="x"), (Capability.EDIT, Boundary.OUT_OF_BOUNDS, False, False)),
    ("write sensitive .env", _j("write_file", file_path="/workspace/.env", content="x"), (Capability.EDIT, Boundary.IN_WORKSPACE, True, False)),
    ("glob in-roots path", _j("glob", pattern="*.py", path="src"), (Capability.READ, Boundary.IN_WORKSPACE, False, False)),

    # --- 网络 / MCP / 控制 / 管理 ---
    ("web_fetch network", _j("web_fetch", url="http://x", prompt="p"), (Capability.NETWORK, Boundary.NONE, False, False)),
    ("browser_open network", _j("browser_open", url="https://x"), (Capability.NETWORK, Boundary.NONE, False, False)),
    ("browser upload in workspace", _j("browser_upload_file", file_path="upload.txt"), (Capability.NETWORK, Boundary.IN_WORKSPACE, False, False)),
    ("browser restore out of bounds", _j("browser_restore_storage_state", filename="/elsewhere/state.json"), (Capability.NETWORK, Boundary.OUT_OF_BOUNDS, False, False)),
    ("browser output relative to workspace", _j("browser_save_pdf", filename="page.pdf"), (Capability.NETWORK, Boundary.IN_WORKSPACE, False, False)),
    ("mcp tool", _j("mcp__server__nav", x="1"), (Capability.MCP, Boundary.NONE, False, False)),
    ("switch control", _j("switch", stage="normal"), (Capability.CONTROL, Boundary.NONE, False, False)),
    ("request_human_choice control", _j("request_human_choice", x="1"), (Capability.CONTROL, Boundary.NONE, False, False)),
    ("workspace_checkpoint manage", _j("workspace_checkpoint", message="m"), (Capability.MANAGE, Boundary.NONE, False, False)),
    ("help read-only manage", _j("help"), (Capability.MANAGE, Boundary.NONE, False, False)),
    # 只读查询(get/list/read)= 内部资源只读 → MANAGE 恒放;应用内写(增删改、装/卸 skill)
    # → MANAGE_WRITE,由规则层按模式确定性处理(request 确认、auto/full 放行,动作断言见 test_mode_policy)。
    ("get_schedule read-only manage", _j("get_schedule", schedule_id="s"), (Capability.MANAGE, Boundary.NONE, False, False)),
    ("list_schedules read-only manage", _j("list_schedules"), (Capability.MANAGE, Boundary.NONE, False, False)),
    ("list_workflow_runs read-only manage", _j("list_workflow_runs"), (Capability.MANAGE, Boundary.NONE, False, False)),
    ("read_workflow_run read-only manage", _j("read_workflow_run", run_id="r"), (Capability.MANAGE, Boundary.NONE, False, False)),
    ("create_schedule app-internal write", _j("create_schedule", name="n", desc="d", cron="0 0 9 * * *"), (Capability.MANAGE_WRITE, Boundary.NONE, False, False)),
    ("update_schedule app-internal write", _j("update_schedule", schedule_id="s"), (Capability.MANAGE_WRITE, Boundary.NONE, False, False)),
    ("delete_schedule app-internal write", _j("delete_schedule", schedule_id="s"), (Capability.MANAGE_WRITE, Boundary.NONE, False, False)),
    ("remove_workflow app-internal write", _j("remove_workflow", workflow_id="w"), (Capability.MANAGE_WRITE, Boundary.NONE, False, False)),
    ("import_skills app-internal write", _j("import_skills", names="a"), (Capability.MANAGE_WRITE, Boundary.NONE, False, False)),
    ("uninstall_skill app-internal write", _j("uninstall_skill", name="a"), (Capability.MANAGE_WRITE, Boundary.NONE, False, False)),
    ("edit_workflow is control (sibling of run_workflow)", _j("edit_workflow", workflow_id="w"), (Capability.CONTROL, Boundary.NONE, False, False)),
    ("workspace_restore edits", _j("workspace_restore", checkpoint_id="a"), (Capability.EDIT, Boundary.NONE, False, False)),
    ("unknown tool -> execute", _j("frobnicate", x="1"), (Capability.EXECUTE, Boundary.NONE, False, False)),

    # --- bash:硬红线 ---
    ("fork bomb hard-deny", _j("bash", command=":(){ :|:& };:"), (Capability.EXECUTE, Boundary.NONE, False, True)),
    ("mkfs hard-deny", _j("bash", command="mkfs.ext4 /dev/sda"), (Capability.EXECUTE, Boundary.OUT_OF_BOUNDS, False, True)),
    ("dd to raw device hard-deny", _j("bash", command="dd if=x of=/dev/sda"), (Capability.EXECUTE, Boundary.OUT_OF_BOUNDS, False, True)),
    ("clobber system path hard-deny", _j("bash", command="echo x > /etc/y"), (Capability.EXECUTE, Boundary.OUT_OF_BOUNDS, False, True)),
    ("shutdown hard-deny", _j("bash", command="shutdown -h now"), (Capability.EXECUTE, Boundary.NONE, False, True)),

    # --- bash:危险执行(非硬红线)---
    ("rm -rf in ws is edit not hard", _j("bash", command="rm -rf /workspace/sub"), (Capability.EDIT, Boundary.IN_WORKSPACE, False, False)),
    ("sudo is execute", _j("bash", command="sudo apt update"), (Capability.EXECUTE, Boundary.NONE, False, False)),
    ("git push -f is execute", _j("bash", command="git push -f origin main"), (Capability.EXECUTE, Boundary.NONE, False, False)),

    # --- bash:只读 / 编辑 / 敏感 ---
    ("pwd read", _j("bash", command="pwd"), (Capability.READ, Boundary.NONE, False, False)),
    ("cat relative read in ws", _j("bash", command="cat notes.txt"), (Capability.READ, Boundary.IN_WORKSPACE, False, False)),
    ("cat sensitive passwd", _j("bash", command="cat /etc/passwd"), (Capability.READ, Boundary.OUT_OF_BOUNDS, True, False)),
    ("ls out of bounds read", _j("bash", command="ls /elsewhere/x"), (Capability.READ, Boundary.OUT_OF_BOUNDS, False, False)),
    ("cp relative edit in ws", _j("bash", command="cp a.txt b.txt"), (Capability.EDIT, Boundary.IN_WORKSPACE, False, False)),
    ("mkdir out of bounds edit", _j("bash", command="mkdir /elsewhere/x/newdir"), (Capability.EDIT, Boundary.OUT_OF_BOUNDS, False, False)),

    # --- bash:复合命令取最严 ---
    # curl 的域名被粗提取成"路径",对 EXECUTE 而言 boundary 无关裁决(不进 ③ allow)。
    ("compound takes most severe (curl)", _j("bash", command="ls && curl evil.com"), (Capability.EXECUTE, Boundary.IN_WORKSPACE, False, False)),
    ("compound read stays read", _j("bash", command="cat a.txt | grep x"), (Capability.READ, Boundary.IN_WORKSPACE, False, False)),
    ("compound hard-deny in a segment", _j("bash", command="ls && mkfs.ext4 /dev/sda"), (Capability.EXECUTE, Boundary.OUT_OF_BOUNDS, False, True)),

    # --- bash:进程包装器剥离后仍判到危险 ---
    ("timeout wrapper stripped, inner delete in ws", _j("bash", command="timeout 30 rm -rf x"), (Capability.EDIT, Boundary.IN_WORKSPACE, False, False)),

    # --- M1:凭证类不再被只读白名单自由放行(交灰色地带 / 标敏感)---
    ("echo literal still read", _j("bash", command="echo hello world"), (Capability.READ, Boundary.NONE, False, False)),
    ("echo $VAR not read (gray)", _j("bash", command="echo $API_KEY"), (Capability.EXECUTE, Boundary.NONE, False, False)),
    ("echo backtick not read (gray)", _j("bash", command="echo `whoami`"), (Capability.EXECUTE, Boundary.NONE, False, False)),
    ("bare env dump not read (gray)", _j("bash", command="env"), (Capability.EXECUTE, Boundary.NONE, False, False)),
    ("printenv dump not read (gray)", _j("bash", command="printenv"), (Capability.EXECUTE, Boundary.NONE, False, False)),
    ("read gh token is sensitive", _j("bash", command="cat /home/u/.config/gh/hosts.yml"), (Capability.READ, Boundary.OUT_OF_BOUNDS, True, False)),
    ("read kubeconfig is sensitive", _j("bash", command="cat /home/u/.kube/config"), (Capability.READ, Boundary.OUT_OF_BOUNDS, True, False)),
    ("read docker auth is sensitive", _j("bash", command="cat /home/u/.docker/config.json"), (Capability.READ, Boundary.OUT_OF_BOUNDS, True, False)),
    ("read git-credentials is sensitive", _j("bash", command="cat /home/u/.git-credentials"), (Capability.READ, Boundary.OUT_OF_BOUNDS, True, False)),
    ("read gcloud creds is sensitive", _j("bash", command="cat /home/u/.config/gcloud/access_tokens.db"), (Capability.READ, Boundary.OUT_OF_BOUNDS, True, False)),
    ("read pgpass is sensitive", _j("bash", command="cat /home/u/.pgpass"), (Capability.READ, Boundary.OUT_OF_BOUNDS, True, False)),
    ("read cookies db is sensitive", _j("bash", command="cat /home/u/Library/Cookies/x"), (Capability.READ, Boundary.OUT_OF_BOUNDS, True, False)),
    ("grep token in credfile is sensitive", _j("bash", command="grep TOKEN /home/u/.git-credentials"), (Capability.READ, Boundary.OUT_OF_BOUNDS, True, False)),
    ("printenv with arg not read (gray)", _j("bash", command="printenv API_KEY"), (Capability.EXECUTE, Boundary.NONE, False, False)),
    # 负例:守 SENSITIVE 正则别过宽(configmap 非 .kube/config)。
    ("kube configmap NOT sensitive", _j("bash", command="cat /proj/kube/configmap.yaml"), (Capability.READ, Boundary.OUT_OF_BOUNDS, False, False)),
]


@pytest.mark.parametrize("label, judgement, expected", _MATRIX, ids=[row[0] for row in _MATRIX])
def test_classify_matrix(label: str, judgement: Judgement, expected) -> None:
    cap, boundary, sensitive, hard = expected
    got = (judgement.capability, judgement.boundary, judgement.sensitive, judgement.hard_deny)
    assert got == expected, f"{label}: got {got}"


def test_label_is_populated() -> None:
    # label 是 id 而非译文:前端按 UI 语言渲染,分类器提示词侧走 label_text() 取英文。
    assert _j("bash", command="rm -rf x").label == "security.label.edit_file"
    assert _j("read_file", file_path="/home/u/.ssh/id_rsa").label == "security.label.sensitive_file_access"
    assert _j("bash", command="mkfs.ext4 /dev/sda").label == "security.label.system_dangerous_operation"


def test_readonly_command_with_write_redirect_is_edit() -> None:
    """READ_COMMANDS 是宽匹配(``cat\\s+.*``),``cat > /outside/f`` 会被判只读、经
    ③ 的 READ→ALLOW 终局放行 —— 明明在写文件。只读命令带写重定向须改判为写。"""
    assert _j("bash", command="cat > /data/f.txt").capability is Capability.EDIT
    assert _j("bash", command="ls -la > listing.txt").capability is Capability.EDIT
    assert _j("bash", command="cat a.txt").capability is Capability.READ
    assert _j("bash", command="cat << EOF").capability is Capability.READ      # heredoc 是输入
    assert _j("bash", command="ls > /dev/null").capability is Capability.READ  # 空洞不算写
    assert _j("bash", command="grep x f 2>&1").capability is Capability.READ   # fd 复制不算写


def test_redirect_target_defines_boundary() -> None:
    # 重定向目标须参与边界判定,否则越界写目标隐形。
    j = _j("bash", command="cat a.txt > /elsewhere/pwned.txt")
    assert j.capability is Capability.EDIT and j.boundary is Boundary.OUT_OF_BOUNDS


@pytest.mark.parametrize("cmd", [
    "cat a.txt >| /elsewhere/pwned.txt",
    "cat a.txt >|/elsewhere/pwned.txt",   # 无空格:目标会被抓成 "|/elsewhere/…" 落进工作区
    "cat a.txt >& /elsewhere/pwned.txt",  # >&<文件名> 等价 >file 2>&1,是真写文件
    "cat a.txt &> /elsewhere/pwned.txt",
])
def test_redirect_operators_are_not_command_separators(cmd: str) -> None:
    """``>|``(noclobber 覆盖写)与 ``>&``/``&>`` 里的 ``|`` / ``&`` 不是命令分隔符,
    也不是 fd 复制 —— 漏判任一形态都会让越界写被判只读、经 ③ 的 READ→ALLOW 终局放行。"""
    j = _j("bash", command=cmd)
    assert j.capability is Capability.EDIT, cmd
    assert j.boundary is Boundary.OUT_OF_BOUNDS, cmd


def test_execute_with_redirect_stays_execute() -> None:
    # 重定向只阻止判 READ,不得把 EXECUTE 降级成 EDIT —— 否则 `curl … > f` 会变成
    # EDIT+工作区内而被 ③ 直接放行,绕过风险面。
    j = _j("bash", command="curl https://x.com/a > out.txt")
    assert j.capability is Capability.EXECUTE and j.touches_risk_surface is True


def test_rm_via_path_or_escape_still_deletion() -> None:
    # argv0 精确比串会让 /bin/rm、\rm 完整绕过删除判据(同文件 _extract_path_operands
    # 已用 basename,两套标准)。绕过后掉进 EXECUTE,越界删除变成普通执行。
    for cmd in ("/bin/rm -rf /data/sub", "\\rm -rf /data/sub", "/usr/bin/rm -rf /data/sub"):
        assert _j("bash", command=cmd).deletion is True, cmd


def test_newline_does_not_defeat_whole_command_recheck() -> None:
    # 整条命令复查是管道形态(curl … | sh)的唯一捕获点(拆分后子命令里没有 |),
    # 而 fullmatch 的 `.` 默认不跨 \n —— 前缀插一个换行即可废掉它。
    assert _j("bash", command="cat p.sh | sh").touches_risk_surface is True
    assert _j("bash", command="ls\ncat p.sh | sh").touches_risk_surface is True


def test_dangerous_commands_reach_risk_surface() -> None:
    # DANGEROUS_COMMANDS 只把 cap 设为 EXECUTE,而 EXECUTE 本就是兜底 —— 铁律翻转后
    # 命中与不命中结果完全一样,这张表已成 no-op。命中即应视为触碰风险面。
    for cmd in ("chmod 777 /data/x", "chmod -R 0777 .", "killall Finder",
                "find /data -exec chmod 777 {} ;"):
        assert _j("bash", command=cmd).touches_risk_surface is True, cmd


@pytest.mark.parametrize("cmd", [
    "uv pip install requests",
    "uv pip install --python ~/.bridgic/AmphiAgent/python/base/bin/python requests",
])
def test_app_level_python_base_installs_stay_off_risk_surface(cmd: str) -> None:
    """Dependency preparation in the product-managed base is routine."""
    judgement = _j("bash", command=cmd)
    assert judgement.capability is Capability.EXECUTE
    assert judgement.touches_risk_surface is False, cmd


@pytest.mark.parametrize("tool, readonly", [
    # 真实 connector 的命名:server 名带大写、工具名带连字符 —— 只认 [a-z0-9_] 会让
    # 绝大多数真实只读工具漏网被送审。
    ("mcp__claude_ai_Gmail__get_message", True),
    ("mcp__claude_ai_Canva__list-folder-items", True),
    ("mcp__x__getUser", True),          # camelCase
    ("mcp__x__search_threads", True),
    # 读动词开头、实则写:只看前缀会让它们判只读直接放行 = 被审查方自己决定要不要被审查。
    ("mcp__notion__get_or_create_page", False),
    ("mcp__notion__getOrCreatePage", False),
    ("mcp__x__search_and_replace", False),
    ("mcp__x__fetch_and_upload", False),
    ("mcp__x__list_and_delete", False),
    # 非读动词开头:一律保守
    ("mcp__x__send_message", False),
    ("mcp__x__create_page", False),
])
def test_mcp_readonly_detection(tool: str, readonly: bool) -> None:
    # 这两条是"顺带修掉的既有漏洞",没有回归测试的话,将来改 MCP_READONLY_TOOLS
    # 正则时最容易静默退化。
    assert _j(tool).touches_risk_surface is (not readonly), tool


def test_unregistered_tool_is_sent_for_review() -> None:
    # 未登记的工具落 EXECUTE 兜底 —— 未知即送审,否则新增工具忘了登记 TOOL_CAPABILITY
    # 就自动获得 auto 下的完全放行(会随工具面扩张自然恶化)。
    for tool in ("brand_new_tool", "exec_python", "run_command"):
        assert _j(tool).touches_risk_surface is True, tool
    # 已登记的只读工具不受影响
    assert _j("read_file", file_path="/workspace/a").touches_risk_surface is False


@pytest.mark.parametrize(
    "tool",
    [
        "browser_upload_file",
        "browser_evaluate_javascript",
        "browser_get_cookies",
        "browser_get_network_requests",
        "browser_set_cookie",
        "browser_clear_cookies",
        "browser_save_storage_state",
        "browser_restore_storage_state",
    ],
)
def test_sensitive_browser_capabilities_reach_risk_surface(tool: str) -> None:
    assert _j(tool).touches_risk_surface is True


def test_home_expansion_matches_executor() -> None:
    """判据必须与执行器看到同一个路径:bash 走 create_subprocess_shell,shell 会展开
    ~ 与 $HOME。不展开则 `cp x ~/leak` 被解析成 <cwd>/~/leak 而误判在工作区内,
    执行器却真写进了家目录 —— 边界形同虚设。"""
    for cmd in ("cp secret.txt ~/leak.txt", "cp secret.txt $HOME/leak.txt"):
        assert _j("bash", command=cmd).boundary is not Boundary.IN_WORKSPACE, cmd


def test_unresolvable_variable_path_does_not_fake_workspace() -> None:
    # 含变量的路径静态解析不了 —— 不得伪造一个"在工作区内"的结论。
    assert _j("bash", command="cp $SRC $DST").boundary is not Boundary.IN_WORKSPACE


def test_git_global_options_still_readonly() -> None:
    # `git -C <path> status` 是只读;正则若要求子命令紧跟 git,全局选项插进来就脱靶,
    # 掉进 EXECUTE 后会被越界兜底误送审。
    for cmd in ("git -C /data/repo status", "git -C /data/repo log", "git --no-pager log"):
        assert _j("bash", command=cmd).capability is Capability.READ, cmd


def test_symlink_escape_detected(tmp_path) -> None:
    # 工作区内的软链接指向工作区外 → 判据须按真实指向,**不得**被当作工作区内。
    # (真实落点视 tmp_path 位置而定——pytest 基目录常在系统临时目录下,故可能判 IN_TEMP;
    # 这里只锁"没被伪装成 IN_WORKSPACE"这一逃逸检测不变式,不耦合具体落点。)
    outside = tmp_path / "outside"
    outside.mkdir()
    secret = outside / "secret.txt"
    secret.write_text("x")
    ws = tmp_path / "ws"
    ws.mkdir()
    link = ws / "link.txt"
    os.symlink(secret, link)
    j = classify(_call("read_file", file_path=str(link)), str(ws), [])
    assert j.boundary is not Boundary.IN_WORKSPACE


def test_bash_cwd_drives_relative_path_classification() -> None:
    build = classify(
        _call("bash", command="rm -rf workflow", cwd="/session/.work/.build"),
        "/session/.work",
    )
    assert build.cwd == "/session/.work/.build"
    assert build.boundary is Boundary.IN_WORKSPACE

    workflow = classify(
        _call("bash", command="cp input.txt output.txt", cwd="/runs/wfr_1/work"),
        "/session/.work",
        [],
        ["/runs/wfr_1/work"],
    )
    assert workflow.cwd == "/runs/wfr_1/work"
    assert workflow.boundary is Boundary.IN_WORKSPACE

    sensitive = classify(
        _call("bash", command="cat id_rsa", cwd="/Users/example/.ssh"),
        "/session/.work",
    )
    assert sensitive.boundary is Boundary.OUT_OF_BOUNDS
    assert sensitive.sensitive is True


def test_bash_missing_or_relative_cwd_is_not_inferred() -> None:
    for cwd in ("", ".build"):
        judgement = classify(
            _call("bash", command="rm -rf workflow", cwd=cwd),
            "/session/.work",
        )
        assert judgement.cwd is None
        assert judgement.uncertain_destruction is True


def _first_party_tool_names() -> set:
    """枚举 agent 自有工具面的全部 ``tool_name``(经 ``tools`` 包的 ``__all__``)。

    工具规格是 ``FunctionToolSpec``(name 在 ``tool_name``),既有单个 ``*_tool``
    也有 ``*_tool_specs`` 列表,统一递归收集,新增工具只要挂进 ``__all__`` 即自动纳入。
    """
    import src.amphi_agent.tools as tools_pkg

    names: set = set()

    def _collect(obj: object) -> None:
        tool_name = getattr(obj, "tool_name", None)
        if isinstance(tool_name, str):
            names.add(tool_name)
        elif isinstance(obj, (list, tuple, set)):
            for item in obj:
                _collect(item)

    for attr in getattr(tools_pkg, "__all__", []):
        _collect(getattr(tools_pkg, attr, None))
    return names


def _builtin_skill_script() -> str:
    """产品自带内置技能里的一个真实脚本路径(绝对,realpath)。"""
    from src.amphi_agent.security import _registry as reg

    return os.path.join(sorted(reg.APP_BUILTIN_ROOTS)[0], "how-to", "scripts", "sync_skills.py")


def test_builtin_skill_script_is_trusted_boundary() -> None:
    """跑内置技能自带的脚本 = 执行产品自己的代码,不是"工作区外的可疑脚本"。

    安装目录此前不在任何可信根里(工作区 / 挂载 / ~/.bridgic / 临时目录),于是
    ``python3 "<SKILL_DIR>/scripts/x.py"`` 判 OUT_OF_BOUNDS → 触碰风险面 → 送分类器
    → 被判"外部代码执行 / 自我修改"而弹卡。讽刺的是用户装的第三方技能反而不弹
    (它们在 ~/.bridgic/AmphiAgent/skills/catalog,属 IN_APP_HOME)。
    """
    script = _builtin_skill_script()
    j = _j("bash", command=f'python3 "{script}"')
    assert j.boundary is Boundary.IN_APP_BUILTIN
    assert j.touches_risk_surface is False


def test_builtin_skill_script_with_workspace_args_stays_trusted() -> None:
    # 真实形态:脚本在安装目录,参数指向工作区内 —— 两段都可信,整条不该升级。
    script = _builtin_skill_script()
    j = _j("bash", command=f'python3 "{script}" --skills \'[["a","b","cli","skills/a"]]\' --pretty')
    assert j.boundary is Boundary.IN_APP_BUILTIN


def test_builtin_root_does_not_launder_out_of_bounds_targets() -> None:
    # 多路径取最严:脚本可信不代表整条可信,重定向到系统路径仍须判越界。
    script = _builtin_skill_script()
    j = _j("bash", command=f'python3 "{script}" > /elsewhere/x/out.txt')
    assert j.boundary is Boundary.OUT_OF_BOUNDS


def test_every_first_party_tool_has_explicit_capability() -> None:
    """守卫:每个 first-party 工具都必须在 ``TOOL_CAPABILITY`` 显式登记。

    未登记 → 落 ``EXECUTE`` 灰色地带被过度拦截(schedule 写工具就这么踩过坑)。此测试
    把"忘记登记"从静默过度拦截变成 CI 失败。``bash`` 例外:它按命令内容判据,不按工具名。
    """
    from src.amphi_agent.security._classify import _tool_capability

    names = _first_party_tool_names()
    assert names, "工具面枚举返回空 —— 枚举逻辑或 __all__ 断了"
    unregistered = sorted(
        name
        for name in names
        if name != "bash" and _tool_capability(name) is Capability.EXECUTE
    )
    assert not unregistered, (
        "这些 first-party 工具落在 EXECUTE 灰色地带,请到 "
        f"security/_registry.py 的 TOOL_CAPABILITY 显式登记:{unregistered}"
    )


# ---------------------------------------------------------------------------
# heredoc 正文不是 shell 命令:不得从中提取"路径操作数"
#
# 实测(session_20260727_182036_f8a634ff:18:21:03):
#   python3 "<builtin>/sync_skills_index.py" && python3 - <<'PY' … PY
# 第一段判对了 in_app_builtin,却被第二段拉成 out_of_bounds → 白过一次分类器(6.7s)。
# 元凶是正文里 pathlib 的 `/` 运算符被当成路径操作数,裸 `/` 解析后 = 文件系统根。
# ---------------------------------------------------------------------------
_HEREDOC_PY = """python3 - <<'PY'
from pathlib import Path
root = Path.home() / '.bridgic' / 'AmphiAgent' / 'skills'
path = root / 'category_list.json'
PY"""


def test_heredoc_body_does_not_leak_path_operands() -> None:
    # pathlib 的 `/` 是运算符不是路径;正文里没有任何真实的越界目标。
    assert _j("bash", command=_HEREDOC_PY).boundary is not Boundary.OUT_OF_BOUNDS


def test_builtin_script_survives_heredoc_in_same_command() -> None:
    """线上原样命令:内置脚本 + agent 自拼的内联校验脚本,取最严后仍应是可信边界。"""
    script = _builtin_skill_script()
    j = _j("bash", command=f'python3 "{script}" && {_HEREDOC_PY}')
    assert j.boundary is Boundary.IN_APP_BUILTIN
    assert j.touches_risk_surface is False


def test_heredoc_body_still_screened_for_dangerous_commands() -> None:
    """**不能**因为跳过路径操作数就把正文整体豁免 —— 它仍要过命令识别。

    ``bash <<EOF … rm -rf / … EOF`` 是真会删根的,删除判据必须照样命中硬红线。
    """
    cmd = "bash <<'EOF'\nrm -rf /\nEOF"
    assert _j("bash", command=cmd).hard_deny is True


def test_heredoc_redirect_target_outside_still_counted() -> None:
    # 写目标在 heredoc **之前**的命令部分,不受正文规则影响。
    cmd = "cat > /elsewhere/x/out.txt <<'EOF'\nhello\nEOF"
    assert _j("bash", command=cmd).boundary is Boundary.OUT_OF_BOUNDS


# ── Windows 路径分隔符 ───────────────────────────────────────────────────────
# SENSITIVE_PATHS 里的模式全是 `/` 形式,而 Windows 的 realpath 返回 `\`。修复前
# 下面每一条都返回 False —— 即 `.ssh` / 云凭证 / 浏览器密码库的读写在 Windows 上
# 完全不触发审批。用 _is_sensitive 直接测,不经 classify:边界判定依赖真实存在的
# 工作区路径,而这里要断言的只是「模式能否命中」。

_WINDOWS_SENSITIVE = [
    r"C:\Users\me\.ssh\id_rsa",
    r"C:\Users\me\.aws\credentials",
    r"C:\Users\me\.git-credentials",
    r"C:\Users\me\.kube\config",
    r"C:\Users\me\.docker\config.json",
    r"C:\Users\me\AppData\Roaming\Microsoft\Credentials\DFBE70A7E5CC19A3",
    r"C:\Users\me\AppData\Local\Google\Chrome\User Data\Default\Login Data",
    r"C:\Users\me\AppData\Roaming\Mozilla\Firefox\Profiles\x.default\logins.json",
]

_WINDOWS_ORDINARY = [
    r"C:\Users\me\projects\app\src\main.py",
    r"C:\Users\me\Downloads\readme.txt",
    r"C:\Users\me\.sshconfig-notes.md",
]


@pytest.mark.parametrize("path", _WINDOWS_SENSITIVE)
def test_windows_style_paths_are_flagged_sensitive(path: str) -> None:
    assert _is_sensitive(path) is True, f"未判定为敏感,Windows 上将不触发审批: {path}"


@pytest.mark.parametrize("path", _WINDOWS_ORDINARY)
def test_ordinary_windows_paths_stay_non_sensitive(path: str) -> None:
    assert _is_sensitive(path) is False, f"误判为敏感: {path}"


@pytest.mark.parametrize("path", ["/home/u/.ssh/id_rsa", "/home/u/.aws/credentials"])
def test_posix_paths_unaffected_by_separator_normalisation(path: str) -> None:
    assert _is_sensitive(path) is True


def test_windows_shell_classifies_common_powershell_commands(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The retained `bash` tool name uses PowerShell-aware permissions on Windows."""
    import src.amphi_agent.security._classify as classify_module

    monkeypatch.setattr(classify_module, "_IS_WINDOWS", True)

    # 本用例的 fixture 根必须是**当前平台**的绝对路径。Python 3.13 起
    # ntpath.isabs("/workspace") 为 False,在真 Windows 上跑时 classify 会把
    # cwd 判成未知(execution_cwd=None),所有 boundary 退化成 Boundary.NONE。
    ws_root = r"C:\workspace" if os.name == "nt" else "/workspace"
    mount_root = r"C:\data" if os.name == "nt" else "/data"

    def powershell(command: str) -> Judgement:
        return classify(
            _call("bash", command=command, cwd=ws_root),
            ws_root,
            [mount_root],
        )

    read = powershell("Get-Content notes.txt")
    assert read.capability is Capability.READ
    assert read.boundary is Boundary.IN_WORKSPACE

    edit = powershell("Set-Content -Path notes.txt -Value hello")
    assert edit.capability is Capability.EDIT
    assert edit.boundary is Boundary.IN_WORKSPACE

    deletion = powershell("Remove-Item -Recurse build")
    assert deletion.capability is Capability.EDIT
    assert deletion.deletion is True
    assert deletion.boundary is Boundary.IN_WORKSPACE

    dynamic_deletion = powershell(r"Remove-Item -Recurse $env:TEMP\amphi")
    assert dynamic_deletion.deletion is True
    assert dynamic_deletion.uncertain_destruction is True

    registry_deletion = powershell(r"Remove-Item HKCU:\Software\Amphi")
    assert registry_deletion.deletion is True
    assert registry_deletion.uncertain_destruction is True
    assert registry_deletion.boundary is Boundary.OUT_OF_BOUNDS

    compound = powershell("Get-ChildItem .; Remove-Item old.txt")
    assert compound.deletion is True
    assert compound.capability is Capability.EDIT

    hard_deny = powershell("Format-Volume -DriveLetter C")
    assert hard_deny.hard_deny is True

    risky = powershell("Invoke-WebRequest https://example.com")
    assert risky.touches_risk_surface is True

    reg_delete = powershell(r"reg.exe delete HKCU\Software\Amphi /f")
    assert reg_delete.touches_risk_surface is True

    unknown_cmdlet = powershell("Invoke-CustomAction value")
    assert unknown_cmdlet.capability is Capability.EXECUTE
    assert unknown_cmdlet.touches_risk_surface is True
