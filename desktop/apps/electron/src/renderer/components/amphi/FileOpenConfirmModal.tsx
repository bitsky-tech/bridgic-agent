/**
 * Confirm dialog shown before a double-click opens a session file with the OS
 * default program. A "remember" toggle persists the file's key (extension or exact
 * basename) so future opens of the same kind skip this prompt.
 *
 * Routed via `activeModalAtom` (ModalKind.FileOpenConfirm) — see
 * ActiveModalHost. Per route A, the dialog intentionally does NOT name the
 * resolved application (no cross-platform way to query it without a native
 * dep); it says "the system default program" instead.
 */
import { useState } from 'react'
import { useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Modal } from './Modal'
import { Btn, Toggle } from './Primitives'
import { Icons } from './Icons'
import { confirmFileOpenAtom, deriveFileOpenKey } from '@/atoms/fileOpen'

export interface FileOpenConfirmModalProps {
  /** Absolute path handed to `shell.openPath` on confirm. */
  path: string
  /** Basename — drives both the remember-key and the dialog copy. */
  name: string
  onClose?: () => void
}

export function FileOpenConfirmModal({ path, name, onClose }: FileOpenConfirmModalProps) {
  const { t } = useTranslation()
  const confirmOpen = useSetAtom(confirmFileOpenAtom)
  const [remember, setRemember] = useState(false)
  const { kind, key } = deriveFileOpenKey(name)
  // The remember option's wording follows the key type: with an extension we remember the extension (.txt), without one we remember the exact file name (Makefile).
  const rememberLabel = kind === 'ext'
    ? t('fileOpen.rememberExtension', { extension: `.${key}` })
    : t('fileOpen.rememberName', { name: key })

  return (
    <Modal width={400} title={t('fileOpen.title')} onClose={onClose}>
      <div className="p-5">
        <div className="flex items-center gap-2.5 p-3.5 rounded-md bg-bg-hover mb-4">
          <span className="text-text-secondary flex-shrink-0">{Icons.file(18)}</span>
          <div className="text-sm text-text-primary leading-[1.5] min-w-0">
            {t('fileOpen.message', { name })}
          </div>
        </div>
        {/* The whole row toggles "remember"; Toggle has no onClick of its own, so a click bubbling here toggles exactly once. */}
        <div
          onClick={() => setRemember((r) => !r)}
          className="flex items-center gap-2.5 mb-4 cursor-pointer"
        >
          <Toggle on={remember} />
          <span className="text-xs text-text-secondary">{rememberLabel}</span>
        </div>
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn
            variant="primary"
            size="md"
            onClick={() => {
              confirmOpen({ path, name, remember })
              onClose?.()
            }}
          >
            {t('common.open')}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}
