"""发布版本的单一来源契约：后端 / 桌面 / app-meta 三方不得漂移。

桌面端打包时会生成一份 ``release-manifest.json``，声明「这个 GUI 需要哪个后端版本」；
GUI 启动时把它和实际接管到的 daemon 版本比对，不一致就**阻塞整个界面**，只给用户一个
「重启网关」的按钮。

于是版本源一旦分裂，失败模式极其难看：

* manifest 读的是 A，daemon 报的是 B → **每一个用户**都被挡在启动页外面；
* 而 CI 全绿 —— 单测不打包、不启动 daemon，谁也发现不了。

daemon 对外报的版本只有一个出处：``src/__init__.py::__version__``
（``src/amphi_service/_app.py`` 第 185/218 行用它填 ``/api/gateway/health``）。
所以这里把它钉成唯一真值，其余三处（pyproject、两个 package.json、app-meta.ts）
都必须跟随。做法与 ``tests/test_branding_contract.py`` 一致：直接从文件抽取字面量比对，
改一边不改另一边，CI 立刻红。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from src import __version__

ROOT = Path(__file__).resolve().parents[1]

_PACKAGE_JSONS = (
    "desktop/package.json",
    "desktop/apps/electron/package.json",
)


def test_pyproject_has_no_static_version() -> None:
    """pyproject 必须用 dynamic version 从 ``src/__init__.py`` 读。

    静态字面量是第二个版本源；它和 ``__version__`` 漂移时，构建产物的元数据与
    daemon 自报版本会不一致，而 manifest 生成器读的是后者。
    """
    raw = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert re.search(r"^version\s*=\s*\"", raw, re.MULTILINE) is None, (
        "pyproject.toml 仍有静态 version —— 应改为 `dynamic = [\"version\"]` 并配 "
        "[tool.hatch.version] path = \"src/__init__.py\""
    )
    assert re.search(r"^dynamic\s*=\s*\[[^\]]*\"version\"", raw, re.MULTILINE), (
        "pyproject.toml 缺少 `dynamic = [\"version\"]`"
    )
    assert 'path = "src/__init__.py"' in raw, (
        "pyproject.toml 缺少 [tool.hatch.version] path = \"src/__init__.py\""
    )


def test_version_is_dotted_numeric() -> None:
    """manifest 生成器只接受点分十进制；这里先在后端侧拦一道。"""
    assert re.fullmatch(r"\d+\.\d+\.\d+", __version__), (
        f"src/__init__.py::__version__ = {__version__!r} 不是 x.y.z 形式"
    )


@pytest.mark.parametrize("rel", _PACKAGE_JSONS)
def test_desktop_package_version_matches_backend(rel: str) -> None:
    """桌面端 package.json 的 version 是 manifest 的 desktopVersion 来源。

    manifest 生成器要求 desktopVersion == requiredBackendVersion，所以这里不一致
    会让 `bun run build` 直接失败 —— 但那是在打包机上才发现，太晚。
    """
    payload = json.loads((ROOT / rel).read_text(encoding="utf-8"))
    assert payload["version"] == __version__, (
        f"{rel} 的 version 与 src/__init__.py::__version__ 不一致"
    )


def test_app_meta_version_matches_backend() -> None:
    """app-meta.ts 的 APP_VERSION 是第三个副本（User-Agent、关于框都用它）。"""
    source = (
        ROOT / "desktop/apps/electron/src/shared/app-meta.ts"
    ).read_text(encoding="utf-8")
    match = re.search(r"^export const APP_VERSION = '([^']+)'", source, re.MULTILINE)
    if match is None:
        pytest.fail("app-meta.ts 里找不到 APP_VERSION —— 常量被改名或删除了?")
    assert match.group(1) == __version__, (
        "app-meta.ts::APP_VERSION 与 src/__init__.py::__version__ 不一致"
    )
