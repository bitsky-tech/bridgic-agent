/**
 * Step 1 of the Skill import wizard: choose the import method (local directory / remote address).
 *
 * A presentational component — the method switch, the local dropzone and the remote URL input all live here, while the
 * container (`SkillImportModal`) holds method / remoteUrl / network state and passes callbacks down. Remote detection uses the
 * pure function `detectSkillRemoteSource` (GitHub and skills.sh pages are importable; clawhub is shown as an info card).
 * The real repository parsing/validation happens in the backend scan. `SkillImportSteps.tsx` was split out to stay within the 400-line budget (§1.14).
 */
import { cn } from '@/lib/cn'
import { Trans, useTranslation } from 'react-i18next'
import type { SkillRemoteSource } from '@/lib/skillImportSource'
import { Icons } from './Icons'
import { Btn } from './Primitives'

/** Import method (closed set, §4.11). */
export const ImportMethod = { Local: 'local', Remote: 'remote' } as const
export type ImportMethod = (typeof ImportMethod)[keyof typeof ImportMethod]

/** Data for the "supported sources" info cards — GitHub / skills.sh are `ready`, clawhub is shown as "coming soon". */
const REMOTE_SOURCES: ReadonlyArray<{
  icon: (size: number) => React.ReactNode
  name: string
  sub?: string
  subKey?: string
  eg: string
  ready: boolean
}> = [
  { icon: Icons.workflow, name: 'GitHub', sub: 'github.com', eg: 'https://github.com/org/skills-repo', ready: true },
  // `sourceList` rather than `source`: this row's subtitle describes what skills.sh *is*,
  // while `source.skillsSh` names the source detected from a pasted URL. Sharing one key
  // would force one string to do both jobs.
  { icon: Icons.terminal, name: 'skills.sh', subKey: 'skill.import.pick.sourceList.skillsSh', eg: 'https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices', ready: true },
  { icon: Icons.robot, name: 'ClawHub', sub: 'clawhub.ai', eg: 'https://clawhub.ai/s/feishu-bot', ready: false },
]

/** Segmented control for switching method (local directory / remote address). */
function ImportMethodTabs({
  active,
  onChange,
}: {
  active: ImportMethod
  onChange: (m: ImportMethod) => void
}) {
  const { t } = useTranslation()
  const tabs = [
    { id: ImportMethod.Local, label: t('skill.import.pick.tab.local'), icon: Icons.folder },
    { id: ImportMethod.Remote, label: t('skill.import.pick.tab.remote'), icon: Icons.link },
  ] as const
  return (
    <div className="flex gap-0 p-0.5 rounded-md bg-bg-hover border border-border-subtle mb-[18px]">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 py-[7px] rounded-sm text-xs',
            active === t.id
              ? 'font-semibold text-text-primary bg-bg-elevated shadow-sm'
              : 'text-text-tertiary',
          )}
        >
          {t.icon(13)} {t.label}
        </button>
      ))}
    </div>
  )
}

/** Remote detection hint row — GitHub gets a green check and is importable; known-but-unsupported / unrecognizable sources get an explanation. */
function RemoteSourceHint({ source }: { source: SkillRemoteSource | null }) {
  const { t } = useTranslation()
  if (!source) return null
  const label = source.kind === 'unknown' ? source.label : t(`skill.import.pick.source.${source.kind}`)
  if (source.importable) {
    return (
      <div className="flex items-center gap-1.5 mb-[18px]">
        <span className="text-status-success">{Icons.check(13)}</span>
        <span className="text-xs text-text-secondary">
          <Trans i18nKey="skill.import.pick.recognized" values={{ source: label }} components={{ b: <strong className="text-text-primary" /> }} />
        </span>
      </div>
    )
  }
  const message =
    source.kind === 'unknown'
      ? t('skill.import.pick.unrecognized')
      : t('skill.import.pick.unsupported', { source: label })
  return (
    <div className="flex items-center gap-1.5 mb-[18px]">
      <span className="text-status-warning">{Icons.xCircle(13)}</span>
      <span className="text-xs text-text-secondary">{message}</span>
    </div>
  )
}

export interface ImportPickStepProps {
  method: ImportMethod
  onMethodChange: (m: ImportMethod) => void
  busy: boolean
  /** Local: open the system directory picker and scan. */
  onPickLocal: () => void
  /** Remote: the current URL. */
  remoteUrl: string
  onRemoteUrlChange: (v: string) => void
  /** Remote: detection result (drives the hint + whether the import button is enabled; computed by the container). */
  remoteSource: SkillRemoteSource | null
  /** Remote: submit on Enter (the same action as the "import" button at the bottom). */
  onSubmitRemote: () => void
}

/** Step 1 — choose the import method. Local directories use a dropzone (with a button inside); remote addresses use a URL input
 *  (the submit action is the "import" button in the bottom bar). */
export function ImportPickStep({
  method,
  onMethodChange,
  busy,
  onPickLocal,
  remoteUrl,
  onRemoteUrlChange,
  remoteSource,
  onSubmitRemote,
}: ImportPickStepProps) {
  const { t } = useTranslation()
  return (
    <div className="p-6">
      <ImportMethodTabs active={method} onChange={onMethodChange} />

      {method === ImportMethod.Local ? (
        <div className="border-[1.5px] border-dashed border-border-strong rounded-lg px-6 py-9 text-center bg-bg-hover">
          <div className="w-12 h-12 rounded-md bg-accent-blue-subtle text-text-accent flex items-center justify-center mx-auto mb-3.5">
            {Icons.folder(24)}
          </div>
          <div className="text-md font-semibold text-text-primary">{t('skill.import.pick.local.title')}</div>
          <div className="text-xs text-text-secondary mt-1.5 leading-[1.6]">
            <Trans i18nKey="skill.import.pick.local.description" components={{ b: <strong className="text-text-primary" /> }} />
          </div>
          <Btn
            variant="primary"
            size="md"
            className={cn('mt-4', busy && 'opacity-50 pointer-events-none')}
            onClick={onPickLocal}
          >
            {Icons.folder(14)} {busy ? t('skill.import.pick.scanning') : t('skill.import.pick.chooseDirectory')}
          </Btn>
        </div>
      ) : (
        <>
          <div className="text-xs font-semibold text-text-primary mb-2">{t('skill.import.pick.remoteAddress')}</div>
          <div
            className={cn(
              'flex items-center gap-2 px-3 py-2.5 rounded-md border bg-bg-input mb-2',
              remoteSource?.importable ? 'border-brand-blue' : 'border-border-default',
            )}
          >
            <span className="text-text-tertiary shrink-0">{Icons.link(15)}</span>
            <input
              value={remoteUrl}
              onChange={(e) => onRemoteUrlChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && remoteSource?.importable && !busy) onSubmitRemote()
              }}
              placeholder="https://github.com/org/skills-repo"
              spellCheck={false}
              className="flex-1 bg-transparent outline-none text-sm text-text-primary font-mono placeholder:text-text-tertiary placeholder:font-sans"
            />
          </div>
          <RemoteSourceHint source={remoteSource} />

          <div className="text-xs font-semibold text-text-secondary mb-2">{t('skill.import.pick.supportedSources')}</div>
          <div className="flex flex-col gap-2">
            {REMOTE_SOURCES.map((s) => (
              <div
                key={s.name}
                className={cn(
                  'flex items-center gap-3 px-3.5 py-2.5 rounded-md border border-border-subtle bg-bg-hover',
                  !s.ready && 'opacity-60',
                )}
              >
                <div className="w-[30px] h-[30px] rounded-sm bg-bg-elevated border border-border-subtle flex items-center justify-center text-text-secondary shrink-0">
                  {s.icon(15)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-text-primary">
                    {s.name}{' '}
                    <span className="text-xs font-normal text-text-tertiary">· {s.subKey ? t(s.subKey) : s.sub}</span>
                    {!s.ready && (
                      <span className="ml-1.5 text-2xs font-semibold text-text-tertiary bg-bg-elevated border border-border-default px-1.5 py-px rounded-full">
                        {t('skill.import.pick.comingSoon')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-tertiary font-mono mt-0.5 truncate">{s.eg}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex gap-2 mt-4 px-3 py-2.5 rounded-md bg-accent-blue-subtle">
            <span className="text-text-accent shrink-0 mt-px">{Icons.workflow(13)}</span>
            <span className="text-xs text-text-secondary leading-[1.5]">
              <Trans i18nKey="skill.import.pick.remoteHint" components={{ b: <strong className="text-text-primary" /> }} />
            </span>
          </div>
        </>
      )}
    </div>
  )
}
