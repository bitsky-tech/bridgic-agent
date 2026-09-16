export interface ToolExecutionInput {
  toolName: string
  arguments: Record<string, unknown>
}

export interface DesktopDebugToolResponse {
  sessionId: string
  durationMs: number
  result: {
    tool_id: string
    tool_name: string
    tool_arguments: Record<string, unknown>
    tool_result: unknown
    success: boolean
    error: string | null
  }
}
