import { PRESET_LIST_TYPE, type IDocumentBody, type IDocumentData } from '@univerjs/core'

export type WordHeaderFooterField = 'headerHtml' | 'footerHtml'

/** An isolated native editing draft, never an HTML representation of the segment. */
export interface WordHeaderFooterDraft {
  field: WordHeaderFooterField
  documentId: string
  segmentId: string
  original: IDocumentData
  snapshot: IDocumentData
}

const resourceKeys = ['drawings', 'tableSource', 'lists'] as const
const segmentStyleKeys = ['defaultHeaderId', 'defaultFooterId', 'firstPageHeaderId', 'firstPageFooterId', 'evenPageHeaderId', 'evenPageFooterId', 'useFirstPageHeaderFooter', 'evenAndOddHeaders'] as const

function drawingContent(drawing: object | undefined) {
  return drawing && Object.fromEntries(Object.entries(drawing).filter(([key]) => !['transform', 'transforms', 'isMultiTransform'].includes(key)))
}

function contentSignature(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
    return item
  })
}

function resourceIds(body: IDocumentBody | undefined, snapshot?: IDocumentData) {
  return {
    drawings: new Set(body?.customBlocks?.map((block) => block.blockId) ?? []),
    tableSource: new Set(body?.tables?.map((table) => table.tableId) ?? []),
    lists: new Set(body?.paragraphs?.flatMap((paragraph) => {
      const bullet = paragraph.bullet
      if (!bullet) return []
      return [bullet.listId, ...(snapshot?.lists?.[bullet.listType] ? [bullet.listType] : [])]
    }) ?? []),
  }
}

function segment(snapshot: IDocumentData, field: WordHeaderFooterField) {
  const id = snapshot.documentStyle[field === 'headerHtml' ? 'defaultHeaderId' : 'defaultFooterId']
  const parts = field === 'headerHtml' ? snapshot.headers : snapshot.footers
  return { id, value: id !== undefined ? parts?.[id] : undefined }
}

/** Edit the selected segment with the same native engine as the document body. */
export function createWordHeaderFooterDraft(snapshot: IDocumentData, field: WordHeaderFooterField): WordHeaderFooterDraft {
  const original = structuredClone(snapshot)
  const selected = segment(original, field)
  const segmentId = selected.id || `bridgic-word-${field === 'headerHtml' ? 'header' : 'footer'}-${crypto.randomUUID()}`
  const body = structuredClone(selected.value?.body ?? { dataStream: '\r\n', paragraphs: [{ startIndex: 0 }], sectionBreaks: [{ startIndex: 1 }] })
  const ids = resourceIds(body, original)
  const draft = structuredClone(original)
  draft.id = `word-header-footer-edit-${crypto.randomUUID()}`
  draft.body = body
  draft.headers = {}
  draft.footers = {}
  delete draft.resources
  delete draft.headerFooterDrawingsOrder
  for (const key of segmentStyleKeys) delete draft.documentStyle[key]
  for (const key of resourceKeys) {
    draft[key] = structuredClone(Object.fromEntries(Object.entries(original[key] ?? {}).filter(([id]) => ids[key].has(id))))
  }
  for (const drawing of Object.values(draft.drawings ?? {})) {
    drawing.unitId = draft.id
    drawing.subUnitId = draft.id
  }
  draft.drawingsOrder = [...new Set([...(original.drawingsOrder ?? []), ...(original.headerFooterDrawingsOrder ?? []), ...ids.drawings])].filter((id) => ids.drawings.has(id))
  return { field, documentId: original.id, segmentId, original, snapshot: draft }
}

/** Compare native content, excluding renderer caches and viewport state. */
export function wordHeaderFooterContentSignature(snapshot: IDocumentData): string {
  const ids = resourceIds(snapshot.body, snapshot)
  const body = structuredClone(snapshot.body)
  if (body) {
    // Native typing/undo materializes empty arrays that were absent on import.
    for (const key of ['textRuns', 'paragraphs', 'sectionBreaks', 'customBlocks', 'tables', 'blockRanges', 'customRanges', 'customDecorations'] as const) body[key] ??= []
    delete body.payloads
  }
  return contentSignature({ body, ...Object.fromEntries(resourceKeys.map((key) => [key,
    [...ids[key]].sort().map((id) => [id, key === 'drawings' ? drawingContent(snapshot.drawings?.[id]) : snapshot[key]?.[id]]),
  ])), drawingsOrder: snapshot.drawingsOrder ?? [] })
}

/** Merge only the edited segment, preserving the live body, other variants and shared assets. */
export function mergeWordHeaderFooterDraft(current: IDocumentData, draft: WordHeaderFooterDraft, edited: IDocumentData): IDocumentData {
  if (current.id !== draft.documentId || !edited.body) throw new Error('The Word document is no longer available.')
  const selected = segment(current, draft.field)
  const original = segment(draft.original, draft.field)
  const originalIds = resourceIds(original.value?.body, draft.original)
  const compareSegment = (snapshot: IDocumentData) => JSON.stringify({ selected: segment(snapshot, draft.field),
    assets: resourceKeys.map((key) => [...originalIds[key]].sort().map((id) => [id, snapshot[key]?.[id]])),
  })
  if (compareSegment(current) !== compareSegment(draft.original)) throw new Error('The header or footer changed while it was being edited. Reopen it to edit the latest version.')

  const result = structuredClone(current)
  const body = structuredClone(edited.body)
  const retainedBodies = [current.body,
    ...Object.entries(current.headers ?? {}).filter(([id]) => draft.field !== 'headerHtml' || id !== selected.id).map(([, part]) => part.body),
    ...Object.entries(current.footers ?? {}).filter(([id]) => draft.field !== 'footerHtml' || id !== selected.id).map(([, part]) => part.body),
  ]
  const retained = resourceIds(undefined)
  for (const other of retainedBodies) {
    const ids = resourceIds(other, current)
    for (const key of resourceKeys) for (const id of ids[key]) retained[key].add(id)
  }
  const editedIds = resourceIds(body, edited)
  const drawingIdMap = new Map<string, string>()
  for (const key of resourceKeys) {
    const target = result[key] ??= {}
    for (const id of editedIds[key]) {
      const source = edited[key]?.[id]
      // Univer's built-in lists carry a listId but use the preset keyed by
      // listType; creating one does not add an entry to snapshot.lists.
      if (!source && key === 'lists' && !draft.original.lists?.[id]
        && body.paragraphs?.some((paragraph) => paragraph.bullet?.listId === id && PRESET_LIST_TYPE[paragraph.bullet.listType])) continue
      if (!source) throw new Error(`The edited header or footer has a missing ${key} resource.`)
      let value = structuredClone(source)
      if (key === 'drawings' && 'drawingId' in value) {
        value.unitId = current.id
        value.subUnitId = current.id
        // The temporary body has different canvas coordinates from a header.
        // Keep canonical drawing data when only those layout caches changed.
        const existing = current.drawings?.[id]
        if (existing && contentSignature(drawingContent(existing)) === contentSignature(drawingContent(value))) value = structuredClone(existing)
      }
      // A native edit to a shared image, list or table must not alter the body
      // or another segment. New resource IDs must also not overwrite live ones.
      let nextId = id
      if (Object.hasOwn(target, id) && (!originalIds[key].has(id) || (retained[key].has(id) && JSON.stringify(target[id]) !== JSON.stringify(value)))) {
        nextId = `${draft.segmentId}-${id}-copy`
        while (Object.hasOwn(target, nextId)) nextId += '-copy'
      }
      if (key === 'drawings') {
        for (const block of body.customBlocks ?? []) if (block.blockId === id) block.blockId = nextId
        if ('drawingId' in value) value.drawingId = nextId
        drawingIdMap.set(id, nextId)
      } else if (key === 'tableSource') {
        for (const table of body.tables ?? []) if (table.tableId === id) table.tableId = nextId
        if ('tableId' in value) value.tableId = nextId
      } else {
        for (const paragraph of body.paragraphs ?? []) {
          const bullet = paragraph.bullet
          if (!bullet) continue
          if (bullet.listId === id) bullet.listId = nextId
          if (bullet.listType === id) bullet.listType = nextId as typeof bullet.listType
        }
      }
      // The map's key selects the corresponding resource type at runtime.
      Object.assign(target, { [nextId]: value })
    }
    const remaining = resourceIds(body, result)[key]
    for (const id of originalIds[key]) if (!retained[key].has(id) && !remaining.has(id)) delete target[id]
  }
  const incomingOrder = [...new Set([...(edited.drawingsOrder ?? []), ...editedIds.drawings])].flatMap((id) => drawingIdMap.has(id) ? [drawingIdMap.get(id)!] : [])
  const mergeOrder = (order: string[]) => {
    const pending = incomingOrder.filter((id) => !retained.drawings.has(id) || !order.includes(id))
    const merged: string[] = []
    for (const id of order) {
      if (originalIds.drawings.has(id) && !retained.drawings.has(id)) {
        const replacement = pending.shift()
        if (replacement) merged.push(replacement)
      } else merged.push(id)
    }
    return [...new Set([...merged, ...pending])]
  }
  result.drawingsOrder = mergeOrder(current.drawingsOrder ?? [])
  if (current.headerFooterDrawingsOrder) result.headerFooterDrawingsOrder = mergeOrder(current.headerFooterDrawingsOrder)
  if (draft.field === 'headerHtml') {
    result.headers ??= {}
    if (selected.id === '') delete result.headers['']
    result.headers[draft.segmentId] = { ...selected.value, headerId: draft.segmentId, body }
    result.documentStyle.defaultHeaderId = draft.segmentId
  } else {
    result.footers ??= {}
    if (selected.id === '') delete result.footers['']
    result.footers[draft.segmentId] = { ...selected.value, footerId: draft.segmentId, body }
    result.documentStyle.defaultFooterId = draft.segmentId
  }
  // Explicit empty defaults in imported sections must follow a newly added default.
  const styleKey = draft.field === 'headerHtml' ? 'defaultHeaderId' : 'defaultFooterId'
  if (!selected.id) for (const section of result.body?.sectionBreaks ?? []) {
    if (section[styleKey] === '') section[styleKey] = draft.segmentId
  }
  return result
}
