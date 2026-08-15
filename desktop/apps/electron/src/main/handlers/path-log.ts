/** Record the operation without persisting any part of a private local path. */
export function redactLocalPathForLog(value: unknown): string {
  if (typeof value !== 'string') return '[invalid local path]'
  return '[local path]'
}

export function redactLocalPathLogArgs(args: readonly unknown[]): unknown {
  return [redactLocalPathForLog(args[0])]
}
