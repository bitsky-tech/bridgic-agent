import { describe, expect, it } from 'bun:test'
import { CommandType } from '@univerjs/core'
import { createExcelEditorBinding } from '../../lib/office/excelEditorBinding'
import { isExcelContentMutation } from '../excelContentChanges'

describe('Excel content notifications', () => {
  it('keeps the recorded startup and cell-input notifications clean until a workbook mutation commits', async () => {
    const changes: string[] = []
    const binding = createExcelEditorBinding({
      sessionId: 'session', documentId: 'workbook', onChange: (value: string) => changes.push(value),
      readSnapshot: () => 'committed cell', flushNative: () => undefined, disposeNative: () => undefined,
    })
    const notify = (id: string, type = CommandType.MUTATION) => {
      if (isExcelContentMutation({ id, type })) binding.scheduleChange()
    }
    notify('sheet.operation.set-selections', CommandType.OPERATION)
    notify('doc.mutation.rich-text-editing')
    notify('formula.mutation.set-trigger-formula-calculation-start')
    notify('formula.mutation.set-formula-calculation-start')
    notify('formula.mutation.set-formula-calculation-notification')
    notify('formula.mutation.set-formula-calculation-stop')
    await binding.flush()
    expect(changes).toEqual([])
    notify('sheet.mutation.set-range-values')
    await binding.flush()
    expect(changes).toEqual(['committed cell'])
    binding.dispose()
  })

  it.each([
    'sheet.mutation.insert-row',
    'sheet.mutation.set-col-width',
    'sheet.mutation.set-numfmt',
    'formula.mutation.set-defined-name',
    'sheet.mutation.set-gridlines',
  ])('retains content, formatting and workbook metadata mutations: %s', (id) => {
    expect(isExcelContentMutation({ id, type: CommandType.MUTATION })).toBe(true)
  })
})
