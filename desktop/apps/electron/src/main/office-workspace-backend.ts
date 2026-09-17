import { AUTH_HEADER_NAME, CLIENT_ID_HEADER, CLIENT_TYPE_HEADER } from '../shared/app-meta'
import { pythonClient } from './python-client'
import { guiClientId } from './gui-client-id'

/** Resolve workspace ownership through the same authenticated Session API as the file panel. */
export async function officeWorkspaceRequest(path: string, body?: unknown): Promise<unknown> {
  const endpoint = pythonClient.snapshot().endpoint
  if (!endpoint?.token) throw new Error('The Session service is unavailable')
  const result = await fetch(`${endpoint.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { [AUTH_HEADER_NAME]: `Bearer ${endpoint.token}`, [CLIENT_ID_HEADER]: guiClientId(), [CLIENT_TYPE_HEADER]: 'gui', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!result.ok) throw new Error(`Unable to access the Session files (HTTP ${result.status})`)
  return result.json()
}
