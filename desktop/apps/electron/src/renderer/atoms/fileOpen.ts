/**
 * File-open routing atoms. DOCX files open inside the Session Word surface;
 * every other file opens with the OS default program after the existing
 * rememberable confirmation gate.
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
import { isDocxFileName } from '@/lib/fileTypes'
import { i18n } from '@/lib/i18n'
import { rlog } from '@/lib/logger'
import { settingsAtom, updateSettingsAtom } from './settings'
import { showToastAtom } from './toast'
import { ModalKind, openModalAtom } from './amphi'
import { requestWordFileOpenAtom } from './word'

/** Whether a remembered decision is keyed by extension or by exact filename. */
export type FileOpenKeyKind = 'ext' | 'name'

/** A file targeted for opening: absolute path + basename. */
export interface FileOpenTarget {
  path: string
  name: string
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
 * Shared entry point for file rows and Agent-generated local file links.
 */
export const requestFileOpenAtom = atom(null, (get, set, file: FileOpenTarget) => {
  if (isDocxFileName(file.name)) {
    set(requestWordFileOpenAtom, file)
    return
  }
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
