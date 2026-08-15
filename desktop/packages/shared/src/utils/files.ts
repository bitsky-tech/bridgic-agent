import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJsonFileSync<T = unknown>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T
}

export function writeJsonFileSync(filePath: string, data: unknown): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

export function readJsonFileSyncOr<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback
  try {
    return readJsonFileSync<T>(filePath)
  } catch {
    return fallback
  }
}
