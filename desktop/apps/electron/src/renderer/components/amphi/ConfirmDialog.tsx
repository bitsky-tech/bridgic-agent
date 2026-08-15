/**
 * Generic custom confirmation dialog — consumes confirmRequestAtom, reusing the Modal shell + Btn.
 *
 * A global singleton mounted at the App root (next to ActiveModalHost); anywhere in the app can trigger it with
 * `requestConfirm(opts)` and `await` the result. It replaces Electron's native `window.confirm`, so unsaved-changes
 * prompts, delete confirmations and the like all go through one dialog with consistent, customizable styling.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { confirmRequestAtom, resolveConfirmAtom } from '@/atoms/confirm'
import { Modal } from './Modal'
import { Btn } from './Primitives'

export function ConfirmDialog() {
  const { t } = useTranslation()
  const req = useAtomValue(confirmRequestAtom)
  const resolve = useSetAtom(resolveConfirmAtom)
  if (!req) return null
  // Modal handles Esc / backdrop → onClose itself; in a confirmation dialog the semantics of "close" are cancel (false).
  return (
    <Modal width={420} title={req.title} onClose={() => resolve(false)}>
      <div className="p-5">
        <div className="text-sm text-text-primary leading-[1.6] mb-5 whitespace-pre-wrap">
          {req.message}
        </div>
        <div className="flex justify-end gap-2">
          <Btn onClick={() => resolve(false)}>{req.cancelLabel ?? t('common.cancel')}</Btn>
          <Btn variant={req.danger ? 'danger' : 'primary'} size="md" onClick={() => resolve(true)}>
            {req.confirmLabel ?? t('common.confirm')}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}
