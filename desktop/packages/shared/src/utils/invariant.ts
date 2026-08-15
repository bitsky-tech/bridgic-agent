export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invariant failed: ${message}`)
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`)
}
