/**
 * Host for the external-link confirmation dialog — subscribes to externalLinkRequestAtom and renders when there is a pending request.
 *
 * Self-hosted in the style of ConfirmDialog (it does not go through activeModalAtom): clicking an http(s) link in a markdown reply
 * makes requestExternalLink suspend one request, and this component shows a dialog with the target URL + a "do not ask again in this session" switch +
 * cancel/open. Mounted at the App root (alongside ConfirmDialog).
 *
 * The dontAsk local state lives in Body rather than in the host: the host renders no Body when there is nothing pending → Body mounts/unmounts with each
 * request, so the checkbox state naturally resets per request (the previous check never carries over to the next link).
 */
import { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { externalLinkRequestAtom, resolveExternalLinkAtom } from '@/atoms/external-link'
import { Modal } from './Modal'
import { Btn, Toggle } from './Primitives'

/** Singleton host for the external-link confirmation dialog — clicking an http(s) link in markdown goes through this confirmation first, and only on approval does it call shell.openExternal. */
export function ExternalLinkDialog() {
  const req = useAtomValue(externalLinkRequestAtom)
  if (!req) return null
  return <ExternalLinkDialogBody url={req.url} />
}

function ExternalLinkDialogBody({ url }: { url: string }) {
  const { t } = useTranslation()
  const resolve = useSetAtom(resolveExternalLinkAtom)
  const [dontAsk, setDontAsk] = useState(false)
  return (
    <Modal width={440} title={t('externalLink.title')} onClose={() => resolve({ open: false, dontAsk })}>
      <div className="p-5">
        <div className="text-sm text-text-secondary mb-3 leading-[1.5]">
          {t('externalLink.description')}
        </div>
        <div className="p-3.5 rounded-md bg-bg-hover mb-4 text-sm font-mono text-text-primary break-all leading-[1.5]">
          {url}
        </div>
        {/* The whole row toggles the switch; Toggle has no onClick of its own, so a click bubbling here toggles exactly once. */}
        <div
          onClick={() => setDontAsk((v) => !v)}
          className="flex items-center gap-2.5 mb-4 cursor-pointer"
        >
          <Toggle on={dontAsk} />
          <span className="text-xs text-text-secondary">{t('externalLink.dontAskAgain')}</span>
        </div>
        <div className="flex justify-end gap-2">
          <Btn onClick={() => resolve({ open: false, dontAsk })}>{t('common.cancel')}</Btn>
          <Btn variant="primary" size="md" onClick={() => resolve({ open: true, dontAsk })}>
            {t('externalLink.open')}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}
