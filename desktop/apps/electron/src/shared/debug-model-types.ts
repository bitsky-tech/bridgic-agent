export interface DebugRoundSource {
  turnId: string
  roundIndex: number
  mode: string
  stage: string
  revision: string
}

export interface DebugModelRequest {
  model: string
  providerId: string | null
  protocol: string
  messages: Record<string, unknown>[]
  tools: Record<string, unknown>[]
  extraBody: Record<string, unknown>
}

export interface DebugPromptResponse {
  sessionId: string
  item: DebugRoundSource & {
    id: string
    turnOrdinal: number
    availability: 'assembled'
    modelSource: 'round' | 'turn' | 'current'
    boundary: 'cognitive_before_runtime_tail'
    request: Omit<DebugModelRequest, 'model' | 'extraBody'> & {
      schemaVersion: 1
      kind: 'cognitive'
      modelId: string | null
      extraBody: Record<string, unknown> | null
      worker: string
    }
  }
}

export interface DebugModelRun {
  id: string
  sessionId: string
  source: DebugRoundSource
  request: DebugModelRequest
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  content: string
  reasoning: string
  toolCalls: unknown[]
  usage: Record<string, unknown> | null
  durationMs: number | null
  error: string | null
  createdAt: string
  retries: unknown[]
}

export interface CreateDebugModelRun {
  clientRequestId: string
  source: DebugRoundSource
  request: DebugModelRequest
}
