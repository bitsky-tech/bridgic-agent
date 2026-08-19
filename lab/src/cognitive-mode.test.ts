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
    'uses the per-round Build marker for %s',
    (stage) => {
      expect(resolveRoundCognitiveMode(round({ build_stage: stage }), {
        agentState: { think: { mode: 'build', stage: 'verify' } },
      })).toEqual({ id: `build-${stage}`, mode: 'build', stage })
    },
  )

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

  test.each(['execute', 'validate'] as const)(
    'uses the Turn-level Workflow stage for an active %s round',
    (stage) => {
      expect(resolveRoundCognitiveMode(round({ build_stage: null }), {
        agentState: { think: { mode: 'run_workflow', stage } },
      })).toEqual({ id: `workflow-${stage}`, mode: 'run_workflow', stage })
    },
  )

  test('prefers the Workflow phase persisted by the round result', () => {
    expect(resolveRoundCognitiveMode(
      round({ build_stage: null }, 'report_workflow_step', { phase: 'execute' }),
      { agentState: { think: { mode: 'run_workflow', stage: 'validate' } } },
    )).toEqual({ id: 'workflow-execute', mode: 'run_workflow', stage: 'execute' })
  })
})
