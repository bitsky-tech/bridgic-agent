import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type {
  MountReferenceRebindResult,
  MountReferenceSummary,
  MountReferenceUsage,
  MountReplacementValidation,
} from '../../shared/mount-references'
import { officeWorkspaceRequest } from '../office-workspace-backend'
import { loggedHandle } from './logged-handle'
import { redactLocalPathLogArgs } from './path-log'

export interface MountReferenceProvider {
  usage(sessionId: string, mountId: string): Promise<MountReferenceUsage>
  validateReplacement(sessionId: string, mountId: string, path: string): Promise<MountReplacementValidation>
  remove(sessionId: string, mountId: string): Promise<MountReferenceUsage>
  refresh(sessionId: string): void | Promise<void>
}

const mountsPath = (id: string) => `/sessions/${encodeURIComponent(id)}/mounts`
const totalUsage = (usages: readonly MountReferenceUsage[]): MountReferenceUsage => usages.reduce((total, usage) => ({
  assetCount: total.assetCount + usage.assetCount,
  elementCount: total.elementCount + usage.elementCount,
  projectCount: total.projectCount + usage.projectCount,
}), { assetCount: 0, elementCount: 0, projectCount: 0 })

export function registerMountReferenceHandlers(providers: readonly MountReferenceProvider[]): void {
  loggedHandle(IPC.mountReferences.usage, async (_event, sessionId: string, mountId: string) => {
    return totalUsage(await Promise.all(providers.map((provider) => provider.usage(sessionId, mountId))))
  })
  loggedHandle(IPC.mountReferences.remove, async (_event, sessionId: string, mountId: string) => {
    return totalUsage(await Promise.all(providers.map((provider) => provider.remove(sessionId, mountId))))
  })
  loggedHandle(IPC.mountReferences.refresh, async (_event, sessionId: string) => {
    await Promise.all(providers.map((provider) => provider.refresh(sessionId)))
  })
  loggedHandle(IPC.mountReferences.rebind, async (_event, sessionId: string, mountId: string, path: string): Promise<MountReferenceRebindResult> => {
    if (typeof path !== 'string' || !path.trim()) throw new Error('A replacement path is required')
    const validations = await Promise.all(providers.map((provider) => provider.validateReplacement(sessionId, mountId, path)))
    const rejected = validations.find((validation): validation is Exclude<MountReplacementValidation, { compatible: true }> => !validation.compatible)
    if (rejected) return { ok: false, validation: rejected }
    const mount = await officeWorkspaceRequest(mountsPath(sessionId), { id: mountId, path }, 'PATCH') as MountReferenceSummary
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('office-files:changed', sessionId)
    await Promise.all(providers.map((provider) => provider.refresh(sessionId)))
    return { ok: true, mount }
  }, { transformLogArgs: redactLocalPathLogArgs })
}
