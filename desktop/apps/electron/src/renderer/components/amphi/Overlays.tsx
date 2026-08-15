/**
 * Floating overlay panels — the session right-click dropdown, rendered as a
 * positioned floating card next to a sidebar item (the parent decides absolute
 * placement).
 *
 * Refactored to Tailwind className per §1.22.
 */

import { Icons } from './Icons'
import { Divider } from './Primitives'
import { useTranslation } from 'react-i18next'

/* ─── Session right-click dropdown ─── */

export function SessionContextDropdown({ onRename, onDelete }: { onRename?: () => void; onDelete?: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="w-[170px] bg-bg-elevated border border-border-default rounded-md shadow-lg overflow-hidden py-1">
      <div
        onClick={onRename}
        className="flex items-center gap-2 px-3 py-2 cursor-pointer text-sm text-text-primary"
      >
        {Icons.edit(14)} {t('session.menu.rename')}
      </div>
      <Divider style={{ margin: '2px 8px' }} />
      <div
        onClick={onDelete}
        className="flex items-center gap-2 px-3 py-2 cursor-pointer text-sm text-status-error"
      >
        {Icons.trash(14)} {t('session.menu.delete')}
      </div>
    </div>
  )
}
