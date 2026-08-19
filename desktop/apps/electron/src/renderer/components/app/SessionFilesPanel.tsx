import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { Icons } from '@/components/amphi/Icons'
import { SessionAssetsPanel } from '@/components/amphi/SessionAssets'
import { useMountSearch } from '@/hooks/useMountSearch'
import {
  WorkbenchSearchField,
  WorkbenchToolHeader,
  WorkbenchToolScrollArea,
  WorkbenchToolSurface,
} from './WorkbenchToolPrimitives'

/** File-system workbench. Search and file-tree state are independent from every other tool. */
export function SessionFilesPanel() {
  const { t } = useTranslation()
  const sessionId = useAtomValue(activeSessionIdAtom)
  const [query, setQuery] = useState('')
  const [querySessionId, setQuerySessionId] = useState(sessionId)

  if (querySessionId !== sessionId) {
    setQuerySessionId(sessionId)
    setQuery('')
  }

  const search = useMountSearch(query, sessionId)
  return (
    <WorkbenchToolSurface testId="session-files-panel">
      <WorkbenchToolHeader
        icon={Icons.folder(15)}
        iconClassName="bg-accent-blue-subtle text-text-accent"
        testId="session-files-header"
        title={t('session.workbench.files.title', {
          defaultValue: t('session.resourcePanel.files'),
        })}
      />
      <div className="shrink-0 px-3 pt-3">
        <WorkbenchSearchField
          clearLabel={t('rightPanel.clearSearchAria')}
          onQueryChange={setQuery}
          query={query}
          searchPlaceholder={t('session.workbench.files.searchPlaceholder', {
            defaultValue: t('rightPanel.searchPlaceholder'),
          })}
          testId="session-files-search"
        />
      </div>
      <WorkbenchToolScrollArea>
        <SessionAssetsPanel query={query} search={search} />
      </WorkbenchToolScrollArea>
    </WorkbenchToolSurface>
  )
}
