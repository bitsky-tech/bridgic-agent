"""产品身份的前后端契约:展示名与 deep-link scheme。

后端的 Codex OAuth 成功页要显示产品名、并给出 ``<scheme>://oauth/callback`` 按钮,
于是把两个值**镜像**在了 ``_codex_oauth.py``。镜像一旦与前端漂移,失败是静默的:

* 展示名漂移 → 用户配模型时看到旧品牌名,而应用里已是新名;
* scheme 漂移 → OS 按 Info.plist / NSIS 注册的是前端那个,后端发的按钮是另一个,
  点了没反应、token 永远拿不回来。**macOS 上测不出来**(``open-url`` 分支不校验
  scheme),只有 Windows / Linux 的 argv 前缀匹配会失败 —— 恰是本项目零真机验证的一侧。

``desktop/scripts/check-naming.sh`` 拦不住这两处:它 ``cd`` 到 ``desktop/`` 后才
``git ls-files``,整个 Python 侧不在扫描范围内。故在此按 ``test_permission_contract``
同款做法,直接从 ``app-meta.ts`` 抽取真值比对 —— 改一边不改另一边,CI 立刻红。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from src.amphi_service.protocol.llms._codex_oauth import APP_PRODUCT_NAME, APP_SCHEME

_APP_META = (
    Path(__file__).resolve().parents[1]
    / "desktop/apps/electron/src/shared/app-meta.ts"
)


def _ts_const(name: str) -> str:
    """从 app-meta.ts 抽一个字符串常量的值;抽不到就让测试失败并说清原因。"""
    source = _APP_META.read_text(encoding="utf-8")
    match = re.search(rf"^export const {name} = '([^']+)'", source, re.MULTILINE)
    if match is None:
        pytest.fail(f"{_APP_META.name} 里找不到 {name} —— 常量被改名或删除了?")
    return match.group(1)


def test_product_name_matches_frontend() -> None:
    assert APP_PRODUCT_NAME == _ts_const("APP_PRODUCT_NAME"), (
        "OAuth 成功页的品牌名与前端不一致 —— 用户配模型时会看到旧名。"
        "同步改 src/amphi_service/protocol/llms/_codex_oauth.py::APP_PRODUCT_NAME"
    )


def test_deeplink_scheme_matches_frontend() -> None:
    assert APP_SCHEME == _ts_const("APP_DEEPLINK_SCHEME"), (
        "OAuth 回调 scheme 与前端不一致 —— 深链会被静默丢弃(Windows / Linux 上)。"
        "同步改 src/amphi_service/protocol/llms/_codex_oauth.py::APP_SCHEME"
    )


def test_frontend_scheme_matches_packaging() -> None:
    """再钉一环:``app-meta`` 的 scheme 必须等于 electron-builder 注册进 OS 的那个。

    前后端一致但两者都跟打包配置不符,同样是深链失效 —— 只是失败点从"发错 URL"
    变成"OS 根本没把这个 scheme 交给我们"。
    """
    builder = (
        _APP_META.parents[2] / "electron-builder.yml"
    ).read_text(encoding="utf-8")
    registered = re.search(r"schemes:\s*\n\s*-\s*(\S+)", builder)
    assert registered is not None, "electron-builder.yml 里找不到 protocols.schemes"
    assert registered.group(1) == _ts_const("APP_DEEPLINK_SCHEME")


def test_system_app_id_matches_packaging() -> None:
    """The runtime OS identity and electron-builder appId must not drift."""
    builder = (
        _APP_META.parents[2] / "electron-builder.yml"
    ).read_text(encoding="utf-8")
    declared = re.search(r"(?m)^appId:\s*(.+?)\s*$", builder)
    assert declared is not None, "electron-builder.yml is missing appId"
    assert declared.group(1) == _ts_const("APP_BUNDLE_ID"), (
        "Electron runtime AppUserModelID / macOS bundle ID differs from "
        "electron-builder appId"
    )


def test_packaged_windows_runtime_applies_system_app_id() -> None:
    """The packaged process must use the same AppUserModelID as its shortcuts."""
    main_dir = _APP_META.parent.parent / "main"
    identity = (main_dir / "app-identity.ts").read_text(encoding="utf-8")
    entrypoint = (main_dir / "index.ts").read_text(encoding="utf-8")
    assert "setAppUserModelId(APP_BUNDLE_ID)" in identity
    assert "applyApplicationIdentity(app," in entrypoint


def test_product_name_matches_packaging() -> None:
    """``productName`` 是**四个文件的字面量所依赖的那个值**,必须钉死。

    它决定 macOS 的 ``/Applications/<name>.app``、Windows 的 ``$INSTDIR\\<name>.exe``
    与安装目录、Linux 的 ``/opt/<name>``。而这三处在 shell / NSIS 里都只能写死字面量
    (它们 import 不了 TS):``build/pkg-scripts/{pre,post}install``、
    ``build/installer.nsh``、``build/deb-scripts/postinst``。

    只改 electron-builder.yml 不改 app-meta.ts,静默后果是:pkg 脚本找不到 app
    bundle 于是跳过 daemon 停止和 ``/usr/local/bin/amphi`` 软链;NSIS 把开机自启
    指向一个不存在的 exe;deb 从一个不存在的目录建软链。全都不报错。
    """
    expected = _ts_const("APP_PRODUCT_NAME")
    electron_dir = _APP_META.parents[2]

    builder = (electron_dir / "electron-builder.yml").read_text(encoding="utf-8")
    declared = re.search(r"(?m)^productName:\s*(.+?)\s*$", builder)
    assert declared is not None, "electron-builder.yml 里找不到 productName"
    assert declared.group(1) == expected, (
        "打包用的 productName 与 app-meta.ts 不一致 —— 安装脚本里那些写死的路径"
        "会指向不存在的位置,且不会报错。"
    )

    # 光比对 app-meta ↔ electron-builder 是不够的:那两个是改名时"显然要一起改"的
    # 一对,CI 也会逼着改。真正会被落下的是下面这些**只能写字面量**的安装脚本 ——
    # 它们 import 不了 TS,漏改后同样一声不吭。所以逐个文件回查那个值确实出现。
    literal_carriers = {
        # 这两个脚本用 `APP_PRODUCT_NAME` 拼出 /Applications/<name>.app
        "build/pkg-scripts/preinstall": f'APP_PRODUCT_NAME="{expected}"',
        "build/pkg-scripts/postinstall": f'APP_PRODUCT_NAME="{expected}"',
        # NSIS 写进 HKCU Run 的开机自启命令,直接拼 exe 名
        "build/installer.nsh": f"$INSTDIR\\{expected}.exe",
        # deb 解包目录 /opt/<productFilename>
        "build/deb-scripts/postinst": f'APP_BUNDLE_DIR="/opt/{expected}"',
    }
    for rel, must_contain in literal_carriers.items():
        text = (electron_dir / rel).read_text(encoding="utf-8")
        assert must_contain in text, (
            f"{rel} 里找不到 {must_contain} —— productName 改了但这个安装脚本没跟上。"
            "它拼出来的路径会指向不存在的位置,安装/卸载会静默跳过对应步骤。"
        )


def test_agent_name_matches_frontend() -> None:
    """Agent 的自称是产品发出的最显眼的一句话,不能漏掉。

    ``AGENT_NAME`` 被插进每一个根 system prompt(``You are {AGENT_NAME}, …``)。
    没有这条断言的话,下次改名会因为 CI 强制而更新 app-meta 与 _codex_oauth,
    却让 agent 继续用旧品牌名向每个用户自我介绍。
    """
    from src.amphi_agent import AGENT_NAME

    assert AGENT_NAME == _ts_const("APP_PRODUCT_NAME"), (
        "Agent 自称与产品展示名不一致 —— 对话里它会报出旧品牌名。"
        "同步改 src/amphi_agent/_prompt.py::AGENT_NAME"
    )
