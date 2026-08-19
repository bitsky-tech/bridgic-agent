import { homedir } from 'node:os'
import { join } from 'node:path'

export const LAB_HOST = '127.0.0.1'
export const DEFAULT_LAB_PORT = 4319

export const BRIDGIC_AGENT_STATE_DB = join(
  homedir(),
  '.bridgic',
  'AmphiAgent',
  'state.db',
)

export function readLabPort(): number {
  const configuredPort = Number(process.env.BRIDGIC_AGENT_LAB_PORT)
  return Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
    ? configuredPort
    : DEFAULT_LAB_PORT
}

export function readApiPort(): number {
  const configuredPort = Number(process.env.BRIDGIC_AGENT_LAB_API_PORT)
  if (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535) {
    return configuredPort
  }

  const candidate = readLabPort() + 1
  return candidate <= 65_535 ? candidate : DEFAULT_LAB_PORT + 1
}
