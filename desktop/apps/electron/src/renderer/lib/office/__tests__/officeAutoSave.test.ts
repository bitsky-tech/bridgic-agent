import { expect, it } from 'bun:test'
import { createOfficeAutoSave } from '../officeAutoSave'

it('drains edits received during a write before a close flush completes', async () => {
  let release!: () => void
  let writes = 0
  const statuses: string[] = []
  const saver = createOfficeAutoSave(async () => {
    if (++writes === 1) await new Promise<void>((resolve) => { release = resolve })
  }, (status) => statuses.push(status))
  saver.schedule('first')
  const closing = saver.flush()
  await Promise.resolve()
  saver.schedule('second')
  release()
  await closing
  expect(writes).toBe(2)
  expect(statuses.at(-1)).toBe('saved')
  saver.dispose()
})

it('retains a failed revision for explicit retry without a write loop', async () => {
  let attempts = 0
  const statuses: string[] = []
  const saver = createOfficeAutoSave(async () => {
    if (++attempts === 1) throw new Error('disk full')
  }, (status) => statuses.push(status))
  saver.schedule('edit')
  await expect(saver.flush()).rejects.toThrow('disk full')
  expect(attempts).toBe(1)
  expect(statuses.at(-1)).toBe('error')
  await saver.flush()
  expect(attempts).toBe(2)
  expect(statuses.at(-1)).toBe('saved')
  saver.dispose()
})
