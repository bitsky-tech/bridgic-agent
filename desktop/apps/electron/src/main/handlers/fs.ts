/**
 * `fs.*` IPC handlers — local-filesystem reads for UI display.
 *
 * Thin registration layer over the pure walker in `./dir-tree` (kept
 * electron-free for bun:test). Display-only: the renderer shows the tree
 * and lets the user @-reference entries, but mention RESOLUTION stays on
 * the daemon side (mount id + relative path), so this channel never grants
 * the agent anything — it only mirrors what the user can already see in
 * Finder.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { IPC } from '../../shared/ipc-channels'
import type { DirListResult, SearchDirRequest, SearchDirResult } from '../../shared/dir-tree'
import { loggedHandle } from './logged-handle'
import { listDir, searchDir } from './dir-tree'
import { bridgicHomeDir } from '../paths'
import { isAllowedTaskFileWrite } from '../task-file-guard'
import { redactLocalPathLogArgs } from './path-log'

export function registerFsHandlers(): void {
  loggedHandle(
    IPC.fs.listDir,
    (_event, absPath: string, relBase?: string): Promise<DirListResult> => {
      return listDir(absPath, relBase ?? '')
    },
  )
  loggedHandle(IPC.fs.searchDir, (_event, req: SearchDirRequest): Promise<SearchDirResult> => {
    return searchDir(req)
  })
  // Write `<workspace_root>/.work/.build/task.md`. The path is strictly
  // validated and anything out of bounds is rejected — this IPC exists solely
  // for "manually editing the requirements spec", not as a general-purpose disk write.
  loggedHandle(IPC.fs.writeFile, async (_event, absPath: string, content: string): Promise<void> => {
    if (!isAllowedTaskFileWrite(absPath, bridgicHomeDir())) {
      throw new Error(`refused writeFile outside ~/.bridgic/**/.work/.build/task.md: ${absPath}`)
    }
    mkdirSync(path.dirname(absPath), { recursive: true })
    writeFileSync(absPath, content, { encoding: 'utf-8' })
  })
  loggedHandle(
    IPC.fs.writePresentation,
    async (_event, absPath: string, content: Uint8Array): Promise<void> => {
      if (!path.isAbsolute(absPath) || path.extname(absPath).toLowerCase() !== '.pptx') {
        throw new Error('Presentation export path must end with .pptx')
      }
      mkdirSync(path.dirname(absPath), { recursive: true })
      await writeFile(absPath, content)
    },
    { transformLogArgs: redactLocalPathLogArgs },
  )
  loggedHandle(
    IPC.fs.writeWorkflowArchive,
    async (_event, absPath: string, content: Uint8Array): Promise<void> => {
      if (!path.isAbsolute(absPath) || !absPath.toLowerCase().endsWith('.amphi-workflow')) {
        throw new Error('Workflow export path must end with .amphi-workflow')
      }
      writeFileSync(absPath, content)
    },
    { transformLogArgs: redactLocalPathLogArgs },
  )
  loggedHandle(
    IPC.fs.writeWorkflowRunArchive,
    async (_event, absPath: string, content: Uint8Array): Promise<void> => {
      if (!path.isAbsolute(absPath) || !absPath.toLowerCase().endsWith('.zip')) {
        throw new Error('Workflow Run export path must end with .zip')
      }
      await writeFile(absPath, content)
    },
    { transformLogArgs: redactLocalPathLogArgs },
  )
}
