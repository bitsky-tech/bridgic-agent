/**
 * Local file links in chat prose — click to open, hover reveals "reveal in Finder / copy path".
 *
 * Why it exists: previously a `file://` link had exactly one affordance, "open it". Once a file was opened, sending it to
 * someone over IM meant hunting it down on disk yourself — and file names produced by the Agent tend to be long and similar,
 * so the name alone does not tell you which one it is. Hence two additions: **a reveal affordance on hover**, and
 * **the full absolute path in the tooltip**.
 *
 * Invariants:
 *  - Both icons **always occupy their space** and only `opacity` is toggled (§LS1). With conditional rendering, every hover
 *    would nudge the whole line of text — the link is inline inside a paragraph, so the jitter would ripple through the entire paragraph.
 *  - Grouping uses the named `group/filelink`: a paragraph may contain several file links, and an anonymous group would make
 *    hovering any one of them light up the icons of every link.
 *  - Opening still goes through `requestFileOpenAtom`: DOCX routes to Word, while other files keep the confirmed system-open flow.
 */
import { useSetAtom } from 'jotai'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { requestFileOpenAtom, type FileOpenTarget } from '@/atoms/fileOpen'
import { showToastAtom } from '@/atoms/toast'
import { rlog } from '@/lib/logger'
import { Icons } from '@/components/amphi/Icons'
import { Tooltip } from '@/components/amphi/Tooltip'

export interface FileLinkProps {
  /** The local file target already resolved by `fileUrlToTarget` (absolute path + basename). */
  target: FileOpenTarget
  /** The link's visible text (whatever was written in the markdown). */
  children: ReactNode
}

const ACTION_CLS =
  'inline-flex items-center text-text-tertiary opacity-0 transition-opacity ' +
  'hover:text-text-primary group-hover/filelink:opacity-100 focus-visible:opacity-100'

export function FileLink({ target, children }: FileLinkProps) {
  const { t } = useTranslation()
  const requestFileOpen = useSetAtom(requestFileOpenAtom)
  const showToast = useSetAtom(showToastAtom)

  const reveal = (): void => {
    // showItemInFolder behaves the same for files and folders: reveal that path in the system file manager.
    void window.api.shell.showItemInFolder(target.path)
  }

  const copyPath = (): void => {
    void navigator.clipboard
      .writeText(target.path)
      .then(() => showToast(t('markdown.fileLink.copied')))
      .catch((err: unknown) => {
        rlog.warn('[file-link] copy path failed', err)
        showToast(t('markdown.fileLink.copyFailed'))
      })
  }

  return (
    <span className="group/filelink inline-flex items-baseline gap-1">
      <Tooltip content={target.path}>
        <a
          href={target.path}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            requestFileOpen(target)
          }}
        >
          {children}
        </a>
      </Tooltip>
      <Tooltip content={t('markdown.fileLink.reveal')}>
        <button
          type="button"
          aria-label={t('markdown.fileLink.revealAria', { name: target.name })}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            reveal()
          }}
          className={ACTION_CLS}
        >
          {Icons.folder(12)}
        </button>
      </Tooltip>
      <Tooltip content={t('markdown.fileLink.copyPath')}>
        <button
          type="button"
          aria-label={t('markdown.fileLink.copyPathAria', { name: target.name })}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            copyPath()
          }}
          className={ACTION_CLS}
        >
          {Icons.file(12)}
        </button>
      </Tooltip>
    </span>
  )
}
