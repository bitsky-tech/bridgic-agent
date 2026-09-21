import { describe, expect, it } from 'bun:test'
import { createPresentationTableElement } from '../presentationInsert'
import { presentationTableCellsPatch } from '../presentationTable'
import { createBlankPresentationProject } from '@/atoms/presentation'
import { editPresentationPage } from '@/presentation/agentCommands'

describe('presentation table cell editing', () => {
  it('keeps formatting on unchanged cells and clears stale run ranges on edited text', () => {
    const table = createPresentationTableElement([['Original', 'Keep']])
    table.cellStyles = [[
      { fill: '#FF0000', textRuns: [{ start: 0, end: 8, style: { color: '#FFFFFF' } }] },
      { fill: '#00FF00', textRuns: [{ start: 0, end: 4, style: { color: '#000000' } }] },
    ]]
    const patch = presentationTableCellsPatch(table, [['Changed', 'Keep']])
    expect(patch.cells).toEqual([['Changed', 'Keep']])
    expect(patch.cellStyles?.[0]?.[0]).toEqual({ fill: '#FF0000' })
    expect(patch.cellStyles?.[0]?.[1]).toEqual(table.cellStyles[0]![1]!)
    expect(table.cellStyles[0]![0]!.textRuns).toHaveLength(1)
  })

  it('lets Agent patches edit the table grid without retaining invalid text runs', () => {
    const project = createBlankPresentationProject('Agent table')
    const table = createPresentationTableElement([['Original']])
    table.cellStyles = [[{ textRuns: [{ start: 0, end: 8, style: { color: '#FF0000' } }] }]]
    project.slides.pages[0]!.elements = [table]
    const updated = editPresentationPage(project, project.slides.pages[0]!.id, [{
      type: 'patch', id: table.id, element_type: 'table', patch: { cells: [['New']], columnWidths: [1] },
    }]).project.slides.pages[0]!.elements[0]
    if (updated?.type !== 'table') throw new Error('Missing edited table')
    expect(updated.cells).toEqual([['New']])
    expect(updated.cellStyles?.[0]?.[0]?.textRuns).toBeUndefined()
    expect(updated.columnWidths).toEqual([1])
  })
})
