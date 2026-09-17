import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type { OfficeFileKind, OfficeFileSaveRequest, OfficeFileSaveResult, OfficeFileSource } from '../shared/office-files'

export const OFFICE_EXTENSIONS = { word: '.docx', excel: '.xlsx', presentation: '.pptx' } as const

export function officePath(kind: OfficeFileKind, path: string): string {
  if (!Object.hasOwn(OFFICE_EXTENSIONS, kind) || typeof path !== 'string' || !isAbsolute(path)
    || extname(path).toLowerCase() !== OFFICE_EXTENSIONS[kind]) throw new TypeError('Invalid Office file path')
  return path
}

export async function inspectOfficeFile(kind: OfficeFileKind, path: string): Promise<OfficeFileSource> {
  officePath(kind, path)
  try {
    const canonical = await realpath(path)
    const file = await stat(canonical)
    if (!file.isFile()) throw new Error('Office path is not a file')
    return { path: canonical, mtimeMs: file.mtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { path: join(await realpath(dirname(path)), basename(path)), mtimeMs: null }
  }
}

export async function writeOfficeBytes(path: string, bytes: Uint8Array | string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const mode = await stat(path).then((value) => value.mode).catch(() => 0o600)
  try {
    await writeFile(temporary, bytes, { mode })
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => undefined) }
}

/** Compare immediately before the atomic replacement; canceled saves never reach this writer. */
export async function saveOfficeFile(request: OfficeFileSaveRequest, destination: string, overwriteApproved = false): Promise<OfficeFileSaveResult> {
  officePath(request.kind, destination)
  if (!(request.bytes instanceof Uint8Array) || request.bytes.byteLength > 150 * 1024 * 1024) throw new TypeError('Invalid Office file payload')
  const current = await inspectOfficeFile(request.kind, destination)
  if (request.preserveSource && request.source) {
    const source = await inspectOfficeFile(request.kind, request.source.path)
    if (source.path === current.path) return { ok: false, reason: 'source-protected' }
  }
  if (!overwriteApproved) {
    const expected = request.destination ? null : request.source?.mtimeMs
    if (expected === undefined || current.mtimeMs !== expected) return { ok: false, reason: 'conflict' }
  }
  await writeOfficeBytes(current.path, request.bytes)
  return { ok: true, source: await inspectOfficeFile(request.kind, current.path), fileName: basename(current.path) }
}

/** Private recovery files are separate from user documents and survive application restart. */
export function createOfficeRecoveryStore(root: string) {
  const pending = new Map<string, Promise<void>>()
  const pathFor = (kind: OfficeFileKind, sessionId: string) => {
    if (!Object.hasOwn(OFFICE_EXTENSIONS, kind) || typeof sessionId !== 'string' || !sessionId) throw new TypeError('Invalid Office recovery owner')
    return join(root, kind, `${createHash('sha256').update(sessionId).digest('hex')}.json`)
  }
  return {
    async read(kind: OfficeFileKind, sessionId: string): Promise<string | null> {
      const path = pathFor(kind, sessionId)
      await pending.get(path)
      try { return await readFile(path, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    write(kind: OfficeFileKind, sessionId: string, value: string): Promise<void> {
      if (typeof value !== 'string' || value.length > 400 * 1024 * 1024) return Promise.reject(new TypeError('Invalid Office recovery payload'))
      const path = pathFor(kind, sessionId)
      const write = (pending.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeOfficeBytes(path, value)
      })
      pending.set(path, write)
      void write.finally(() => { if (pending.get(path) === write) pending.delete(path) }).catch(() => undefined)
      return write
    },
  }
}
