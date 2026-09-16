export type PromptJson = null | boolean | number | string | PromptJson[] | { [key: string]: PromptJson }

/** A request assembled by the current Cognitive worker for a selected round. */
export interface CognitiveRequest {
  schemaVersion: 1
  kind: 'cognitive'
  providerId: string | null
  modelId: string | null
  protocol: string | null
  messages: PromptJson[]
  tools: PromptJson[]
  extraBody: PromptJson
}

export interface PromptAssemblyInput {
  turnId: string
  roundIndex: number
  mode: string
  stage: string
}

export interface DesktopDebugPrompt {
  id: string
  turnId: string
  turnOrdinal: number
  roundIndex: number
  stage: string | null
  mode: string | null
  availability: 'pending' | 'assembled'
  request: CognitiveRequest | null
}

export interface DesktopDebugPromptResponse {
  sessionId: string
  item: DesktopDebugPrompt & { availability: 'assembled'; request: CognitiveRequest }
}
