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
import { BorderStyleTypes, LocaleType, LogLevel, Univer, mergeLocales } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting'
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation'
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter'
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace'
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link'
import { UniverSheetsNotePreset } from '@univerjs/preset-sheets-note'
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort'
import { UniverSheetsThreadCommentPreset } from '@univerjs/preset-sheets-thread-comment'
import sheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US'
import sheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import conditionalFormattingEnUS from '@univerjs/preset-sheets-conditional-formatting/locales/en-US'
import conditionalFormattingZhCN from '@univerjs/preset-sheets-conditional-formatting/locales/zh-CN'
import dataValidationEnUS from '@univerjs/preset-sheets-data-validation/locales/en-US'
import dataValidationZhCN from '@univerjs/preset-sheets-data-validation/locales/zh-CN'
import filterEnUS from '@univerjs/preset-sheets-filter/locales/en-US'
import filterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN'
import findReplaceEnUS from '@univerjs/preset-sheets-find-replace/locales/en-US'
import findReplaceZhCN from '@univerjs/preset-sheets-find-replace/locales/zh-CN'
import hyperLinkEnUS from '@univerjs/preset-sheets-hyper-link/locales/en-US'
import hyperLinkZhCN from '@univerjs/preset-sheets-hyper-link/locales/zh-CN'
import noteEnUS from '@univerjs/preset-sheets-note/locales/en-US'
import noteZhCN from '@univerjs/preset-sheets-note/locales/zh-CN'
import sortEnUS from '@univerjs/preset-sheets-sort/locales/en-US'
import sortZhCN from '@univerjs/preset-sheets-sort/locales/zh-CN'
import threadCommentEnUS from '@univerjs/preset-sheets-thread-comment/locales/en-US'
import threadCommentZhCN from '@univerjs/preset-sheets-thread-comment/locales/zh-CN'
import { SheetBridge } from './bridge'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css'
import '@univerjs/preset-sheets-data-validation/lib/index.css'
import '@univerjs/preset-sheets-filter/lib/index.css'
import '@univerjs/preset-sheets-find-replace/lib/index.css'
import '@univerjs/preset-sheets-hyper-link/lib/index.css'
import '@univerjs/preset-sheets-note/lib/index.css'
import '@univerjs/preset-sheets-sort/lib/index.css'
import '@univerjs/preset-sheets-thread-comment/lib/index.css'

const params = new URLSearchParams(window.location.search)
const useChinese = (params.get('lang') ?? 'en').toLowerCase().startsWith('zh')
const locale = useChinese ? LocaleType.ZH_CN : LocaleType.EN_US
// Every one of these is Apache-2.0 with no @univerjs-pro dependency; the two
// presets that would pull in commercial packages (advanced and collaboration)
// are deliberately absent.
const presets = [
  UniverSheetsCorePreset({ container: 'univer' }),
  UniverSheetsSortPreset(),
  UniverSheetsFilterPreset(),
  UniverSheetsFindReplacePreset(),
  UniverSheetsDataValidationPreset(),
  UniverSheetsConditionalFormattingPreset(),
  UniverSheetsHyperLinkPreset(),
  UniverSheetsNotePreset(),
  UniverSheetsThreadCommentPreset(),
]

const univer = new Univer({
  darkMode: params.get('theme') === 'dark',
  locale,
  // Presets do not contribute their own locale bundles to the instance, so the
  // page merges them; a missing one shows raw message keys in the UI.
  locales: {
    [LocaleType.EN_US]: mergeLocales(
      sheetsCoreEnUS,
      sortEnUS,
      filterEnUS,
      findReplaceEnUS,
      dataValidationEnUS,
      conditionalFormattingEnUS,
      hyperLinkEnUS,
      noteEnUS,
      threadCommentEnUS,
    ),
    [LocaleType.ZH_CN]: mergeLocales(
      sheetsCoreZhCN,
      sortZhCN,
      filterZhCN,
      findReplaceZhCN,
      dataValidationZhCN,
      conditionalFormattingZhCN,
      hyperLinkZhCN,
      noteZhCN,
      threadCommentZhCN,
    ),
  },
  logLevel: LogLevel.WARN,
})
// Presets share plugins, so register each plugin name once. A later preset
// replacing an earlier one's plugin is the upstream behaviour; registering the
// same plugin twice is an error.
const plugins = new Map<string, Parameters<typeof univer.registerPlugin>>()
for (const preset of presets) {
  for (const entry of preset.plugins) {
    const [plugin, options] = Array.isArray(entry) ? entry : [entry, undefined]
    plugins.set(plugin.pluginName, [plugin, options])
  }
}
for (const [plugin, options] of plugins.values()) univer.registerPlugin(plugin, options)

const univerAPI = FUniver.newAPI(univer)
univerAPI.createWorkbook({ name: params.get('name') || 'Untitled' })

// The bridge takes these values rather than hard-coding numbers, because border
// style is the one numeric enum on this facade and upstream may renumber it.
const bridge = new SheetBridge(univerAPI, {
  dashed: BorderStyleTypes.DASHED,
  dotted: BorderStyleTypes.DOTTED,
  double: BorderStyleTypes.DOUBLE,
  medium: BorderStyleTypes.MEDIUM,
  none: BorderStyleTypes.NONE,
  thick: BorderStyleTypes.THICK,
  thin: BorderStyleTypes.THIN,
})

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
