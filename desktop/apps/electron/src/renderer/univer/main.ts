/**
 * Boots the embedded Univer workbook served to the Session dock.
 *
 * This page is deliberately standalone rather than part of the app renderer: it
 * is displayed through the existing embedded browser, which means the agent
 * already has a way to drive it (`evaluate_javascript` against
 * `window.__univerBridge`) and a spreadsheet engine crash cannot take the app's
 * own window down with it.
 *
 * Only Apache-2.0 Univer packages are used. `@univerjs/presets` is avoided on
 * purpose — it transitively depends on the commercial `@univerjs-pro/*`
 * packages, so the handful of lines `createUniver` would have provided are
 * inlined below instead.
 */
import { LocaleType, LogLevel, Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import sheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US'
import sheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import { SheetBridge } from './bridge'
import '@univerjs/preset-sheets-core/lib/index.css'

declare global {
  interface Window {
    /** The agent's entry point into this workbook; see `bridge.ts`. */
    __univerBridge?: SheetBridge
  }
}

const params = new URLSearchParams(window.location.search)
const useChinese = (params.get('lang') ?? 'en').toLowerCase().startsWith('zh')
const locale = useChinese ? LocaleType.ZH_CN : LocaleType.EN_US
const preset = UniverSheetsCorePreset({ container: 'univer' })

const univer = new Univer({
  darkMode: params.get('theme') === 'dark',
  locale,
  locales: {
    [LocaleType.EN_US]: sheetsCoreEnUS,
    [LocaleType.ZH_CN]: sheetsCoreZhCN,
  },
  logLevel: LogLevel.WARN,
})
for (const entry of preset.plugins) {
  const [plugin, options] = Array.isArray(entry) ? entry : [entry, undefined]
  univer.registerPlugin(plugin, options)
}

const univerAPI = FUniver.newAPI(univer)
univerAPI.createWorkbook({ name: params.get('name') || 'Untitled' })

const bridge = new SheetBridge(univerAPI)

// A person typing in a cell owns that edit; the bridge refuses agent writes
// until they commit it, which is what makes shared editing safe without any
// operational-transform machinery.
univerAPI.addEvent(univerAPI.Event.BeforeSheetEditStart, () => bridge.setHumanEditing(true))
univerAPI.addEvent(univerAPI.Event.SheetEditEnded, () => bridge.setHumanEditing(false))
univerAPI.addEvent(univerAPI.Event.SheetValueChanged, (event) => {
  for (const range of event.effectedRanges) {
    bridge.noteExternalChange(range.getA1Notation(true))
  }
})

window.__univerBridge = bridge
