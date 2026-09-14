import { describe, expect, it } from 'bun:test'
import {
  EXCEL_OPEN_SOURCE_FEATURES,
  EXCEL_SHEETS_UI_CONFIG,
} from '../excelUiConfig'

describe('Excel sheet chrome', () => {
  it('leaves the category tabs and ribbon to the shared workbench abstraction', () => {
    expect(EXCEL_SHEETS_UI_CONFIG).toEqual({
      header: false,
      toolbar: false,
      formulaBar: false,
      footer: { sheetBar: true, statisticBar: true, zoomSlider: true },
    })
  })

  it('keeps the open-source feature modules explicit', () => {
    expect(EXCEL_OPEN_SOURCE_FEATURES).toEqual([
      'filter',
      'sort',
      'conditional-formatting',
      'data-validation',
      'drawing',
      'hyperlink',
    ])
  })
})
