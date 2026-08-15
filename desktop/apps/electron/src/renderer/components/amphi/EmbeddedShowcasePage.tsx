/**
 * A showcase.bridgic.ai page in a frame, with a placeholder covering it until it
 * paints. Used by the workflow-market preview dialog.
 *
 * The frame stays mounted underneath the placeholder rather than being rendered
 * only once ready: unmounted it would never start loading, so the placeholder
 * would never clear. A cross-origin frame reports no progress, which leaves
 * `onLoad` as the only signal available — it fires once the document and its
 * subresources are done, which is the moment the page is worth showing.
 *
 * Lives in its own file rather than inside Modals.tsx because that file is an
 * approved oversized exception, and because the placeholder is then testable
 * without dragging its import graph along.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Icons } from './Icons'

export function EmbeddedShowcasePage({ url, title }: { url: string; title: string }) {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState(false)

  return (
    <div className="relative w-full h-[68vh]">
      <iframe
        src={url}
        title={title}
        onLoad={() => setLoaded(true)}
        className="w-full h-full border-0 bg-bg-surface"
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
      />
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-bg-surface text-sm text-text-tertiary">
          <span className="flex animate-spin">{Icons.refresh(14)}</span>
          {t('modals.market.loading')}
        </div>
      )}
    </div>
  )
}
