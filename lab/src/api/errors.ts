export type LabApiErrorKind = 'aborted' | 'network' | 'http' | 'invalid-response'

export abstract class LabApiError extends Error {
  abstract readonly kind: LabApiErrorKind

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

export class LabApiAbortError extends LabApiError {
  readonly kind = 'aborted' as const

  constructor(options?: ErrorOptions) {
    super('The Lab API request was aborted.', options)
  }
}

export class LabApiNetworkError extends LabApiError {
  readonly kind = 'network' as const

  constructor(message = 'The Lab API could not be reached.', options?: ErrorOptions) {
    super(message, options)
  }
}

export class LabApiHttpError extends LabApiError {
  readonly kind = 'http' as const

  constructor(
    readonly status: number,
    readonly statusText: string,
    message: string,
    readonly details: unknown,
    readonly url: string,
  ) {
    super(message)
  }
}

export class LabApiInvalidResponseError extends LabApiError {
  readonly kind = 'invalid-response' as const

  constructor(readonly path: string, readonly reason: string, options?: ErrorOptions) {
    super(`Invalid Lab API response at ${path}: ${reason}`, options)
  }
}

export function isLabApiError(error: unknown): error is LabApiError {
  return error instanceof LabApiError
}
