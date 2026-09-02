/** Shared contract for the Excel ribbon and the sheet chrome rendered by Univer. */
export const EXCEL_SHEETS_UI_CONFIG = {
  header: false,
  toolbar: false,
  formulaBar: false,
  footer: { sheetBar: true, statisticBar: true, zoomSlider: true },
} as const

export const EXCEL_OPEN_SOURCE_FEATURES = [
  'filter',
  'sort',
  'conditional-formatting',
  'data-validation',
  'drawing',
  'hyperlink',
] as const

export type ExcelOpenSourceFeature = typeof EXCEL_OPEN_SOURCE_FEATURES[number]
