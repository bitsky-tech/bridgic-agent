import type { JsonObject, JsonValue, OtaRound } from './api'

export type BuildCognitiveStage = 'clarify' | 'explore' | 'generate' | 'verify'
export type WorkflowCognitiveStage = 'execute'

export type CognitiveModeDescriptor =
  | { id: 'general-agent'; mode: 'normal'; stage: 'main' }
  | { id: 'child-agent'; mode: 'normal'; stage: 'child' }
  | { id: `build-${BuildCognitiveStage}`; mode: 'build'; stage: BuildCognitiveStage }
  | { id: `workflow-${WorkflowCognitiveStage}`; mode: 'run_workflow'; stage: WorkflowCognitiveStage }

export interface CognitiveModeContext {
  agentState: JsonObject | null
  parentSessionId?: string | null
}

const BUILD_STAGES = new Set<BuildCognitiveStage>(['clarify', 'explore', 'generate', 'verify'])

function object(value: JsonValue | undefined): JsonObject | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function string(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function buildStage(value: JsonValue | undefined): BuildCognitiveStage | null {
  const stage = string(value)
  return stage && BUILD_STAGES.has(stage as BuildCognitiveStage)
    ? stage as BuildCognitiveStage
    : null
}

function isWorkflowResult(round: OtaRound): boolean {
  for (const result of round.actionResult?.results ?? []) {
    if (result.toolName !== 'report_workflow_step') continue
    return true
  }
  return false
}

function persistedThinkScope(round: OtaRound): { mode: string; stage: string } | null {
  const scope = object(round.raw.think_scope ?? round.raw.thinkScope)
  const mode = string(scope?.mode)
  const stage = string(scope?.stage)
  return mode && stage ? { mode, stage } : null
}

/** Resolve the cognitive worker that produced one persisted OTA round. */
export function resolveRoundCognitiveMode(round: OtaRound, context: CognitiveModeContext): CognitiveModeDescriptor {
  if (context.parentSessionId) {
    return { id: 'child-agent', mode: 'normal', stage: 'child' }
  }

  // Current backends persist the exact cognitive worker on every OTA round.
  // Prefer it over the Turn-level state, which only describes the final round.
  const thinkScope = persistedThinkScope(round)
  if (thinkScope) {
    const persistedBuildStage = thinkScope.mode === 'build'
      ? buildStage(thinkScope.stage)
      : null
    if (persistedBuildStage) {
      return { id: `build-${persistedBuildStage}`, mode: 'build', stage: persistedBuildStage }
    }
    if (thinkScope.mode === 'run_workflow') {
      return { id: 'workflow-execute', mode: 'run_workflow', stage: 'execute' }
    }
    return { id: 'general-agent', mode: 'normal', stage: 'main' }
  }

  // Backward compatibility for records written before think_scope existed.
  const rawBuildStage = round.raw.build_stage ?? round.raw.buildStage
  const persistedBuildStage = buildStage(rawBuildStage)
  if (persistedBuildStage) {
    return { id: `build-${persistedBuildStage}`, mode: 'build', stage: persistedBuildStage }
  }

  if (isWorkflowResult(round)) {
    return { id: 'workflow-execute', mode: 'run_workflow', stage: 'execute' }
  }

  const think = object(context.agentState?.think)
  const mode = string(think?.mode)
  const stage = string(think?.stage)
  if (mode === 'run_workflow') {
    return { id: 'workflow-execute', mode: 'run_workflow', stage: 'execute' }
  }

  // A present null marker is written by current backends for a non-Build round.
  // It prevents a later Turn-level Build stage from being applied retroactively.
  const hasBuildMarker = Object.prototype.hasOwnProperty.call(round.raw, 'build_stage')
    || Object.prototype.hasOwnProperty.call(round.raw, 'buildStage')
  if (!hasBuildMarker && mode === 'build') {
    const legacyBuildStage = buildStage(think?.stage)
    if (legacyBuildStage) {
      return { id: `build-${legacyBuildStage}`, mode: 'build', stage: legacyBuildStage }
    }
  }

  return { id: 'general-agent', mode: 'normal', stage: 'main' }
}
