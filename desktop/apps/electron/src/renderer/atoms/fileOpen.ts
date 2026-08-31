/**
 * File-open gate atoms — a session-file double-click opens it with the OS
 * default program, but first asks for a confirmation the user can choose to
 * remember. Remembered keys live in `GuiSettings.fileOpen` and persist across
 * sessions / restarts.
 *
 * Key model: a file WITH an extension is remembered by its lowercased
 * extension (".TXT" === "txt" → one decision covers every .txt); a file
 * WITHOUT one — including dotfiles like ".gitignore" — is remembered by its
 * exact basename.
 *
 * Non-obvious dep: settings writes route through `updateSettingsAtom`, bound
 * to the Provider store (optimistic + persist to disk). Never write settings
 * from module scope: `getDefaultStore()` returns a different store than the
 * one `<Provider>` created, so such writes are never seen by the UI.
 */
import { atom } from 'jotai'
import type { GuiSettings } from '@app/shared/types'
import { i18n } from '@/lib/i18n'
import { rlog } from '@/lib/logger'
import { settingsAtom, updateSettingsAtom } from './settings'
import { showToastAtom } from './toast'
import { ModalKind, openModalAtom } from './amphi'
import { setPowerPointNeedsAttentionAtom } from './powerpoint-attention'
import { setRightPanelCollapsedAtom } from './layout'
import { viewedSessionIdAtom } from './navigation'
import { SessionWorkbenchSurface, setSessionWorkbenchSurfaceAtom } from './workbench'

/** Whether a remembered decision is keyed by extension or by exact filename. */
export type FileOpenKeyKind = 'ext' | 'name'

/** A file targeted for opening: absolute path + basename. */
export interface FileOpenTarget {
  path: string
  name: string
}

export function isPowerPointFileTarget(file: Pick<FileOpenTarget, 'name'>): boolean {
  return file.name.toLowerCase().endsWith('.pptx')
}

/**
 * Derive the remember-key from a basename. `dot > 0` (not `>= 0`) so a
 * leading-dot dotfile (".gitignore") has no real extension and falls back to
 * its basename rather than keying on "gitignore".
 */
export function deriveFileOpenKey(name: string): { kind: FileOpenKeyKind; key: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0
    ? { kind: 'ext', key: name.slice(dot + 1).toLowerCase() }
    : { kind: 'name', key: name }
}

/** True when the file's key is already approved for confirm-free opening. */
function isRemembered(settings: GuiSettings, kind: FileOpenKeyKind, key: string): boolean {
  const { autoOpenExtensions, autoOpenFilenames } = settings.fileOpen
  return kind === 'ext' ? autoOpenExtensions.includes(key) : autoOpenFilenames.includes(key)
}

/**
 * Double-click entry point. Opens directly when the file's key is already
 * remembered; otherwise routes to the FileOpenConfirm modal.
 */
export const requestFileOpenAtom = atom(null, (get, set, file: FileOpenTarget) => {
  const { kind, key } = deriveFileOpenKey(file.name)
  if (isRemembered(get(settingsAtom), kind, key)) {
    void window.api.shell.openPath(file.path).catch((err: unknown) => {
      rlog.warn('[fileOpen] openPath failed', err)
      set(showToastAtom, i18n.t('error.cannotOpenFile'))
    })
    return
  }
  set(openModalAtom, { type: ModalKind.FileOpenConfirm, path: file.path, name: file.name })
})

/** Route supported Session files into an in-app owner before falling back to the OS. */
export const requestSessionFileOpenAtom = atom(null, async (get, set, file: FileOpenTarget) => {
  if (!isPowerPointFileTarget(file)) {
    set(requestFileOpenAtom, file)
    return
  }
  const sessionId = get(viewedSessionIdAtom)
  if (!sessionId) return
  try {
    await window.api.powerpoint.openFile(sessionId, file.path)
    const stillViewed = get(viewedSessionIdAtom) === sessionId
    set(setPowerPointNeedsAttentionAtom, { sessionId, needsAttention: !stillViewed })
    if (!stillViewed) return
    set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Presentation)
    set(setRightPanelCollapsedAtom, false)
    set(showToastAtom, i18n.t('session.presentation.imported', { name: file.name }))
  } catch (error) {
    rlog.warn('[fileOpen] in-app PowerPoint import failed', error)
    set(showToastAtom, i18n.t('session.presentation.importFailed'))
  }
})

/**
 * Confirm action from the modal: open the file, and when `remember` is set,
 * persist its key into the matching bucket (immutable, deduped). The modal
 * owns closing itself (via its onClose), mirroring SessionDeleteModal.
 */
export const confirmFileOpenAtom = atom(
  null,
  (_get, set, arg: FileOpenTarget & { remember: boolean }) => {
    void window.api.shell.openPath(arg.path).catch((err: unknown) => {
      rlog.warn('[fileOpen] openPath failed', err)
      set(showToastAtom, i18n.t('error.cannotOpenFile'))
    })
    if (!arg.remember) return
    const { kind, key } = deriveFileOpenKey(arg.name)
    set(updateSettingsAtom, (prev) => {
      const fo = prev.fileOpen
      if (kind === 'ext') {
        if (fo.autoOpenExtensions.includes(key)) return prev
        return { ...prev, fileOpen: { ...fo, autoOpenExtensions: [...fo.autoOpenExtensions, key] } }
      }
      if (fo.autoOpenFilenames.includes(key)) return prev
      return { ...prev, fileOpen: { ...fo, autoOpenFilenames: [...fo.autoOpenFilenames, key] } }
    })
  },
)
