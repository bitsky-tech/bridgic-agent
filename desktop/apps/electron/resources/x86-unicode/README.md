# NSIS 第三方插件（Windows 打包用）

`build/installer.nsh` 用 `EnVar::AddValue` / `EnVar::DeleteValue` 注入和摘除
用户 PATH。**electron-builder 自带的 NSIS 插件集不含 EnVar**（已核对
`nsis-3.0.4.1` + `nsis-resources-3.4.1` 两个资源包的完整清单：只有 INetC /
StdUtils / UAC / WinShell / nsProcess / nsis7z / nsisunz / EmbedHTML /
SpiderBanner），缺了它 `makensis` 会以 `Invalid command: EnVar::SetHKCU`
中止——electron-builder 传 `-WX`（warnings as errors），没有放行余地。

## 为什么是这个目录

electron-builder 会把 `<buildResources>/x86-unicode`（存在的话）自动加为
`addplugindir`，所以 `installer.nsh` 里**不需要**写 `!addplugindir`。

本项目 `electron-builder.yml` 设了 `directories.buildResources: resources`
（不是默认的 `build`），因此落点是 `apps/electron/resources/x86-unicode/`。
放到 `build/x86-unicode/` **不生效**。

## 为什么是 x86 而不是 amd64

electron-builder 的 plugin arch 恒为 `x86-unicode` / `x86-ansi`，与
`win.target.arch: [x64]` 无关——NSIS 编译器本身是 32 位。用 amd64 版会加载失败。

## 来源与校验

| | |
|---|---|
| 上游 | https://nsis.sourceforge.io/EnVar_plug-in |
| 包 | `EnVar_plugin.zip`，38721 bytes，sha256 `e9aa92de351345ed82795251d838f1ae9041ba35af9d381a5780c7843b01f56a` |
| 取出 | `Plugins/x86-unicode/EnVar.dll`，11264 bytes，sha256 `dbb0040cd73c83aac965319eaafe81a962154668eb2e7773d79a6a8040b446b0` |
| 许可 | zlib（见 `EnVar-LICENSE.txt`）——允许商用与再分发，保留声明即可 |

升级时重新走一遍上表并更新校验和。

## 不会进入产物

`electron-builder.yml` 的 `files` 只收 `dist/**`，`extraResources` 只收
`resources/bin`——本目录仅在构建期被 makensis 使用，不会打进安装包。
