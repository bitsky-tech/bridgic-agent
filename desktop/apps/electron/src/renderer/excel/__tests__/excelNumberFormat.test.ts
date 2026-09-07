import { describe, expect, it } from 'bun:test'
import { adjustDecimalPlaces } from '../excelNumberFormat'

describe('Excel number format helpers', () => {
  it('adds and removes decimal places without dropping format suffixes', () => {
    expect(adjustDecimalPlaces('General', 1)).toBe('0.0')
    expect(adjustDecimalPlaces('#,##0', 1)).toBe('#,##0.0')
    expect(adjustDecimalPlaces('0.00%', 1)).toBe('0.000%')
    expect(adjustDecimalPlaces('$#,##0.00', -1)).toBe('$#,##0.0')
    expect(adjustDecimalPlaces('0.0%', -1)).toBe('0%')
  })
})
