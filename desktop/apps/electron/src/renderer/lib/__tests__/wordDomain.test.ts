import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const {
  countWordContent,
  createEmptyWordWorkspace,
  createWordDomainStore,
  createWordWorkspace,
  reduceWordCommand,
  restoreWordWorkspace,
  sanitizeWordHtml,
} = await import('../wordDomain')
const { createUniverDocumentSnapshot, getUniverDocumentText, insertReferenceInSnapshot } = await import('../wordUniverModel')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('Word renderer domain', () => {
  it('isolates one workspace to its Session and manages internal document tabs', async () => {
    const initial = createWordWorkspace('session-word', 'Untitled document')
    const store = createWordDomainStore(initial, { defaultTitle: 'Untitled document' })

    const created = await store.dispatch({
      type: 'document.create',
      title: 'Plan',
      html: '<h1>Plan</h1><p>First draft</p>',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.state.sessionId).toBe('session-word')
    expect(created.state.documents).toHaveLength(2)
    expect(created.state.documents.find((item) => item.id === created.state.activeDocumentId)?.title)
      .toBe('Plan')

    const appended = await store.dispatch({
      type: 'document.append',
      text: 'Review risks',
      block: 'heading2',
    })
    expect(appended.ok).toBe(true)
    if (!appended.ok) return
    const appendedDocument = appended.state.documents.find((item) => item.id === appended.state.activeDocumentId)
    expect(getUniverDocumentText(appendedDocument!.snapshot)).toContain('Review risks')
    expect(appendedDocument?.snapshot.body?.paragraphs?.at(-1)?.paragraphStyle?.namedStyleType).toBe(5)

    const closed = await store.dispatch({
      type: 'document.close',
      documentId: appended.state.activeDocumentId,
    })
    expect(closed.ok).toBe(true)
    if (!closed.ok) return
    expect(closed.state.documents).toHaveLength(1)
    expect(closed.state.activeDocumentId).toBe(initial.activeDocumentId)
  })

  it('supports an unopened workspace and returns to it after the final document closes', async () => {
    const store = createWordDomainStore(createEmptyWordWorkspace('session-word'), { defaultTitle: 'Untitled document' })
    expect(store.getSnapshot()).toMatchObject({ activeDocumentId: '', documents: [] })

    const created = await store.dispatch({ type: 'document.create' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.state.documents).toHaveLength(1)

    const closed = await store.dispatch({ type: 'document.close', documentId: created.state.activeDocumentId })
    expect(closed.ok).toBe(true)
    if (!closed.ok) return
    expect(closed.state).toMatchObject({ activeDocumentId: '', documents: [] })
  })

  it('opens a DOCX source once and refreshes the same tab when the source changes', async () => {
    const store = createWordDomainStore(createEmptyWordWorkspace('session-word'), { defaultTitle: 'Untitled document' })

    const opened = await store.dispatch({
      type: 'document.open',
      title: 'report.docx',
      html: '<h1>First version</h1><p>Imported body</p>',
      sourcePath: '/tmp/report.docx',
      sourceMtimeMs: 10,
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const documentId = opened.state.activeDocumentId
    expect(opened.state.documents).toHaveLength(1)
    expect(opened.state.documents[0]).toMatchObject({
      id: documentId,
      title: 'report.docx',
      sourcePath: '/tmp/report.docx',
      sourceMtimeMs: 10,
    })
    expect(getUniverDocumentText(opened.state.documents[0]!.snapshot)).toContain('First version')

    const refreshed = await store.dispatch({
      type: 'document.open',
      title: 'renamed-report.docx',
      html: '<h1>Second version</h1>',
      sourcePath: '/tmp/report.docx',
      sourceMtimeMs: 20,
    })
    expect(refreshed.ok).toBe(true)
    if (!refreshed.ok) return
    expect(refreshed.state.documents).toHaveLength(1)
    expect(refreshed.state.documents[0]).toMatchObject({
      id: documentId,
      title: 'renamed-report.docx',
      sourcePath: '/tmp/report.docx',
      sourceMtimeMs: 20,
    })
    expect(getUniverDocumentText(refreshed.state.documents[0]!.snapshot)).toContain('Second version')
  })

  it('returns structured errors instead of accepting invalid commands', () => {
    const initial = createWordWorkspace('session-word', 'Untitled document')
    const missing = reduceWordCommand(initial, {
      type: 'document.update',
      documentId: 'other-session-document',
      html: '<p>Wrong owner</p>',
    }, 'Untitled document')
    expect(missing).toEqual({
      ok: false,
      error: {
        code: 'document_not_found',
        message: 'The requested Word document does not exist in this Session.',
      },
    })

    const unsupported = reduceWordCommand(initial, { type: 'toolbar.click' }, 'Untitled document')
    expect(unsupported.ok).toBe(false)
    if (!unsupported.ok) expect(unsupported.error.code).toBe('unsupported_command')
  })

  it('persists validated page setup inside the Session document model', () => {
    const initial = createWordWorkspace('session-word', 'Untitled document')
    expect(initial.documents[0]?.page).toEqual({ size: 'a4', orientation: 'portrait', margins: 'normal' })

    const updated = reduceWordCommand(initial, {
      type: 'document.page.update',
      page: { size: 'letter', orientation: 'landscape', margins: 'narrow' },
    }, 'Untitled document')
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.state.documents[0]?.page).toEqual({
      size: 'letter',
      orientation: 'landscape',
      margins: 'narrow',
    })

    const invalid = reduceWordCommand(updated.state, {
      type: 'document.page.update',
      page: { orientation: 'diagonal' },
    }, 'Untitled document')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('invalid_page_settings')
  })

  it('sanitizes restored and dispatched rich text', () => {
    const sanitized = sanitizeWordHtml(
      '<h1 onclick="steal()">Safe</h1><script>alert(1)</script><a href="javascript:steal()">link</a><table onclick="steal()"><tbody><tr><td style="border:1px solid red;position:fixed">Cell</td></tr></tbody></table>',
    )
    expect(sanitized).toBe('<h1>Safe</h1>alert(1)<a>link</a><table><tbody><tr><td style="border: 1px solid red;">Cell</td></tr></tbody></table>')

    const restored = restoreWordWorkspace({
      version: 1,
      sessionId: 'different-session',
      activeDocumentId: 'bad',
      documents: [],
    }, 'session-word', 'Untitled document')
    expect(restored.sessionId).toBe('session-word')
    expect(restored.documents).toHaveLength(0)
  })

  it('migrates same-Session v1 HTML documents to native Univer snapshots', () => {
    const restored = restoreWordWorkspace({
      version: 1,
      sessionId: 'session-word',
      activeDocumentId: 'legacy-document',
      documents: [{
        id: 'legacy-document',
        title: 'Legacy',
        html: '<h1>Imported heading</h1><p>Imported body</p>',
        page: { size: 'letter', orientation: 'landscape', margins: 'narrow' },
        headerFooter: { headerHtml: '<b>Header</b>', footerHtml: '', showPageNumbers: false, differentFirstPage: false, pageNumberStart: 1 },
        footnotes: [],
        citations: [],
        createdAt: 1,
        updatedAt: 2,
      }],
    }, 'session-word', 'Untitled document')

    expect(restored.version).toBe(2)
    expect(getUniverDocumentText(restored.documents[0]!.snapshot)).toContain('Imported heading')
    expect(restored.documents[0]?.snapshot.documentStyle.pageOrient).toBe(1)
    expect(restored.documents[0]?.snapshot.headers?.['bridgic-word-header']?.body.dataStream).toContain('Header')
  })

  it('counts CJK characters and whitespace-delimited words', () => {
    expect(countWordContent('<p>Hello world，你好 2026</p>')).toBe(5)
  })

  it('stores header, footer, footnotes, and citations in the Session document model', () => {
    const initial = createWordWorkspace('session-word', 'Untitled document')
    const headerFooter = reduceWordCommand(initial, {
      type: 'document.headerFooter.update',
      settings: { headerHtml: '<b>Quarterly plan</b>', footerHtml: '<i>Internal</i>', showPageNumbers: true },
    }, 'Untitled document')
    expect(headerFooter.ok).toBe(true)
    if (!headerFooter.ok) return
    expect(headerFooter.state.documents[0]?.headerFooter).toMatchObject({
      headerHtml: '<b>Quarterly plan</b>',
      footerHtml: '<i>Internal</i>',
      showPageNumbers: true,
    })

    const firstFootnote = reduceWordCommand(headerFooter.state, {
      type: 'document.footnote.add',
      footnote: { id: 'source-1', text: 'Primary source' },
    }, 'Untitled document')
    expect(firstFootnote.ok).toBe(true)
    if (!firstFootnote.ok) return
    const secondFootnote = reduceWordCommand(firstFootnote.state, {
      type: 'document.footnote.add',
      footnote: { id: 'source-2', text: 'Supporting source' },
    }, 'Untitled document')
    expect(secondFootnote.ok).toBe(true)
    if (!secondFootnote.ok) return
    expect(secondFootnote.state.documents[0]?.footnotes.map((item) => item.number)).toEqual([1, 2])

    const removed = reduceWordCommand(secondFootnote.state, {
      type: 'document.footnote.remove',
      footnoteId: 'source-1',
    }, 'Untitled document')
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.state.documents[0]?.footnotes).toEqual([{ id: 'source-2', number: 1, text: 'Supporting source' }])

    const citation = reduceWordCommand(removed.state, {
      type: 'document.citation.add',
      citation: { id: 'cite-1', text: 'Author, 2026' },
    }, 'Untitled document')
    expect(citation.ok).toBe(true)
    if (!citation.ok) return
    expect(citation.state.documents[0]?.citations).toEqual([{ id: 'cite-1', text: 'Author, 2026' }])

    const updatedCitation = reduceWordCommand(citation.state, {
      type: 'document.citation.update',
      citationId: 'cite-1',
      text: 'Author, 2027',
    }, 'Untitled document')
    expect(updatedCitation.ok).toBe(true)
    if (!updatedCitation.ok) return
    expect(updatedCitation.state.documents[0]?.citations).toEqual([{ id: 'cite-1', text: 'Author, 2027' }])
    expect(getUniverDocumentText(updatedCitation.state.documents[0]!.snapshot)).toContain('(Author, 2027)')
  })

  it('derives reference state from an externally supplied native snapshot', () => {
    let snapshot = createUniverDocumentSnapshot('external', 'External', {
      size: 'a4',
      orientation: 'portrait',
      margins: 'normal',
    }, {
      headerHtml: '',
      footerHtml: '',
      showPageNumbers: false,
      differentFirstPage: false,
      pageNumberStart: 1,
    }, '<p>Body</p>')
    snapshot = insertReferenceInSnapshot(snapshot, { kind: 'footnote', id: 'note-1', number: 1, text: 'Source' })
    snapshot = insertReferenceInSnapshot(snapshot, { kind: 'citation', id: 'cite-1', text: 'Author, 2026' })

    const created = reduceWordCommand(createEmptyWordWorkspace('session-word'), {
      type: 'document.create',
      title: 'Imported snapshot',
      snapshot,
    }, 'Untitled document')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.state.documents[0]?.footnotes).toEqual([{ id: 'note-1', number: 1, text: 'Source' }])
    expect(created.state.documents[0]?.citations).toEqual([{ id: 'cite-1', text: 'Author, 2026' }])
  })

  it('preserves only safe structured editor attributes', () => {
    const sanitized = sanitizeWordHtml(
      '<nav data-word-toc="true" onclick="bad()"><p data-word-toc-title="true">Contents</p><ol><li data-word-toc-level="2">Section</li></ol></nav>'
      + '<sup data-word-footnote-id="source-1" data-word-footnote-number="2">2</sup>'
      + '<img src="data:image/png;base64,iVBORw0KGgo=" onerror="bad()">',
    )
    expect(sanitized).toContain('<nav data-word-toc="true">')
    expect(sanitized).toContain('data-word-toc-level="2"')
    expect(sanitized).toContain('data-word-footnote-id="source-1"')
    expect(sanitized).toContain('src="data:image/png;base64,iVBORw0KGgo="')
    expect(sanitized).not.toContain('onclick')
    expect(sanitized).not.toContain('onerror')
  })

  it('preserves StarterKit code blocks through the persistence sanitizer', () => {
    expect(sanitizeWordHtml('<pre><code>const answer = 42</code></pre>'))
      .toBe('<pre><code>const answer = 42</code></pre>')
  })

  it('validates editor commands and returns the registered Session adapter result', async () => {
    const store = createWordDomainStore(createWordWorkspace('session-word', 'Untitled document'), { defaultTitle: 'Untitled document' })
    const commands: unknown[] = []
    store.registerEditorCommandHandler(async (command) => {
      commands.push(command)
      return true
    })

    expect((await store.api.dispatch({ type: 'editor.format', action: 'copy' })).ok).toBe(true)
    expect((await store.api.dispatch({ type: 'editor.insert', kind: 'table', rows: 3, cols: 4, withHeaderRow: true })).ok).toBe(true)
    const invalid = await store.api.dispatch({ type: 'editor.insert', kind: 'table', rows: -1, cols: 4 })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('invalid_editor_command')
    expect(commands).toEqual([
      { type: 'editor.format', action: 'copy' },
      { type: 'editor.insert', kind: 'table', rows: 3, cols: 4, withHeaderRow: true },
    ])

    store.registerEditorCommandHandler(async () => false)
    const rejected = await store.api.dispatch({ type: 'editor.format', action: 'paste' })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.code).toBe('editor_command_failed')
  })
})
