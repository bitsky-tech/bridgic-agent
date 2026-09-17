import { createHash } from 'node:crypto'
import { mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, isAbsolute } from 'node:path'
import type { OfficeFileKind, OfficeFileSaveRequest, OfficeFileSource } from '../shared/office-files'
import { inspectOfficeFile, OFFICE_EXTENSIONS, officePath, saveOfficeFile, writeOfficeBytes } from './office-files'

type Mount = { path: string; kind: string; removable?: boolean }
interface WriteReceipt { source: OfficeFileSource; fingerprint: string }
const fingerprint = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const isWithin = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}

export function createOfficeWorkspaceFiles(request: (path: string, body?: unknown) => Promise<unknown>, changed: (sessionId: string) => void) {
  const imports = new Map<string, Promise<OfficeFileSource>>()
  const mountsPath = (id: string) => `/sessions/${encodeURIComponent(id)}/mounts`
  const workDir = async (id: string) => {
    const mounts = await request(mountsPath(id)) as Mount[]
    const work = mounts.find((mount) => mount.kind === 'folder' && mount.removable === false && basename(mount.path) === '.work')
    if (!work) throw new Error('The Session workspace is unavailable')
    return realpath(work.path)
  }
  const register = async (id: string, path: string) => {
    const mount = await request(mountsPath(id), { path }) as Mount
    if (!mount || typeof mount.path !== 'string') throw new Error('The imported Office file was not registered')
    changed(id)
    return mount.path
  }
  const prepare = (id: string, kind: OfficeFileKind, path: string): Promise<OfficeFileSource> => {
    officePath(kind, path)
    const key = `${id}:${kind}:${path}`
    let pending = imports.get(key)
    if (!pending) {
      pending = (async () => {
        const source = await inspectOfficeFile(kind, path)
        if (source.mtimeMs === null) {
          const work = await workDir(id)
          if (!isWithin(work, source.path)) throw new Error('New Office files must be created in the Session workspace')
          return source
        }
        return inspectOfficeFile(kind, await register(id, source.path))
      })()
      imports.set(key, pending)
      void pending.finally(() => { if (imports.get(key) === pending) imports.delete(key) }).catch(() => undefined)
    }
    return pending
  }
  return {
    prepare,
    async save(id: string, input: OfficeFileSaveRequest) {
      if (input.destination) throw new Error('Office edits save to the current Session file; a separate destination is not supported')
      if (!input.documentId) throw new Error('An Office file requires a document identity')
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > 150 * 1024 * 1024) throw new TypeError('Invalid Office file payload')
      const key = `${id}:${input.kind}:${input.documentId}`
      const root = await workDir(id)
      const receiptPath = join(dirname(root), '.internal', 'office', 'writes', `${fingerprint(new TextEncoder().encode(key))}.json`)
      const readReceipt = async (): Promise<WriteReceipt | null> => {
        try {
          const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as WriteReceipt
          if (!receipt?.source || typeof receipt.source.path !== 'string'
            || !isWithin(root, receipt.source.path)
            || (receipt.source.mtimeMs !== null && !Number.isFinite(receipt.source.mtimeMs))
            || typeof receipt.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)) throw new Error('The Office write receipt is invalid')
          officePath(input.kind, receipt.source.path)
          return receipt
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      }
      let source = input.source
      if (source && !isWithin(root, source.path)) source = await prepare(id, input.kind, source.path)
      let allocated: string | undefined
      const receipt = !source || (await inspectOfficeFile(input.kind, source.path)).mtimeMs !== source.mtimeMs ? await readReceipt() : null
      if (!source && receipt) source = receipt.source
      if (!source) {
        const extension = OFFICE_EXTENSIONS[input.kind]
        const name = basename(input.suggestedName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || `Untitled${extension}`
        const stem = extname(name).toLowerCase() === extension ? name.slice(0, -extension.length) : name
        for (let ordinal = 1; !source; ordinal++) {
          const path = join(root, `${stem}${ordinal === 1 ? '' : ` (${ordinal})`}${extension}`)
          try {
            const file = await open(path, 'wx', 0o600)
            await file.close()
            source = await inspectOfficeFile(input.kind, path)
            allocated = path
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        }
      }
      if (receipt?.source.path === source.path) {
        const current = await inspectOfficeFile(input.kind, source.path)
        // A durable intent identifies both an unstarted write and a completed atomic
        // replacement whose acknowledgement never reached the renderer.
        if (current.mtimeMs === receipt.source.mtimeMs
          || (current.mtimeMs !== null && fingerprint(await readFile(current.path)) === receipt.fingerprint)) source = current
      }
      // Persist before replacing the file, so a restart can also recover a new file's
      // allocated name without making a duplicate or trusting a stale renderer mtime.
      try {
        await mkdir(dirname(receiptPath), { recursive: true })
        await writeOfficeBytes(receiptPath, JSON.stringify({ source, fingerprint: fingerprint(input.bytes) } satisfies WriteReceipt))
      } catch (error) {
        if (allocated) await unlink(allocated).catch(() => undefined)
        throw error
      }
      const result = await saveOfficeFile({ ...input, source, destination: undefined, preserveSource: false }, source.path)
      if (result.ok) {
        try { await register(id, result.source.path) } catch (error) {
          throw new Error(`The Office file was saved, but its Session file entry could not be updated. Retry to finish registration: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return result
    },
  }
}
