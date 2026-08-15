/**
 * Singleton PythonClient instance.
 *
 * Created at module load time so other main-process modules can simply
 * `import { pythonClient } from './python-client'` without having to
 * pass a reference through constructors.
 *
 * `start()` MUST be called from `main/index.ts`'s `app.whenReady()`
 * after handlers are registered (so renderer IPC can receive state
 * broadcasts immediately).
 */
export { PythonClient, BackendBinaryMissing } from './PythonClient'
export type {
  BackendState,
  BackendEndpoint,
  BackendSnapshot,
  StatusJson,
} from './types'

import { PythonClient } from './PythonClient'

export const pythonClient = new PythonClient()
