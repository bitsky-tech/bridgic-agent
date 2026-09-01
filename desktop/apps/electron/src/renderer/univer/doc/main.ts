/**
 * Boots the embedded Univer document served to the Session dock.
 *
 * The sibling of `../sheet/main.ts`, and standalone for the same reasons: the
 * page is displayed through the existing embedded browser, so the agent already
 * has a way to drive it and an editor crash cannot take the app's own window
 * down with it.
 *
 * Only Apache-2.0 Univer packages are used. `@univerjs/presets` is avoided
 * because it transitively depends on the commercial `@univerjs-pro/*` packages,
 * so the few lines of its `createUniver` helper are inlined below instead.
 */
import { LocaleType, LogLevel, Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverDocsCorePreset } from '@univerjs/preset-docs-core'
import docsCoreEnUS from '@univerjs/preset-docs-core/locales/en-US'
import docsCoreZhCN from '@univerjs/preset-docs-core/locales/zh-CN'
import { DocBridge } from './bridge'
import '@univerjs/preset-docs-core/lib/index.css'

const params = new URLSearchParams(window.location.search)
const useChinese = (params.get('lang') ?? 'en').toLowerCase().startsWith('zh')
const locale = useChinese ? LocaleType.ZH_CN : LocaleType.EN_US
const preset = UniverDocsCorePreset({ container: 'univer' })

const univer = new Univer({
  darkMode: params.get('theme') === 'dark',
  locale,
  locales: {
    [LocaleType.EN_US]: docsCoreEnUS,
    [LocaleType.ZH_CN]: docsCoreZhCN,
  },
  logLevel: LogLevel.WARN,
})
for (const entry of preset.plugins) {
  const [plugin, options] = Array.isArray(entry) ? entry : [entry, undefined]
  univer.registerPlugin(plugin, options)
}

const univerAPI = FUniver.newAPI(univer)
univerAPI.createUniverDoc({ title: params.get('name') || 'Untitled' })

window.__univerBridge = new DocBridge(univerAPI)
