import { createServer as createViteServer } from 'vite'

import { startApiServer } from './api'
import { LAB_HOST, readApiPort, readLabPort } from './constants'

const labPort = readLabPort()
const apiPort = readApiPort()
process.env.BRIDGIC_AGENT_LAB_API_PORT = String(apiPort)

const api = startApiServer({ port: apiPort })
const vite = await createViteServer()

try {
  await vite.listen()
  console.log(`[Bridgic Agent Lab] Local data API: http://${LAB_HOST}:${apiPort}`)
  vite.printUrls()
} catch (error) {
  await api.stop()
  throw error
}

let stopping = false
const shutdown = async (): Promise<void> => {
  if (stopping) return
  stopping = true
  // Release the dedicated API port first. Vite may wait for an open HMR
  // connection during close, but that must never leave the data service behind.
  await api.stop()
  await vite.close()
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

if (labPort !== vite.config.server.port) {
  console.warn(`[Bridgic Agent Lab] Requested UI port ${labPort}, Vite is using ${vite.config.server.port}.`)
}
