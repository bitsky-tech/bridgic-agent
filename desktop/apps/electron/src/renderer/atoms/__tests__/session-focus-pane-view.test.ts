import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  applyAgentEventAtom,
  streamingFamily,
  thinkingModeFamily,
  workflowRunFamily,
} from '@/atoms/agent'
import { briefFamily } from '@/atoms/build'
import {
  currentSessionModeExitCollapseRequestAtom,
  setSessionFocusPaneAtom,
} from '@/atoms/session-focus-pane'
import { activeSessionIdAtom } from '@/atoms/sessions'
import {
  openSessionModeSurfaceAtom,
  selectedSessionModeSurfaceAtom,
  SessionModeSurfaceKind,
  sessionFocusPaneOpenAtom,
  sessionModeSurfaceAtom,
} from '@/atoms/session-focus-pane-view'

function enterBuild(store: ReturnType<typeof createStore>, sessionId: string): void {
  store.set(applyAgentEventAtom, {
    sessionId,
    event: { type: 'stage', position: { mode: 'build', stage: 'clarify' } },
  })
  store.set(briefFamily(sessionId), '# Task\nBuild a Workflow')
}

function enterRun(
  store: ReturnType<typeof createStore>,
  sessionId: string,
  generation: string,
): void {
  store.set(applyAgentEventAtom, {
    sessionId,
    event: { type: 'stage', position: { mode: 'run_workflow', stage: 'execute' } },
  })
  store.set(workflowRunFamily(sessionId), {
    workflowId: 'wf-mode-surface',
    generation,
    workflowName: '模式表面测试',
    sourceSessionId: sessionId,
    phase: 'execute',
    stepIndex: 0,
    executionSteps: ['执行一步'],
  })
}

function enterPresentation(store: ReturnType<typeof createStore>, sessionId: string): void {
  store.set(applyAgentEventAtom, {
    sessionId,
    event: { type: 'stage', position: { mode: 'presentation', stage: 'ppt_brief' } },
  })
}

describe('Session mode surface exit ownership', () => {
  it('selects the dedicated Agent surface throughout presentation mode', () => {
    const store = createStore()
    const sessionId = 'session-presentation-owned'
    store.set(activeSessionIdAtom, sessionId)
    enterPresentation(store, sessionId)

    expect(store.get(sessionModeSurfaceAtom)).toBe(SessionModeSurfaceKind.Presentation)
    store.set(openSessionModeSurfaceAtom)
    expect(store.get(selectedSessionModeSurfaceAtom)).toBe(SessionModeSurfaceKind.Presentation)

    store.set(applyAgentEventAtom, {
      sessionId,
      event: { type: 'stage', position: { mode: 'presentation', stage: 'ppt_compose' } },
    })
    expect(store.get(selectedSessionModeSurfaceAtom)).toBe(SessionModeSurfaceKind.Presentation)
  })

  it('closes and requests collapse when presentation mode exits from its Agent pane', () => {
    const store = createStore()
    const sessionId = 'session-presentation-exit'
    store.set(activeSessionIdAtom, sessionId)
    enterPresentation(store, sessionId)
    store.set(openSessionModeSurfaceAtom)

    store.set(applyAgentEventAtom, {
      sessionId,
      event: { type: 'stage', position: { mode: 'normal', stage: null } },
    })

    expect(store.get(sessionModeSurfaceAtom)).toBeNull()
    expect(store.get(selectedSessionModeSurfaceAtom)).toBeNull()
    expect(store.get(currentSessionModeExitCollapseRequestAtom)).toBe(true)
  })

  it('closes and requests collapse when Build exits while its Agent pane is foreground', () => {
    const store = createStore()
    const sessionId = 'session-build-owned'
    store.set(activeSessionIdAtom, sessionId)
    enterBuild(store, sessionId)
    store.set(openSessionModeSurfaceAtom)
    expect(store.get(selectedSessionModeSurfaceAtom)).toBe(SessionModeSurfaceKind.Task)

    store.set(applyAgentEventAtom, {
      sessionId,
      event: { type: 'stage', position: { mode: 'normal', stage: null } },
    })

    expect(store.get(sessionModeSurfaceAtom)).toBeNull()
    expect(store.get(selectedSessionModeSurfaceAtom)).toBeNull()
    expect(store.get(sessionFocusPaneOpenAtom)).toBe(false)
    expect(store.get(currentSessionModeExitCollapseRequestAtom)).toBe(true)
  })

  it('does not request collapse when the user moved from Build to a workbench tool', () => {
    const store = createStore()
    const sessionId = 'session-build-user-tool'
    store.set(activeSessionIdAtom, sessionId)
    enterBuild(store, sessionId)
    store.set(openSessionModeSurfaceAtom)
    store.set(setSessionFocusPaneAtom, null)

    store.set(applyAgentEventAtom, {
      sessionId,
      event: { type: 'stage', position: { mode: 'normal', stage: null } },
    })

    expect(store.get(sessionModeSurfaceAtom)).toBeNull()
    expect(store.get(currentSessionModeExitCollapseRequestAtom)).toBe(false)
  })

  it('closes and requests collapse for successful, failed, and paused Run exits', () => {
    for (const outcome of ['success', 'failure', 'pause'] as const) {
      const store = createStore()
      const sessionId = `session-run-${outcome}`
      store.set(activeSessionIdAtom, sessionId)
      enterRun(store, sessionId, `generation-${outcome}`)
      store.set(openSessionModeSurfaceAtom)

      if (outcome !== 'pause') {
        store.set(streamingFamily(sessionId), {
          messageId: `message-${outcome}`,
          content: '',
          toolCalls: [],
          blocks: [],
          startedAt: Date.now(),
        })
        store.set(applyAgentEventAtom, {
          sessionId,
          event: {
            type: 'workflow_result',
            runId: `run-${outcome}`,
            workflowId: 'wf-mode-surface',
            workflowName: '模式表面测试',
            status: outcome === 'success' ? 'completed' : 'failed',
            createdAt: '2026-08-13T08:00:00Z',
          },
        })
      }

      store.set(applyAgentEventAtom, {
        sessionId,
        event: { type: 'stage', position: { mode: 'normal', stage: null } },
      })

      expect(store.get(sessionModeSurfaceAtom)).toBeNull()
      expect(store.get(selectedSessionModeSurfaceAtom)).toBeNull()
      expect(store.get(currentSessionModeExitCollapseRequestAtom)).toBe(true)
    }
  })

  it('preserves a user workbench takeover when Run exits', () => {
    const store = createStore()
    const sessionId = 'session-run-user-tool'
    store.set(activeSessionIdAtom, sessionId)
    enterRun(store, sessionId, 'generation-user-tool')
    store.set(openSessionModeSurfaceAtom)
    store.set(setSessionFocusPaneAtom, null)

    store.set(applyAgentEventAtom, {
      sessionId,
      event: { type: 'stage', position: { mode: 'normal', stage: null } },
    })

    expect(store.get(currentSessionModeExitCollapseRequestAtom)).toBe(false)
  })

  it('treats Agent as foreground owner again after the user switches away and back', () => {
    const store = createStore()
    const sessionId = 'session-run-returned-to-agent'
    store.set(activeSessionIdAtom, sessionId)
    enterRun(store, sessionId, 'generation-returned')
    store.set(openSessionModeSurfaceAtom)
    store.set(setSessionFocusPaneAtom, null)
    store.set(openSessionModeSurfaceAtom)

    store.set(applyAgentEventAtom, {
      sessionId,
      event: { type: 'stage', position: { mode: 'normal', stage: null } },
    })

    expect(store.get(currentSessionModeExitCollapseRequestAtom)).toBe(true)
  })

  it('keeps exit collapse requests scoped to their Session', () => {
    const store = createStore()
    enterBuild(store, 'session-a')
    store.set(activeSessionIdAtom, 'session-a')
    store.set(openSessionModeSurfaceAtom)
    store.set(applyAgentEventAtom, {
      sessionId: 'session-a',
      event: { type: 'stage', position: { mode: 'normal', stage: null } },
    })
    expect(store.get(currentSessionModeExitCollapseRequestAtom)).toBe(true)

    store.set(activeSessionIdAtom, 'session-b')
    store.set(thinkingModeFamily('session-b'), { mode: 'normal', stage: null })
    expect(store.get(currentSessionModeExitCollapseRequestAtom)).toBe(false)
  })
})
