import type { IDocumentData } from '@univerjs/core'

import {
  appendTextBlockToSnapshot,
  applyHeaderFooterToSnapshot,
  applyPageSettingsToSnapshot,
  createUniverDocumentSnapshot,
  extractWordReferences,
  getUniverWordCount,
  insertReferenceInSnapshot,
  normalizeUniverDocumentSnapshot,
  removeReferenceFromSnapshot,
  updateReferenceInSnapshot,
} from './wordUniverModel'

/**
 * Session-bound Word renderer domain.
 *
 * The Session owns this store and its Univer renderer target. Agent operations
 * use the stable structured API instead of coupling business logic to buttons,
 * canvas coordinates, or Univer's internal DOM.
 */

export const WORD_DOMAIN_VERSION = 2

export type WordPageSize = 'a4' | 'letter'
export type WordPageOrientation = 'portrait' | 'landscape'
export type WordPageMargins = 'normal' | 'narrow' | 'wide'

export interface WordPageSettings {
  size: WordPageSize
  orientation: WordPageOrientation
  margins: WordPageMargins
}

export interface WordHeaderFooterSettings {
  headerHtml: string
  footerHtml: string
  showPageNumbers: boolean
  differentFirstPage: boolean
  pageNumberStart: number
}

export interface WordFootnote {
  id: string
  number: number
  text: string
}

export interface WordCitationEntry {
  id: string
  text: string
}

export const DEFAULT_WORD_PAGE_SETTINGS: WordPageSettings = {
  size: 'a4',
  orientation: 'portrait',
  margins: 'normal',
}

export const DEFAULT_WORD_HEADER_FOOTER: WordHeaderFooterSettings = {
  headerHtml: '',
  footerHtml: '',
  showPageNumbers: false,
  differentFirstPage: false,
  pageNumberStart: 1,
}

export interface WordDocumentState {
  id: string
  title: string
  sourcePath?: string
  sourceMtimeMs?: number
  snapshot: IDocumentData
  page: WordPageSettings
  headerFooter: WordHeaderFooterSettings
  footnotes: WordFootnote[]
  citations: WordCitationEntry[]
  createdAt: number
  updatedAt: number
}

export interface WordWorkspaceState {
  version: typeof WORD_DOMAIN_VERSION
  sessionId: string
  activeDocumentId: string
  documents: WordDocumentState[]
}

export type WordAppendBlock = 'paragraph' | 'heading1' | 'heading2' | 'quote'

export interface WordTableOfContentsEntry {
  level: number
  text: string
}

export type WordFormattingCommand =
  | 'bold'
  | 'copy'
  | 'cut'
  | 'decreaseFontSize'
  | 'fontName'
  | 'fontSize'
  | 'foreColor'
  | 'formatBlock'
  | 'hiliteColor'
  | 'increaseFontSize'
  | 'indent'
  | 'insertHorizontalRule'
  | 'insertOrderedList'
  | 'insertUnorderedList'
  | 'italic'
  | 'justifyCenter'
  | 'justifyFull'
  | 'justifyLeft'
  | 'justifyRight'
  | 'letterSpacing'
  | 'lineHeight'
  | 'outdent'
  | 'paste'
  | 'redo'
  | 'removeFormat'
  | 'strikeThrough'
  | 'subscript'
  | 'superscript'
  | 'toggleCase'
  | 'toggleTaskList'
  | 'underline'
  | 'undo'
  | 'uppercase'

export type WordTableAction =
  | 'addColumnAfter'
  | 'addColumnBefore'
  | 'addRowAfter'
  | 'addRowBefore'
  | 'deleteColumn'
  | 'deleteRow'
  | 'deleteTable'

export type WordEditorCommand =
  | { type: 'editor.format'; action: WordFormattingCommand; value?: string }
  | { type: 'editor.insert'; kind: 'citation'; id: string; text: string }
  | { type: 'editor.insert'; kind: 'footnote'; id: string; number: number; text: string }
  | { type: 'editor.insert'; kind: 'html'; html: string }
  | { type: 'editor.insert'; kind: 'image'; src: string; alt?: string; title?: string }
  | { type: 'editor.insert'; kind: 'link'; href: string }
  | { type: 'editor.insert'; kind: 'pageBreak' }
  | { type: 'editor.insert'; kind: 'table'; rows: number; cols: number; withHeaderRow?: boolean }
  | { type: 'editor.insert'; kind: 'tableOfContents'; title: string; entries: WordTableOfContentsEntry[] }
  | { type: 'editor.reference.remove'; kind: 'citation' | 'footnote'; id: string }
  | { type: 'editor.reference.update'; kind: 'citation' | 'footnote'; id: string; text: string }
  | { type: 'editor.table'; action: WordTableAction }

export type WordRendererCommand =
  | WordEditorCommand
  | { type: 'workspace.get' }
  | { type: 'document.create'; title?: string; html?: string; snapshot?: unknown }
  | { type: 'document.open'; title: string; html: string; sourcePath: string; sourceMtimeMs: number }
  | { type: 'document.activate'; documentId: string }
  | { type: 'document.update'; documentId?: string; title?: string; html?: string; snapshot?: unknown }
  | { type: 'document.page.update'; documentId?: string; page: Partial<WordPageSettings> }
  | { type: 'document.headerFooter.update'; documentId?: string; settings: Partial<WordHeaderFooterSettings> }
  | { type: 'document.footnote.add'; documentId?: string; footnote: { id: string; text: string } }
  | { type: 'document.footnote.update'; documentId?: string; footnoteId: string; text: string }
  | { type: 'document.footnote.remove'; documentId?: string; footnoteId: string }
  | { type: 'document.citation.add'; documentId?: string; citation: WordCitationEntry }
  | { type: 'document.citation.update'; documentId?: string; citationId: string; text: string }
  | { type: 'document.citation.remove'; documentId?: string; citationId: string }
  | { type: 'document.append'; documentId?: string; text: string; block?: WordAppendBlock }
  | { type: 'document.close'; documentId: string }

export type WordRendererResult =
  | { ok: true; state: WordWorkspaceState }
  | { ok: false; error: { code: string; message: string } }

export interface BridgicWordRendererApi {
  readonly sessionId: string
  dispatch(command: unknown): Promise<WordRendererResult>
}

export interface WordDomainStore {
  readonly api: BridgicWordRendererApi
  commitEditorSnapshot(documentId: string, snapshot: IDocumentData): boolean
  dispatch(command: unknown): Promise<WordRendererResult>
  getSnapshot(): WordWorkspaceState
  registerEditorCommandHandler(handler: (command: WordEditorCommand) => Promise<boolean>): () => void
  subscribe(listener: () => void): () => void
}

interface WordDomainOptions {
  defaultTitle: string
  onChange?: (state: WordWorkspaceState) => void
}

const ALLOWED_TAGS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'COL', 'COLGROUP', 'DIV', 'EM', 'FIGCAPTION',
  'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'HR', 'I', 'IMG', 'LI', 'MARK', 'NAV', 'OL', 'P', 'PRE',
  'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL',
])

const ALLOWED_STYLE_PROPERTIES = new Set([
  'background-color', 'border', 'border-bottom', 'border-collapse', 'break-after', 'color',
  'font-family', 'font-size', 'font-style', 'font-weight', 'height', 'letter-spacing', 'line-height',
  'list-style-type', 'margin', 'margin-left', 'max-width', 'padding', 'text-align', 'text-decoration',
  'vertical-align', 'width',
])

declare global {
  interface Window {
    __bridgicWord?: BridgicWordRendererApi
  }
}

export function createWordWorkspace(sessionId: string, defaultTitle: string): WordWorkspaceState {
  const document = createDocument(defaultTitle)
  return { version: WORD_DOMAIN_VERSION, sessionId, activeDocumentId: document.id, documents: [document] }
}

/** Create the unopened Session workspace shown before the first Word document is created. */
export function createEmptyWordWorkspace(sessionId: string): WordWorkspaceState {
  return { version: WORD_DOMAIN_VERSION, sessionId, activeDocumentId: '', documents: [] }
}

/** Restore v2 snapshots and migrate same-Session v1 HTML workspaces in place. */
export function restoreWordWorkspace(value: unknown, sessionId: string, defaultTitle: string): WordWorkspaceState {
  if (!isRecord(value) || value.sessionId !== sessionId || !Array.isArray(value.documents)) {
    return createEmptyWordWorkspace(sessionId)
  }
  const isLegacy = value.version === 1
  if (!isLegacy && value.version !== WORD_DOMAIN_VERSION) return createEmptyWordWorkspace(sessionId)

  const documents = value.documents.flatMap((item): WordDocumentState[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.title !== 'string') return []
    if (typeof item.createdAt !== 'number' || typeof item.updatedAt !== 'number') return []
    const title = normalizedTitle(item.title, defaultTitle)
    const page = normalizePageSettings(item.page)
    const headerFooter = normalizeHeaderFooter(item.headerFooter)
    const snapshot = isLegacy
      ? createUniverDocumentSnapshot(item.id, title, page, headerFooter, typeof item.html === 'string' ? sanitizeWordHtml(item.html) : '')
      : normalizeUniverDocumentSnapshot(item.snapshot, item.id, title, page, headerFooter)
    const references = extractWordReferences(snapshot)
    return [{
      id: item.id,
      title,
      ...(typeof item.sourcePath === 'string' && item.sourcePath.trim() ? { sourcePath: item.sourcePath } : {}),
      ...(typeof item.sourceMtimeMs === 'number' && Number.isFinite(item.sourceMtimeMs) ? { sourceMtimeMs: item.sourceMtimeMs } : {}),
      snapshot,
      page,
      headerFooter,
      footnotes: references.footnotes.length > 0 ? references.footnotes : normalizeFootnotes(item.footnotes),
      citations: references.citations.length > 0 ? references.citations : normalizeCitations(item.citations),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }]
  })
  if (documents.length === 0) return createEmptyWordWorkspace(sessionId)
  const activeDocumentId = typeof value.activeDocumentId === 'string' && documents.some((item) => item.id === value.activeDocumentId)
    ? value.activeDocumentId
    : documents[0]!.id
  return { version: WORD_DOMAIN_VERSION, sessionId, activeDocumentId, documents }
}

export function createWordDomainStore(initialState: WordWorkspaceState, options: WordDomainOptions): WordDomainStore {
  let state = restoreWordWorkspace(initialState, initialState.sessionId, options.defaultTitle)
  let editorCommandHandler: ((command: WordEditorCommand) => Promise<boolean>) | null = null
  const listeners = new Set<() => void>()

  const publish = (nextState: WordWorkspaceState) => {
    if (nextState === state) return
    state = nextState
    options.onChange?.(state)
    for (const listener of listeners) listener()
  }

  const dispatch = async (command: unknown): Promise<WordRendererResult> => {
    if (isRecord(command) && typeof command.type === 'string' && command.type.startsWith('editor.')) {
      const editorCommand = validateWordEditorCommand(command)
      if (!editorCommand) return failure('invalid_editor_command', 'Unsupported or malformed Word editor command.')
      if (!editorCommandHandler) return failure('editor_unavailable', 'The Session Word editor is not ready.')
      try {
        if (!await editorCommandHandler(editorCommand)) return failure('editor_command_failed', 'The Word editor could not apply the requested command.')
      } catch {
        return failure('editor_command_failed', 'The Word editor could not apply the requested command.')
      }
      return { ok: true, state }
    }
    const result = reduceWordCommand(state, command, options.defaultTitle)
    if (!result.ok) return result
    publish(result.state)
    return { ok: true, state }
  }

  const api: BridgicWordRendererApi = { sessionId: state.sessionId, dispatch }
  return {
    api,
    dispatch,
    getSnapshot: () => state,
    commitEditorSnapshot: (documentId, snapshot) => {
      const document = state.documents.find((item) => item.id === documentId)
      if (!document) return false
      const normalized = normalizeUniverDocumentSnapshot(snapshot, document.id, document.title, document.page, document.headerFooter)
      const references = extractWordReferences(normalized)
      publish({
        ...state,
        documents: state.documents.map((item) => item.id === documentId ? {
          ...item,
          snapshot: normalized,
          footnotes: references.footnotes,
          citations: references.citations,
          updatedAt: Date.now(),
        } : item),
      })
      return true
    },
    registerEditorCommandHandler: (handler) => {
      editorCommandHandler = handler
      return () => { if (editorCommandHandler === handler) editorCommandHandler = null }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function reduceWordCommand(state: WordWorkspaceState, command: unknown, defaultTitle: string): WordRendererResult {
  if (!isRecord(command) || typeof command.type !== 'string') {
    return failure('invalid_command', 'Word commands must be objects with a string type.')
  }
  if (command.type === 'workspace.get') return { ok: true, state }

  if (command.type === 'document.create') {
    if (command.title !== undefined && typeof command.title !== 'string') return failure('invalid_title', 'Document title must be a string.')
    if (command.html !== undefined && typeof command.html !== 'string') return failure('invalid_html', 'Document content must be an HTML string.')
    const document = createDocument(normalizedTitle(typeof command.title === 'string' ? command.title : '', defaultTitle), typeof command.html === 'string' ? command.html : undefined)
    if (command.snapshot !== undefined) {
      document.snapshot = normalizeUniverDocumentSnapshot(command.snapshot, document.id, document.title, document.page, document.headerFooter)
      Object.assign(document, extractWordReferences(document.snapshot))
    }
    return success(state, [...state.documents, document], document.id)
  }

  if (command.type === 'document.open') {
    if (typeof command.title !== 'string') return failure('invalid_title', 'Document title must be a string.')
    if (typeof command.html !== 'string') return failure('invalid_html', 'Document content must be an HTML string.')
    if (typeof command.sourcePath !== 'string' || !command.sourcePath.trim() || command.sourcePath.length > 4_096) {
      return failure('invalid_source_path', 'Document source path must be a non-empty string.')
    }
    if (typeof command.sourceMtimeMs !== 'number' || !Number.isFinite(command.sourceMtimeMs) || command.sourceMtimeMs < 0) {
      return failure('invalid_source_mtime', 'Document source modification time must be a non-negative number.')
    }
    const sourcePath = command.sourcePath.trim()
    const sourceMtimeMs = command.sourceMtimeMs
    const title = normalizedTitle(command.title, defaultTitle)
    const existing = state.documents.find((item) => item.sourcePath === sourcePath)
    if (existing) {
      const snapshot = createUniverDocumentSnapshot(existing.id, title, existing.page, existing.headerFooter, sanitizeWordHtml(command.html))
      const references = extractWordReferences(snapshot)
      const documents = state.documents.map((item) => item.id === existing.id ? {
        ...item,
        title,
        sourceMtimeMs,
        snapshot,
        ...references,
        updatedAt: Date.now(),
      } : item)
      return success(state, documents, existing.id)
    }
    const document = createDocument(title, command.html, {
      sourceMtimeMs,
      sourcePath,
    })
    return success(state, [...state.documents, document], document.id)
  }

  if (command.type === 'document.activate') {
    const document = findDocument(state, command.documentId)
    if (!document) return failure('document_not_found', 'The requested Word document does not exist in this Session.')
    return state.activeDocumentId === document.id ? { ok: true, state } : { ok: true, state: { ...state, activeDocumentId: document.id } }
  }

  if (command.type === 'document.update') {
    const documentId = optionalDocumentId(command.documentId, state)
    if (!documentId) return failure('invalid_document_id', 'Document id must be a string.')
    if (command.title !== undefined && typeof command.title !== 'string') return failure('invalid_title', 'Document title must be a string.')
    if (command.html !== undefined && typeof command.html !== 'string') return failure('invalid_html', 'Document content must be an HTML string.')
    if (command.title === undefined && command.html === undefined && command.snapshot === undefined) {
      return failure('empty_update', 'A document update must include title, HTML, or a Univer snapshot.')
    }
    const document = findDocument(state, documentId)
    if (!document) return failure('document_not_found', 'The requested Word document does not exist in this Session.')
    const title = typeof command.title === 'string' ? normalizedTitle(command.title, defaultTitle) : document.title
    let snapshot: IDocumentData = { ...document.snapshot, title }
    if (command.snapshot !== undefined) {
      snapshot = normalizeUniverDocumentSnapshot(command.snapshot, document.id, title, document.page, document.headerFooter)
    } else if (typeof command.html === 'string') {
      snapshot = createUniverDocumentSnapshot(document.id, title, document.page, document.headerFooter, sanitizeWordHtml(command.html))
    }
    const references = extractWordReferences(snapshot)
    return replaceDocument(state, documentId, { title, snapshot, ...references })
  }

  if (command.type === 'document.page.update') {
    const documentId = optionalDocumentId(command.documentId, state)
    if (!documentId) return failure('invalid_document_id', 'Document id must be a string.')
    if (!isRecord(command.page)) return failure('invalid_page_settings', 'Page settings must be an object.')
    const document = findDocument(state, documentId)
    if (!document) return failure('document_not_found', 'The requested Word document does not exist in this Session.')
    const page = mergePageSettings(document.page, command.page)
    if (!page) return failure('invalid_page_settings', 'Unsupported Word page setting.')
    return replaceDocument(state, documentId, { page, snapshot: applyPageSettingsToSnapshot(document.snapshot, page) })
  }

  if (command.type === 'document.headerFooter.update') {
    const documentId = optionalDocumentId(command.documentId, state)
    if (!documentId) return failure('invalid_document_id', 'Document id must be a string.')
    if (!isRecord(command.settings)) return failure('invalid_header_footer', 'Header and footer settings must be an object.')
    const document = findDocument(state, documentId)
    if (!document) return failure('document_not_found', 'The requested Word document does not exist in this Session.')
    const headerFooter = mergeHeaderFooter(document.headerFooter, command.settings)
    if (!headerFooter) return failure('invalid_header_footer', 'Unsupported Word header or footer setting.')
    return replaceDocument(state, documentId, {
      headerFooter,
      snapshot: applyHeaderFooterToSnapshot(document.snapshot, headerFooter),
    })
  }

  if (command.type === 'document.append') {
    const documentId = optionalDocumentId(command.documentId, state)
    if (!documentId) return failure('invalid_document_id', 'Document id must be a string.')
    if (typeof command.text !== 'string') return failure('invalid_text', 'Appended Word content must be text.')
    if (command.block !== undefined && !isAppendBlock(command.block)) return failure('invalid_block', 'Unsupported Word block type.')
    const document = findDocument(state, documentId)
    if (!document) return failure('document_not_found', 'The requested Word document does not exist in this Session.')
    return replaceDocument(state, documentId, {
      snapshot: appendTextBlockToSnapshot(document.snapshot, command.text, command.block ?? 'paragraph'),
    })
  }

  if (command.type === 'document.footnote.add') {
    const documentId = optionalDocumentId(command.documentId, state)
    if (!documentId) return failure('invalid_document_id', 'Document id must be a string.')
    if (!isRecord(command.footnote) || typeof command.footnote.id !== 'string' || typeof command.footnote.text !== 'string') {
      return failure('invalid_footnote', 'Footnotes require a string id and text.')
    }
    const document = findDocument(state, documentId)
    if (!document) return failure('document_not_found', 'The requested Word document does not exist in this Session.')
    const id = normalizedReferenceId(command.footnote.id)
    const text = normalizedReferenceText(command.footnote.text)
    if (!id || !text || document.footnotes.some((item) => item.id === id)) return failure('invalid_footnote', 'Footnote id must be unique and footnote text cannot be empty.')
    const number = document.footnotes.length + 1
    const snapshot = insertReferenceInSnapshot(document.snapshot, { kind: 'footnote', id, number, text })
    return replaceDocument(state, documentId, { snapshot, ...extractWordReferences(snapshot) })
  }

  if (command.type === 'document.footnote.update') {
    const documentId = optionalDocumentId(command.documentId, state)
    if (!documentId || typeof command.footnoteId !== 'string' || typeof command.text !== 'string') return failure('invalid_footnote', 'Footnote id and text must be strings.')
    const document = findDocument(state, documentId)
    const text = normalizedReferenceText(command.text)
    if (!document) return failure('document_not_found', 'The requested Word document does not exist in this Session.')
    if (!text || !document.footnotes.some((item) => item.id === command.footnoteId)) return failure('footnote_not_found', 'The requested footnote does not exist or has empty text.')
    const snapshot = updateReferenceInSnapshot(document.snapshot, 'footnote', command.footnoteId, text)
    return replaceDocument(state, documentId, { snapshot, ...extractWordReferences(snapshot) })
  }

  if (command.type === 'document.footnote.remove') {
    const documentId = optionalDocumentId(command.documentId, state)
    if (!documentId || typeof command.footnoteId !== 'string') return failure('invalid_footnote', 'Footnote id must be a string.')
    const document = findDocument(state, documentId)
    if (!document) return failure('document_not_found', 'The requested Word document does not exist in this Session.')
    if (!document.footnotes.some((item) => item.id === command.footnoteId)) return failure('footnote_not_found', 'The requested footnote does not exist.')
    const snapshot = removeReferenceFromSnapshot(document.snapshot, 'footnote', command.footnoteId)
    return replaceDocument(state, documentId, { snapshot, ...extractWordReferences(snapshot) })
  }

  if (command.type === 'document.citation.add') {
    const documentId = optionalDocumentId(command.documentId, state)
    if (!documentId || !isRecord(command.citation) || typeof command.citation.id !== 'string' || typeof command.citation.text !== 'string') {
      return failure('invalid_citation', 'Citations require a string id and text.')
    }
    const document = findDocument(state, documentId)
    if (!document) return failure('document_not_found', 'The requested Word document does not exist in this Session.')
    const id = normalizedReferenceId(command.citation.id)
    const text = normalizedReferenceText(command.citation.text)
    if (!id || !text || document.citations.some((item) => item.id === id)) return failure('invalid_citation', 'Citation id must be unique and citation text cannot be empty.')
    const snapshot = insertReferenceInSnapshot(document.snapshot, { kind: 'citation', id, text })
    return replaceDocument(state, documentId, { snapshot, ...extractWordReferences(snapshot) })
  }

  if (command.type === 'document.citation.remove') {
    const documentId = optionalDocumentId(command.documentId, state)
    if (!documentId || typeof command.citationId !== 'string') return failure('invalid_citation', 'Citation id must be a string.')
    const document = findDocument(state, documentId)
    if (!document) return failure('document_not_found', 'The requested Word document does not exist in this Session.')
    if (!document.citations.some((item) => item.id === command.citationId)) return failure('citation_not_found', 'The requested citation does not exist.')
    const snapshot = removeReferenceFromSnapshot(document.snapshot, 'citation', command.citationId)
    return replaceDocument(state, documentId, { snapshot, ...extractWordReferences(snapshot) })
  }

  if (command.type === 'document.citation.update') {
    const documentId = optionalDocumentId(command.documentId, state)
    if (!documentId || typeof command.citationId !== 'string' || typeof command.text !== 'string') return failure('invalid_citation', 'Citation id and text must be strings.')
    const document = findDocument(state, documentId)
    const text = normalizedReferenceText(command.text)
    if (!document) return failure('document_not_found', 'The requested Word document does not exist in this Session.')
    if (!text || !document.citations.some((item) => item.id === command.citationId)) return failure('citation_not_found', 'The requested citation does not exist or has empty text.')
    const snapshot = updateReferenceInSnapshot(document.snapshot, 'citation', command.citationId, text)
    return replaceDocument(state, documentId, { snapshot, ...extractWordReferences(snapshot) })
  }

  if (command.type === 'document.close') {
    if (typeof command.documentId !== 'string') return failure('invalid_document_id', 'Document id must be a string.')
    if (!findDocument(state, command.documentId)) return failure('document_not_found', 'The requested Word document does not exist in this Session.')
    const documents = state.documents.filter((item) => item.id !== command.documentId)
    const activeDocumentId = state.activeDocumentId === command.documentId ? documents[0]?.id ?? '' : state.activeDocumentId
    return success(state, documents, activeDocumentId)
  }

  return failure('unsupported_command', `Unsupported Word command: ${command.type}`)
}

/** Legacy HTML sanitizer used only at the import/compatibility boundary. */
export function sanitizeWordHtml(input: string): string {
  const template = document.createElement('template')
  template.innerHTML = input
  const visit = (parent: ParentNode) => {
    for (const child of [...parent.childNodes]) {
      if (!(child instanceof Element)) continue
      if (!ALLOWED_TAGS.has(child.tagName)) {
        child.replaceWith(...child.childNodes)
        visit(parent)
        continue
      }
      const attributes = sanitizedAttributes(child)
      const style = sanitizedStyle((child as HTMLElement).getAttribute('style'))
      for (const attribute of [...child.attributes]) child.removeAttribute(attribute.name)
      for (const [name, value] of attributes) child.setAttribute(name, value)
      if (style) child.setAttribute('style', style)
      visit(child)
    }
  }
  visit(template.content)
  return template.innerHTML
}

export function countWordContent(content: string | IDocumentData): number {
  if (typeof content !== 'string') return getUniverWordCount(content)
  const template = document.createElement('template')
  template.innerHTML = sanitizeWordHtml(content)
  const text = template.content.textContent ?? ''
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const words = text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ').match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0
  return cjk + words
}

function createDocument(title: string, html = '<p><br></p>', source?: { sourceMtimeMs: number; sourcePath: string }): WordDocumentState {
  const now = Date.now()
  const id = createDocumentId()
  const page = { ...DEFAULT_WORD_PAGE_SETTINGS }
  const headerFooter = { ...DEFAULT_WORD_HEADER_FOOTER }
  const snapshot = createUniverDocumentSnapshot(id, title, page, headerFooter, sanitizeWordHtml(html))
  return {
    id,
    title,
    ...source,
    snapshot,
    page,
    headerFooter,
    ...extractWordReferences(snapshot),
    createdAt: now,
    updatedAt: now,
  }
}

function createDocumentId(): string {
  const suffix = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `word-${suffix}`
}

function replaceDocument(state: WordWorkspaceState, documentId: string, patch: Partial<WordDocumentState>): WordRendererResult {
  const documents = state.documents.map((item) => item.id === documentId ? { ...item, ...patch, updatedAt: Date.now() } : item)
  return success(state, documents, state.activeDocumentId)
}

function success(state: WordWorkspaceState, documents: WordDocumentState[], activeDocumentId: string): WordRendererResult {
  return { ok: true, state: { ...state, documents, activeDocumentId } }
}

function failure(code: string, message: string): WordRendererResult {
  return { ok: false, error: { code, message } }
}

function optionalDocumentId(value: unknown, state: WordWorkspaceState): string | null {
  if (value === undefined) return state.activeDocumentId
  return typeof value === 'string' ? value : null
}

function findDocument(state: WordWorkspaceState, value: unknown): WordDocumentState | undefined {
  return typeof value === 'string' ? state.documents.find((document) => document.id === value) : undefined
}

function normalizedTitle(title: string, fallback: string): string {
  return title.trim().slice(0, 120) || fallback
}

function normalizePageSettings(value: unknown): WordPageSettings {
  if (!isRecord(value)) return { ...DEFAULT_WORD_PAGE_SETTINGS }
  return {
    size: isPageSize(value.size) ? value.size : DEFAULT_WORD_PAGE_SETTINGS.size,
    orientation: isPageOrientation(value.orientation) ? value.orientation : DEFAULT_WORD_PAGE_SETTINGS.orientation,
    margins: isPageMargins(value.margins) ? value.margins : DEFAULT_WORD_PAGE_SETTINGS.margins,
  }
}

function mergePageSettings(current: WordPageSettings, patch: Record<string, unknown>): WordPageSettings | null {
  if (patch.size !== undefined && !isPageSize(patch.size)) return null
  if (patch.orientation !== undefined && !isPageOrientation(patch.orientation)) return null
  if (patch.margins !== undefined && !isPageMargins(patch.margins)) return null
  return {
    size: isPageSize(patch.size) ? patch.size : current.size,
    orientation: isPageOrientation(patch.orientation) ? patch.orientation : current.orientation,
    margins: isPageMargins(patch.margins) ? patch.margins : current.margins,
  }
}

function normalizeHeaderFooter(value: unknown): WordHeaderFooterSettings {
  if (!isRecord(value)) return { ...DEFAULT_WORD_HEADER_FOOTER }
  return {
    headerHtml: typeof value.headerHtml === 'string' ? sanitizeWordHtml(value.headerHtml) : '',
    footerHtml: typeof value.footerHtml === 'string' ? sanitizeWordHtml(value.footerHtml) : '',
    showPageNumbers: value.showPageNumbers === true,
    differentFirstPage: value.differentFirstPage === true,
    pageNumberStart: positiveInteger(value.pageNumberStart, 1),
  }
}

function mergeHeaderFooter(current: WordHeaderFooterSettings, patch: Record<string, unknown>): WordHeaderFooterSettings | null {
  if (patch.headerHtml !== undefined && typeof patch.headerHtml !== 'string') return null
  if (patch.footerHtml !== undefined && typeof patch.footerHtml !== 'string') return null
  if (patch.showPageNumbers !== undefined && typeof patch.showPageNumbers !== 'boolean') return null
  if (patch.differentFirstPage !== undefined && typeof patch.differentFirstPage !== 'boolean') return null
  if (patch.pageNumberStart !== undefined && (!Number.isInteger(patch.pageNumberStart) || Number(patch.pageNumberStart) < 1)) return null
  return {
    headerHtml: typeof patch.headerHtml === 'string' ? sanitizeWordHtml(patch.headerHtml) : current.headerHtml,
    footerHtml: typeof patch.footerHtml === 'string' ? sanitizeWordHtml(patch.footerHtml) : current.footerHtml,
    showPageNumbers: typeof patch.showPageNumbers === 'boolean' ? patch.showPageNumbers : current.showPageNumbers,
    differentFirstPage: typeof patch.differentFirstPage === 'boolean' ? patch.differentFirstPage : current.differentFirstPage,
    pageNumberStart: typeof patch.pageNumberStart === 'number' ? patch.pageNumberStart : current.pageNumberStart,
  }
}

function normalizeFootnotes(value: unknown): WordFootnote[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: WordFootnote[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.text !== 'string') continue
    const id = normalizedReferenceId(item.id)
    const text = normalizedReferenceText(item.text)
    if (!id || !text || seen.has(id)) continue
    seen.add(id)
    result.push({ id, number: result.length + 1, text })
  }
  return result
}

function normalizeCitations(value: unknown): WordCitationEntry[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: WordCitationEntry[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.text !== 'string') continue
    const id = normalizedReferenceId(item.id)
    const text = normalizedReferenceText(item.text)
    if (!id || !text || seen.has(id)) continue
    seen.add(id)
    result.push({ id, text })
  }
  return result
}

function sanitizedAttributes(element: Element): Array<[string, string]> {
  const attributes: Array<[string, string]> = []
  if (element.tagName === 'A') {
    const href = safeHref(element.getAttribute('href'))
    if (href) attributes.push(['href', href])
  }
  if (element.tagName === 'IMG') {
    const src = safeImageSource(element.getAttribute('src'))
    if (src) attributes.push(['src', src])
    preserveTextAttribute(element, attributes, 'alt', 500)
    preserveTextAttribute(element, attributes, 'title', 500)
    preserveNumberAttribute(element, attributes, 'width')
    preserveNumberAttribute(element, attributes, 'height')
  }
  if (element.tagName === 'TD' || element.tagName === 'TH') {
    preserveNumberAttribute(element, attributes, 'colspan')
    preserveNumberAttribute(element, attributes, 'rowspan')
  }
  preserveEnumAttribute(element, attributes, 'data-type', ['taskList', 'taskItem'])
  preserveEnumAttribute(element, attributes, 'data-checked', ['true', 'false'])
  preserveEnumAttribute(element, attributes, 'data-word-page-break', ['true'])
  preserveTextAttribute(element, attributes, 'data-word-footnote-id', 80)
  preserveNumberAttribute(element, attributes, 'data-word-footnote-number')
  preserveTextAttribute(element, attributes, 'data-word-footnote-text', 2_000)
  preserveTextAttribute(element, attributes, 'data-word-citation-id', 80)
  preserveTextAttribute(element, attributes, 'data-word-citation-text', 500)
  preserveNumberAttribute(element, attributes, 'data-word-indent')
  preserveEnumAttribute(element, attributes, 'data-word-toc', ['true'])
  preserveEnumAttribute(element, attributes, 'data-word-toc-title', ['true'])
  preserveNumberAttribute(element, attributes, 'data-word-toc-level')
  return attributes
}

function sanitizedStyle(value: string | null): string {
  if (!value) return ''
  const source = document.createElement('span')
  source.setAttribute('style', value)
  const clean = document.createElement('span')
  for (const property of ALLOWED_STYLE_PROPERTIES) {
    const propertyValue = source.style.getPropertyValue(property)
    if (propertyValue && !/[;{}]/.test(propertyValue)) clean.style.setProperty(property, propertyValue)
  }
  return clean.getAttribute('style') ?? ''
}

function preserveEnumAttribute(element: Element, target: Array<[string, string]>, name: string, allowed: string[]): void {
  const value = element.getAttribute(name)
  if (value && allowed.includes(value)) target.push([name, value])
}

function preserveTextAttribute(element: Element, target: Array<[string, string]>, name: string, maxLength: number): void {
  const value = (element.getAttribute(name) ?? '').trim().slice(0, maxLength)
  if (value) target.push([name, value])
}

function preserveNumberAttribute(element: Element, target: Array<[string, string]>, name: string): void {
  const value = Number(element.getAttribute(name))
  if (Number.isFinite(value) && value > 0) target.push([name, String(Math.round(value))])
}

function safeHref(value: string | null): string | null {
  if (!value) return null
  return /^(https?:|mailto:)/i.test(value.trim()) ? value.trim() : null
}

function safeImageSource(value: string | null): string | null {
  if (!value) return null
  const source = value.trim()
  if (/^https:\/\//i.test(source)) return source
  return /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(source) ? source : null
}

function normalizedReferenceId(value: string): string {
  return value.trim().replace(/[^a-z0-9_-]/gi, '').slice(0, 80)
}

function normalizedReferenceText(value: string): string {
  return value.trim().slice(0, 2_000)
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function isAppendBlock(value: unknown): value is WordAppendBlock {
  return value === 'paragraph' || value === 'heading1' || value === 'heading2' || value === 'quote'
}

const WORD_FORMATTING_COMMANDS = new Set<WordFormattingCommand>([
  'bold', 'copy', 'cut', 'decreaseFontSize', 'fontName', 'fontSize', 'foreColor', 'formatBlock', 'hiliteColor',
  'increaseFontSize', 'indent', 'insertHorizontalRule', 'insertOrderedList', 'insertUnorderedList',
  'italic', 'justifyCenter', 'justifyFull', 'justifyLeft', 'justifyRight', 'letterSpacing', 'lineHeight',
  'outdent', 'paste', 'redo', 'removeFormat', 'strikeThrough', 'subscript', 'superscript', 'toggleCase',
  'toggleTaskList', 'underline', 'undo', 'uppercase',
])

const WORD_TABLE_ACTIONS = new Set<WordTableAction>([
  'addColumnAfter', 'addColumnBefore', 'addRowAfter', 'addRowBefore', 'deleteColumn', 'deleteRow',
  'deleteTable',
])

function validateWordEditorCommand(command: Record<string, unknown>): WordEditorCommand | null {
  if (command.type === 'editor.format') {
    if (typeof command.action !== 'string' || !WORD_FORMATTING_COMMANDS.has(command.action as WordFormattingCommand)) return null
    if (command.value !== undefined && typeof command.value !== 'string') return null
    return { type: 'editor.format', action: command.action as WordFormattingCommand, ...(typeof command.value === 'string' ? { value: command.value.slice(0, 500) } : {}) }
  }
  if (command.type === 'editor.table') {
    if (typeof command.action !== 'string' || !WORD_TABLE_ACTIONS.has(command.action as WordTableAction)) return null
    return { type: 'editor.table', action: command.action as WordTableAction }
  }
  if (command.type === 'editor.reference.remove') {
    if ((command.kind !== 'citation' && command.kind !== 'footnote') || typeof command.id !== 'string') return null
    const id = normalizedReferenceId(command.id)
    return id ? { type: 'editor.reference.remove', kind: command.kind, id } : null
  }
  if (command.type === 'editor.reference.update') {
    if ((command.kind !== 'citation' && command.kind !== 'footnote') || typeof command.id !== 'string' || typeof command.text !== 'string') return null
    const id = normalizedReferenceId(command.id)
    const text = normalizedReferenceText(command.text)
    return id && text ? { type: 'editor.reference.update', kind: command.kind, id, text } : null
  }
  if (command.type !== 'editor.insert' || typeof command.kind !== 'string') return null
  if (command.kind === 'pageBreak') return { type: 'editor.insert', kind: 'pageBreak' }
  if (command.kind === 'html') return typeof command.html === 'string' ? { type: 'editor.insert', kind: 'html', html: sanitizeWordHtml(command.html) } : null
  if (command.kind === 'link') {
    const href = typeof command.href === 'string' ? safeHref(command.href) : null
    return href ? { type: 'editor.insert', kind: 'link', href } : null
  }
  if (command.kind === 'image') {
    const src = typeof command.src === 'string' ? safeImageSource(command.src) : null
    if (!src || (command.alt !== undefined && typeof command.alt !== 'string') || (command.title !== undefined && typeof command.title !== 'string')) return null
    return { type: 'editor.insert', kind: 'image', src, ...(typeof command.alt === 'string' ? { alt: command.alt.slice(0, 500) } : {}), ...(typeof command.title === 'string' ? { title: command.title.slice(0, 500) } : {}) }
  }
  if (command.kind === 'table') {
    if (!positiveBoundedInteger(command.rows, 1, 50) || !positiveBoundedInteger(command.cols, 1, 20)) return null
    if (command.withHeaderRow !== undefined && typeof command.withHeaderRow !== 'boolean') return null
    return { type: 'editor.insert', kind: 'table', rows: command.rows, cols: command.cols, ...(typeof command.withHeaderRow === 'boolean' ? { withHeaderRow: command.withHeaderRow } : {}) }
  }
  if (command.kind === 'tableOfContents') {
    if (typeof command.title !== 'string' || !Array.isArray(command.entries) || command.entries.length > 500) return null
    const entries = command.entries.flatMap((entry): WordTableOfContentsEntry[] => {
      if (!isRecord(entry) || !positiveBoundedInteger(entry.level, 1, 3) || typeof entry.text !== 'string') return []
      const text = entry.text.trim().slice(0, 500)
      return text ? [{ level: entry.level, text }] : []
    })
    return { type: 'editor.insert', kind: 'tableOfContents', title: command.title.trim().slice(0, 200), entries }
  }
  if (command.kind === 'footnote') {
    if (typeof command.id !== 'string' || typeof command.text !== 'string' || !positiveBoundedInteger(command.number, 1, 100_000)) return null
    const id = normalizedReferenceId(command.id)
    const text = normalizedReferenceText(command.text)
    return id && text ? { type: 'editor.insert', kind: 'footnote', id, number: command.number, text } : null
  }
  if (command.kind === 'citation') {
    if (typeof command.id !== 'string' || typeof command.text !== 'string') return null
    const id = normalizedReferenceId(command.id)
    const text = normalizedReferenceText(command.text)
    return id && text ? { type: 'editor.insert', kind: 'citation', id, text } : null
  }
  return null
}

function positiveBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
}

function isPageSize(value: unknown): value is WordPageSize {
  return value === 'a4' || value === 'letter'
}

function isPageOrientation(value: unknown): value is WordPageOrientation {
  return value === 'portrait' || value === 'landscape'
}

function isPageMargins(value: unknown): value is WordPageMargins {
  return value === 'normal' || value === 'narrow' || value === 'wide'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export {}
