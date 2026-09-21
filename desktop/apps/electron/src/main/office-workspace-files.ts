import { createHash } from 'node:crypto'
import { mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, isAbsolute } from 'node:path'
import type { OfficeFileKind, OfficeFileSaveRequest, OfficeFileSource } from '../shared/office-files'
import type { PresentationMountedSource, PresentationSourceMount } from '../shared/presentation-host'
import { inspectOfficeFile, OFFICE_EXTENSIONS, officePath, saveOfficeFile, writeOfficeBytes } from './office-files'

type Mount = PresentationSourceMount
interface WriteReceipt { source: OfficeFileSource; fingerprint: string }
const fingerprint = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const isWithin = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}

export function createOfficeWorkspaceFiles(request: (path: string, body?: unknown) => Promise<unknown>, changed: (sessionId: string) => void) {
  const imports = new Map<string, Promise<OfficeFileSource>>()
  const mountsPath = (id: string) => `/sessions/${encodeURIComponent(id)}/mounts`
  const workMount = async (id: string) => {
    const mounts = await request(mountsPath(id)) as Mount[]
    const work = mounts.find((mount) => mount.kind === 'folder' && mount.removable === false && basename(mount.path) === '.work')
    if (!work) throw new Error('The Session workspace is unavailable')
    return { mount: work, path: await realpath(work.path) }
  }
  const workDir = async (id: string) => (await workMount(id)).path
  const register = async (id: string, path: string): Promise<Mount> => {
    const mount = await request(mountsPath(id), { path }) as Mount
    if (!mount || typeof mount.id !== 'string' || typeof mount.path !== 'string') throw new Error('The imported Office file was not registered')
    changed(id)
    return mount
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
        return inspectOfficeFile(kind, (await register(id, source.path)).path)
      })()
      imports.set(key, pending)
      void pending.finally(() => { if (imports.get(key) === pending) imports.delete(key) }).catch(() => undefined)
    }
    return pending
  }
  const writePresentationSource = async (id: string, input: { dataBase64: string; fileName: string; mimeType: string }): Promise<string> => {
    if (!input || typeof input.fileName !== 'string' || !input.fileName.trim() || typeof input.mimeType !== 'string' || !input.mimeType.trim()) {
      throw new TypeError('Invalid PowerPoint source')
    }
    const maximumBytes = 60 * 1024 * 1024
    if (typeof input.dataBase64 !== 'string'
      || input.dataBase64.length > Math.ceil(maximumBytes / 3) * 4
      || input.dataBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64)) {
      throw new TypeError('PowerPoint embedded source data is invalid')
    }
    const bytes = Buffer.from(input.dataBase64, 'base64')
    if (bytes.toString('base64') !== input.dataBase64) throw new TypeError('PowerPoint embedded source data is invalid')
    if (bytes.byteLength > maximumBytes) throw new Error('PowerPoint source exceeds the size limit')
    const workspace = await workMount(id)
    const safeName = basename(input.fileName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'asset.bin'
    const path = join(workspace.path, `${fingerprint(bytes)}-${safeName}`)
    await mkdir(dirname(path), { recursive: true })
    const file = await open(path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') return null
      throw error
    })
    if (file) {
      try { await file.writeFile(bytes) } finally { await file.close() }
    }
    return path
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
    async listPresentationMounts(id: string): Promise<PresentationSourceMount[]> {
      return request(mountsPath(id)) as Promise<PresentationSourceMount[]>
    },
    async mountPresentationSource(id: string, input: { dataBase64?: string; fileName: string; mimeType: string; path?: string }): Promise<PresentationMountedSource> {
      if (!input || typeof input.fileName !== 'string' || !input.fileName.trim() || typeof input.mimeType !== 'string' || !input.mimeType.trim()) {
        throw new TypeError('Invalid PowerPoint source')
      }
      if (input.path) {
        const workspace = await workMount(id)
        const absolute = isAbsolute(input.path)
        const candidate = absolute ? await realpath(input.path) : await realpath(join(workspace.path, input.path))
        if (!absolute && !isWithin(workspace.path, candidate)) throw new Error('A relative PowerPoint source must stay inside the Session workspace')
        if (!(await stat(candidate)).isFile()) throw new Error('A PowerPoint source must be a file')
        return register(id, candidate)
      }
      if (typeof input.dataBase64 !== 'string') throw new TypeError('PowerPoint embedded source data is invalid')
      return register(id, await writePresentationSource(id, { dataBase64: input.dataBase64, fileName: input.fileName, mimeType: input.mimeType }))
    },
  }
}
