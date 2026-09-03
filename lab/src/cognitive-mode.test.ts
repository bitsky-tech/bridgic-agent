import { describe, expect, test } from 'bun:test'
import type { JsonObject, JsonValue, OtaRound } from './api'
import { resolveRoundCognitiveMode } from './cognitive-mode'

function round(raw: JsonObject = {}, toolName?: string, toolResult: JsonValue = null): OtaRound {
  return {
    id: 'round-1',
    ordinal: 1,
    observationResult: null,
    thinkResult: null,
    permission: null,
    actionResult: toolName
      ? {
        results: [{
          toolId: 'call-1',
          toolName,
          toolArguments: {},
          toolResult,
          success: true,
          error: null,
          raw: {},
        }],
        raw: {},
      }
      : null,
    durationMs: null,
    raw,
  }
}

describe('resolveRoundCognitiveMode', () => {
  test('labels a root normal round as the general Agent', () => {
    expect(resolveRoundCognitiveMode(round({ build_stage: null }), {
      agentState: { think: { mode: 'normal', stage: 'main' } },
    })).toEqual({ id: 'general-agent', mode: 'normal', stage: 'main' })
  })

  test('uses the Session relationship for a Child Agent', () => {
    expect(resolveRoundCognitiveMode(round(), {
      agentState: { think: { mode: 'normal', stage: 'main' } },
      parentSessionId: 'parent-session',
    })).toEqual({ id: 'child-agent', mode: 'normal', stage: 'child' })
  })

  test.each(['clarify', 'explore', 'generate', 'verify'] as const)(
    'uses the per-round think_scope marker for Build %s',
    (stage) => {
      expect(resolveRoundCognitiveMode(round({ think_scope: { mode: 'build', stage } }), {
        agentState: { think: { mode: 'build', stage: 'verify' } },
      })).toEqual({ id: `build-${stage}`, mode: 'build', stage })
    },
  )

  test('uses the per-round think_scope marker for Workflow execution', () => {
    expect(resolveRoundCognitiveMode(round({ think_scope: { mode: 'run_workflow', stage: 'execute' } }), {
      agentState: { think: { mode: 'run_workflow', stage: 'execute' } },
    })).toEqual({ id: 'workflow-execute', mode: 'run_workflow', stage: 'execute' })
  })

  test('does not apply a later Turn-level mode to a scoped normal round', () => {
    expect(resolveRoundCognitiveMode(round({ think_scope: { mode: 'normal', stage: 'main' } }), {
      agentState: { think: { mode: 'build', stage: 'explore' } },
    })).toEqual({ id: 'general-agent', mode: 'normal', stage: 'main' })
  })

  test('keeps supporting the legacy per-round Build marker', () => {
    expect(resolveRoundCognitiveMode(round({ build_stage: 'generate' }), {
      agentState: { think: { mode: 'build', stage: 'verify' } },
    })).toEqual({ id: 'build-generate', mode: 'build', stage: 'generate' })
  })

  test('does not apply a later Turn-level Build stage to a marked normal round', () => {
    expect(resolveRoundCognitiveMode(round({ build_stage: null }), {
      agentState: { think: { mode: 'build', stage: 'explore' } },
    })).toEqual({ id: 'general-agent', mode: 'normal', stage: 'main' })
  })

  test('supports legacy Build rounds without a per-round marker', () => {
    expect(resolveRoundCognitiveMode(round(), {
      agentState: { think: { mode: 'build', stage: 'generate' } },
    })).toEqual({ id: 'build-generate', mode: 'build', stage: 'generate' })
  })

  test('uses the Turn-level Workflow mode for an active execution round', () => {
    expect(resolveRoundCognitiveMode(round({ build_stage: null }), {
      agentState: { think: { mode: 'run_workflow', stage: 'execute' } },
    })).toEqual({ id: 'workflow-execute', mode: 'run_workflow', stage: 'execute' })
  })

  test('identifies Workflow execution from a persisted step report', () => {
    expect(resolveRoundCognitiveMode(
      round({ build_stage: null }, 'report_workflow_step', { status: 'success' }),
      { agentState: { think: { mode: 'run_workflow', stage: 'execute' } } },
    )).toEqual({ id: 'workflow-execute', mode: 'run_workflow', stage: 'execute' })
  })
})
