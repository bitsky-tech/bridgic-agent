import { useCallback } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { viewedSessionIdAtom } from '@/atoms/navigation'
import { setRightPanelCollapsedAtom } from '@/atoms/layout'
import {
  completeWordFileOpenAtom,
  setWordDocumentCountAtom,
  wordExpandedAtom,
  wordFileOpenRequestAtom,
} from '@/atoms/word'
import { showToastAtom } from '@/atoms/toast'
import { SessionWordEditor } from '@/components/word/SessionWordEditor'
import { rlog } from '@/lib/logger'

/** Session-owned Word frontend and stable renderer-domain registration. */
export function WordWorkbenchPanel() {
  const { t } = useTranslation()
  const sessionId = useAtomValue(viewedSessionIdAtom)
  const expanded = useAtomValue(wordExpandedAtom)
  const openFileRequest = useAtomValue(wordFileOpenRequestAtom)
  const setExpanded = useSetAtom(wordExpandedAtom)
  const setRightCollapsed = useSetAtom(setRightPanelCollapsedAtom)
  const completeFileOpen = useSetAtom(completeWordFileOpenAtom)
  const setDocumentCount = useSetAtom(setWordDocumentCountAtom)
  const showToast = useSetAtom(showToastAtom)
  const handleDocumentCountChange = useCallback((id: string, count: number) => {
    setDocumentCount({ sessionId: id, count })
  }, [setDocumentCount])
  const handleFileOpenComplete = useCallback((requestId: string) => {
    completeFileOpen(requestId)
  }, [completeFileOpen])
  const handleFileOpenError = useCallback((name: string, cause: unknown) => {
    rlog.warn('[word] document import failed', { name, cause })
    showToast(t('word.fileOpenFailed', { name }))
  }, [showToast, t])
  if (!sessionId) return null
  return (
    <SessionWordEditor
      defaultTitle={t('word.untitled')}
      expanded={expanded}
      onClose={() => {
        setExpanded(false)
        setRightCollapsed(true)
      }}
      onOpenFileError={handleFileOpenError}
      onDocumentCountChange={handleDocumentCountChange}
      onOpenFileRequestHandled={handleFileOpenComplete}
      onToggleExpanded={() => setExpanded((value) => !value)}
      openFileRequest={openFileRequest}
      sessionId={sessionId}
    />
  )
}
