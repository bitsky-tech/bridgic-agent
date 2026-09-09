import { describe, expect, it } from 'bun:test'
import {
  hasOfficeBackgroundContent,
  OFFICE_APP_KINDS,
  projectOfficeSurfaceStatuses,
} from '../office/officeSurfaceStatus'

const input = {
  sessionId: 'session-a',
  powerPointSession: null,
  excelSession: null,
  wordSession: null,
  powerPointAgentActive: false,
  powerPointNeedsAttention: false,
}
const ppt = {
  sessionId: 'session-a', targetId: 'ppt-a', webContentsId: 1, loading: false, crashed: false,
}
const excel = {
  sessionId: 'session-a', targetId: 'excel-a', webContentsId: 2, ready: true, crashed: false, dirty: false,
}

const word = {
  sessionId: 'session-a', targetId: 'word-a', webContentsId: 3, loading: false, crashed: false,
  documentCount: 1, persistenceStatus: 'saved' as const, expanded: false,
}

describe('Office shell status compatibility contract', () => {
  it('keeps unknown Word counts separate from a reported empty workspace', () => {
    const unknown = projectOfficeSurfaceStatuses(input).word
    const empty = projectOfficeSurfaceStatuses({ ...input, wordSession: { ...word, documentCount: 0 } }).word
    expect(unknown.documentCount).toBeNull()
    expect(empty.documentCount).toBe(0)
    expect(hasOfficeBackgroundContent(unknown)).toBe(false)
    expect(hasOfficeBackgroundContent(empty)).toBe(false)
  })

  it('counts a blank Word document as open in its native Session target', () => {
    const status = projectOfficeSurfaceStatuses({ ...input, wordSession: word }).word
    expect(hasOfficeBackgroundContent(status)).toBe(true)
    expect(status.hasNativeTarget).toBe(true)
    expect(status.runtimeState).toBe('ready')
  })


  it('waits for restored Word inventory instead of treating the loading target as a document', () => {
    const status = projectOfficeSurfaceStatuses({
      ...input, wordSession: { ...word, loading: true, documentCount: null, persistenceStatus: null },
    }).word
    expect(status.hasNativeTarget).toBe(true)
    expect(status.runtimeState).toBe('loading')
    expect(status.documentInventory).toBe('pending')
    expect(hasOfficeBackgroundContent(status)).toBe(false)
    const crashed = projectOfficeSurfaceStatuses({ ...input, wordSession: { ...word, crashed: true } }).word
    expect(crashed.runtimeState).toBe('crashed')
    expect(hasOfficeBackgroundContent(crashed)).toBe(true)
  })

  it('retains native background markers without fabricating PPT or Excel document counts', () => {
    const statuses = projectOfficeSurfaceStatuses({ ...input, powerPointSession: ppt, excelSession: excel })
    for (const kind of ['presentation', 'excel'] as const) {
      expect(hasOfficeBackgroundContent(statuses[kind])).toBe(true)
      expect(statuses[kind].documentCount).toBeNull()
      expect(statuses[kind].runtimeState).toBe('ready')
    }
  })

  it('rejects native inventories owned by a different Session', () => {
    const statuses = projectOfficeSurfaceStatuses({ ...input, sessionId: 'session-b', powerPointSession: ppt, excelSession: excel, wordSession: word })
    for (const kind of OFFICE_APP_KINDS) {
      expect(hasOfficeBackgroundContent(statuses[kind])).toBe(false)
      expect(statuses[kind].runtimeState).toBe('closed')
    }
  })

  it('does not turn native loading or dirty data into Agent execution or unseen activity', () => {
    const statuses = projectOfficeSurfaceStatuses({
      ...input,
      powerPointSession: { ...ppt, loading: true },
      excelSession: { ...excel, ready: false, dirty: true },
    })
    expect(statuses.presentation.runtimeState).toBe('loading')
    expect(statuses.presentation.agentActivity).toBe('idle')
    expect(statuses.presentation.needsAttention).toBe(false)
    expect(statuses.excel.runtimeState).toBe('loading')
    expect(statuses.excel.agentActivity).toBe('unavailable')
    expect(statuses.excel.needsAttention).toBeNull()
    expect(statuses.excel.dirty).toBe(true)
    expect(statuses.word.agentActivity).toBe('unavailable')
    expect(statuses.word.dirty).toBeNull()
  })

  it('keeps failed native targets discoverable and gives crash state priority over loading', () => {
    const statuses = projectOfficeSurfaceStatuses({
      ...input,
      powerPointSession: { ...ppt, loading: true, crashed: true },
      excelSession: { ...excel, crashed: true },
    })
    for (const kind of ['presentation', 'excel'] as const) {
      expect(statuses[kind].runtimeState).toBe('crashed')
      expect(hasOfficeBackgroundContent(statuses[kind])).toBe(true)
    }
  })

  it('keeps PPT Agent activity and attention independent, even before target creation', () => {
    const status = projectOfficeSurfaceStatuses({ ...input, powerPointAgentActive: true, powerPointNeedsAttention: true }).presentation
    expect(status.agentActivity).toBe('active')
    expect(status.needsAttention).toBe(true)
    expect(status.runtimeState).toBe('closed')
    expect(hasOfficeBackgroundContent(status)).toBe(false)
  })

  it('shows no Session content outside a Session view', () => {
    const statuses = projectOfficeSurfaceStatuses({
      ...input, sessionId: null, powerPointSession: ppt, excelSession: excel,
      wordSession: word, powerPointAgentActive: true, powerPointNeedsAttention: true,
    })
    for (const kind of OFFICE_APP_KINDS) {
      expect(statuses[kind].sessionId).toBeNull()
      expect(hasOfficeBackgroundContent(statuses[kind])).toBe(false)
      expect(statuses[kind].agentActivity).not.toBe('active')
      expect(statuses[kind].needsAttention).not.toBe(true)
    }
  })

  it('uses authoritative document counts ahead of the legacy native-target fallback', () => {
    const status = projectOfficeSurfaceStatuses({ ...input, powerPointSession: ppt }).presentation
    expect(hasOfficeBackgroundContent({ ...status, documentCount: 0 })).toBe(false)
    expect(hasOfficeBackgroundContent({ ...status, documentCount: 2 })).toBe(true)
  })
})
