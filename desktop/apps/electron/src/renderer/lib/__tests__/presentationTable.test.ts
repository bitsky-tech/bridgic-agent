import { describe, expect, it } from 'bun:test'
import { createPresentationTableElement } from '../presentationInsert'
import { presentationTableCellAppearance, presentationTableCellsPatch } from '../presentationTable'
import { resizePresentationProject } from '../presentationDesign'
import { createBlankPresentationProject } from '@/atoms/presentation'
import { editPresentationPage } from '@/presentation/agentCommands'

describe('presentation table cell editing', () => {
  it('keeps a transparent legacy border invisible on every side', () => {
    const table = createPresentationTableElement([['Value']])
    table.borderColor = 'transparent'
    expect(presentationTableCellAppearance(table, 0, 0).borders).toEqual({
      top: { color: 'transparent', width: 0, type: 'none' },
      right: { color: 'transparent', width: 0, type: 'none' },
      bottom: { color: 'transparent', width: 0, type: 'none' },
      left: { color: 'transparent', width: 0, type: 'none' },
    })
  })

  it('keeps and scales an imported partial cell border when the page is resized', () => {
    const project = createBlankPresentationProject('Border scale')
    const table = createPresentationTableElement([['Value']])
    table.cellStyles = [[{ borders: { top: { color: '#FF0000', width: 4, type: 'solid' } } }]]
    project.slides.pages[0]!.elements = [table]
    const resized = resizePresentationProject(project, 'standard').slides.pages[0]!.elements[0]
    if (resized?.type !== 'table') throw new Error('Missing resized table')
    expect(resized.cellStyles?.[0]?.[0]?.borders).toEqual({ top: { color: '#FF0000', width: 3, type: 'solid' } })
  })

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
