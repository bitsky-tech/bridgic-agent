/**
 * Settings → About: version, licence, source, contacts, and the manual update
 * entry point.
 *
 * The licence line and the copyright notice are contractual text, not decoration
 * — see the licence block in `app-meta.ts` for what obliges them to be here.
 *
 * The update row is the ONLY way back into the install flow once the user has
 * dismissed the floating card, so the "cancelled" copy points here. It
 * deliberately does not re-implement that flow: pressing "update now" hands
 * control back to `AutoUpdateBanner` through `requestUpdateCardAtom`, because
 * the decision it makes (is an agent running? offer "when idle" first) has to
 * behave identically wherever it is triggered from.
 *
 * Invariants:
 *   - Status comes from BOTH a snapshot (`update.getStatus`, for state that
 *     happened before this tab mounted) and the live event stream. Either alone
 *     leaves a hole: the snapshot goes stale while the tab is open, and the
 *     stream never replays what it already sent.
 *   - "Updates are disabled in this build" is a first-class state, not an error.
 *     Dev builds and any build shipped without a feed land there, and a Check
 *     button that silently did nothing would read as broken.
 *
 * A separate file rather than another entry in `Modals.tsx`: the collection
 * exemption there covers the file's total length, not individual components
 * (§1.31).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Copy, ExternalLink } from 'lucide-react'
import { requestUpdateCardAtom } from '@/atoms/update'
import {
  APP_NEW_ISSUE_URL,
  COMMERCIAL_LICENSE_CONTACT,
  COPYRIGHT_HOLDER,
  COPYRIGHT_YEAR,
  DISCORD_INVITE_URL,
  FEEDBACK_CONTACT,
  PUBLIC_REPO_URL,
  SECURITY_CONTACT,
  SOCIAL_X_HANDLE,
  SOCIAL_X_URL,
} from '@shared/app-meta'
import { rlog } from '@/lib/logger'
import wechatQrUrl from '@/assets/wechat-group-qr.png'
import { Btn, Card } from './Primitives'

/** What the update row is currently saying. */
type UpdateRowState =
  | { kind: 'unknown' }
  | { kind: 'disabled' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'staged'; version: string }
  | { kind: 'failed'; code?: string }

export interface SettingsAboutTabProps {
  /** Closes the settings dialog — the install card lives behind it. */
  onRequestClose?: () => void
}

export function SettingsAboutTab({ onRequestClose }: SettingsAboutTabProps) {
  const { t, i18n } = useTranslation()
  // `resolvedLanguage` and not `language`: during the window before
  // `useApplyLocale` runs, the detector can leave `language` at a regional tag
  // (`zh-CN`), and `supportedLngs` only constrains the resolved one.
  const locale = (i18n.resolvedLanguage ?? i18n.language) === 'zh' ? 'zh' : 'en'
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<UpdateRowState>({ kind: 'unknown' })
  const requestUpdateCard = useSetAtom(requestUpdateCardAtom)

  useEffect(() => {
    void window.api.app.getVersion().then(setAppVersion)
  }, [])

  useEffect(() => {
    void window.api.update.getStatus().then((status) => {
      if (!status.isEnabled) {
        setUpdateState({ kind: 'disabled' })
        return
      }
      if (status.stagedVersion !== null) {
        setUpdateState({ kind: 'staged', version: status.stagedVersion })
      }
    })
  }, [])

  useEffect(() => {
    return window.api.events.onAutoUpdate((event) => {
      switch (event.type) {
        case 'checking':
          setUpdateState({ kind: 'checking' })
          break
        case 'not-available':
          setUpdateState({ kind: 'up-to-date' })
          break
        case 'progress':
          setUpdateState({ kind: 'downloading', percent: Math.round(event.percent) })
          break
        case 'downloaded':
          setUpdateState({ kind: 'staged', version: event.info.version })
          break
        case 'error':
          setUpdateState({ kind: 'failed', code: event.code })
          break
        default:
          break
      }
    })
  }, [])

  const handleCheck = useCallback(async () => {
    const outcome = await window.api.update.checkNow()
    rlog.debug('[about] manual update check', { outcome })
    // `started` hands the row over to the event stream. `busy` deliberately
    // leaves the row ALONE: a check or download is already running, and what
    // the stream last reported ("downloading 45%") describes it far better
    // than resetting to "checking". Setting "checking" up front was exactly
    // why clicking mid-download looked like the button did nothing — it threw
    // away the only informative state the row had.
    if (outcome === 'started') setUpdateState({ kind: 'checking' })
    if (outcome === 'disabled') setUpdateState({ kind: 'disabled' })
    if (outcome === 'staged') {
      const status = await window.api.update.getStatus()
      setUpdateState(
        status.stagedVersion === null
          ? { kind: 'unknown' }
          : { kind: 'staged', version: status.stagedVersion },
      )
    }
  }, [])

  const handleInstall = () => {
    requestUpdateCard()
    // The card renders behind this dialog, so getting out of the way is part of
    // the action rather than a courtesy.
    onRequestClose?.()
  }

  return (
    <div className="p-5 flex flex-col gap-3">
      <Card className="p-0 divide-y divide-border-subtle">
        {/* One version, not two. `scripts/release-manifest.ts` refuses to build
            when the desktop and backend versions differ, so a separate "core
            version" row would always repeat this number — and in the one case
            where they diverge (new app, old daemon still running) the
            compatibility gate blocks the UI before Settings is reachable. */}
        <AboutRow label={t('modals.about.version')}>
          <span className="text-sm font-mono text-text-secondary">{appVersion ?? '—'}</span>
        </AboutRow>

        <AboutRow
          label={t('modals.about.license')}
          description={t('modals.about.licenseDescription', {
            contact: COMMERCIAL_LICENSE_CONTACT,
          })}
        />

        {/* Directly under the licence, because under the AGPL the two are one
            statement: §6 wants the corresponding source offered to whoever
            received the binary, and this row is that offer.

            It links `PUBLIC_REPO_URL` unconditionally. While that repo is still
            private the link 404s — a broken link is the visible symptom of an
            unpublished source tree, and hiding the row would only make the same
            gap silent. */}
        <LinkRow
          testId="repository"
          label={t('modals.about.repository')}
          text={PUBLIC_REPO_URL}
          href={PUBLIC_REPO_URL}
          copyValue={PUBLIC_REPO_URL}
        />

        <AboutRow label={t('modals.about.softwareUpdate')}>
          <div className="flex items-center gap-3">
            <UpdateStateLabel state={updateState} />
            {updateState.kind === 'staged' ? (
              <Btn variant="primary" size="xs" onClick={handleInstall} data-testid="about-install">
                {t('modals.about.updateNow')}
              </Btn>
            ) : (
              <Btn
                variant="default"
                size="xs"
                onClick={() => void handleCheck()}
                data-testid="about-check"
              >
                {t('modals.about.checkForUpdates')}
              </Btn>
            )}
          </div>
        </AboutRow>
      </Card>

      {/* The addresses live in app-meta rather than the catalog: they are the same
          in every language, and a translator editing one would silently reroute
          mail. Only the labels are translated.

          Bug reports are deliberately the one row that is NOT an address — they
          belong on the public issue tracker, where they stay searchable and
          duplicates collapse. An inbox turns each one into a private thread. */}
      <Card className="p-0 divide-y divide-border-subtle">
        <div className="px-4 py-3 text-sm text-text-primary">{t('modals.about.contact')}</div>
        <LinkRow
          testId="business"
          label={t('modals.about.contactBusiness')}
          text={COMMERCIAL_LICENSE_CONTACT}
          href={`mailto:${COMMERCIAL_LICENSE_CONTACT}`}
          copyValue={COMMERCIAL_LICENSE_CONTACT}
        />
        <LinkRow
          testId="security"
          label={t('modals.about.contactSecurity')}
          text={SECURITY_CONTACT}
          href={`mailto:${SECURITY_CONTACT}`}
          copyValue={SECURITY_CONTACT}
        />
        <LinkRow
          testId="issue"
          label={t('modals.about.contactIssue')}
          text={t('modals.about.contactIssueAction')}
          href={APP_NEW_ISSUE_URL}
        />
        <LinkRow
          testId="feedback"
          label={t('modals.about.contactFeedback')}
          text={FEEDBACK_CONTACT}
          href={`mailto:${FEEDBACK_CONTACT}`}
          copyValue={FEEDBACK_CONTACT}
        />

        {/* The community rows below split by UI language, because the channels
            themselves do. English gets the English Discord server; Chinese gets
            the Chinese one plus the WeChat group, which has no English-speaking
            counterpart to offer. X is one account for everyone. */}
        <LinkRow
          testId="x"
          label={t('modals.about.contactX')}
          text={SOCIAL_X_HANDLE}
          href={SOCIAL_X_URL}
        />
        <LinkRow
          testId="discord"
          label={t('modals.about.contactDiscord')}
          text={t('modals.about.contactDiscordAction')}
          href={DISCORD_INVITE_URL[locale]}
        />
        {locale === 'zh' && <WechatRow />}
      </Card>

      {/* AGPL §5(a) requires modified versions to carry appropriate legal notices,
          and this is where the desktop client carries the copyright one. */}
      <div className="text-xs text-text-tertiary px-1">
        © {COPYRIGHT_YEAR} {COPYRIGHT_HOLDER}
      </div>
    </div>
  )
}

interface AboutRowProps {
  label: string
  description?: string
  children?: React.ReactNode
}

/** One label/value line. `description` renders as a muted second line. */
function AboutRow({ label, description, children }: AboutRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm text-text-primary">{label}</div>
        {description && (
          <div className="text-xs text-text-secondary mt-0.5 leading-relaxed">{description}</div>
        )}
      </div>
      {children && <div className="flex-shrink-0">{children}</div>}
    </div>
  )
}

interface LinkRowProps {
  /** Suffix for the `about-link-*` / `about-copy-*` hooks. */
  testId: string
  label: string
  /** Link text. The address itself for mail rows, a name for everything else. */
  text: string
  /** `mailto:` for addresses, https for the repository and the issue tracker. */
  href: string
  /** Present → render the copy button. Absent → the text is a name, not a value
   *  worth putting on the clipboard, so the row shows an external-link hint. */
  copyValue?: string
}

/**
 * One "label → somewhere to go" line, with an optional copy button.
 *
 * Named for the shape rather than for contacts specifically: the repository row
 * is the same widget pointed at an https URL, and calling it `ContactRow` while
 * it renders a source-code link would be a lie in the name.
 *
 * Both affordances are here because they serve different situations — clicking
 * only helps if a mail client is configured on this machine, which on a work
 * desktop it often is not, and copying is what lets the address reach webmail or
 * a phone.
 *
 * The copy state is local rather than a toast: the confirmation belongs next to
 * the button that was pressed, and About can show several rows at once.
 */
function LinkRow({ testId, label, text, href, copyValue }: LinkRowProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)

  // Unmounting mid-confirmation (closing Settings right after copying) would
  // otherwise leave a timer that calls setState on a dead component.
  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    },
    [],
  )

  const open = () => {
    void window.api.shell
      .openExternal(href)
      .catch((error: unknown) => rlog.warn('[about] opening contact target failed', error))
  }

  const copy = () => {
    if (copyValue === undefined) return
    void navigator.clipboard
      .writeText(copyValue)
      .then(() => {
        setCopied(true)
        if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
        resetTimerRef.current = window.setTimeout(() => setCopied(false), 1500)
      })
      .catch((error: unknown) => rlog.warn('[about] copying contact failed', error))
  }

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0 text-sm text-text-primary">{label}</div>
      <div className="flex flex-shrink-0 items-center gap-1">
        <button
          type="button"
          data-testid={`about-link-${testId}`}
          onClick={open}
          className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-brand-blue hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {text}
          {copyValue === undefined && <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
        {copyValue !== undefined && (
          <button
            type="button"
            data-testid={`about-copy-${testId}`}
            onClick={copy}
            aria-label={`${t('modals.about.contactCopy')} ${copyValue}`}
            title={copied ? t('modals.about.contactCopied') : t('modals.about.contactCopy')}
            className="cursor-pointer rounded p-1 text-text-tertiary transition-colors hover:bg-bg-surface hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-status-success" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * WeChat group QR code, behind a disclosure.
 *
 * Not a `LinkRow` with an image bolted on: there is no URL here at all. Joining
 * is a scan from a phone, so nothing about this row can be handed to
 * `openExternal` or put on the clipboard, and teaching `LinkRow` a third mode
 * would make its name describe only two thirds of it.
 *
 * Collapsed by default because the code is a ~160px square and About is
 * otherwise a page of single-line rows — expanded by default it would push the
 * copyright notice below the fold for the one language that shows it.
 *
 * The image needs no backing plate: it is opaque white and already carries the
 * quiet zone a scanner wants, so it stays legible on the dark theme as-is.
 */
function WechatRow() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 text-sm text-text-primary">{t('modals.about.contactWechat')}</div>
        <button
          type="button"
          data-testid="about-wechat-toggle"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          className="inline-flex flex-shrink-0 cursor-pointer items-center gap-1.5 text-xs font-medium text-brand-blue hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {open ? t('modals.about.contactWechatHide') : t('modals.about.contactWechatShow')}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
      </div>
      {open && (
        <div className="mt-3 flex flex-col items-center gap-2">
          <img
            data-testid="about-wechat-qr"
            src={wechatQrUrl}
            alt={t('modals.about.contactWechatAlt')}
            className="h-40 w-40 rounded"
          />
          <span className="text-xs text-text-tertiary">{t('modals.about.contactWechatHint')}</span>
        </div>
      )}
    </div>
  )
}

/** Status text next to the update button. Muted except when something failed. */
function UpdateStateLabel({ state }: { state: UpdateRowState }) {
  const { t } = useTranslation()

  if (state.kind === 'unknown') return null
  if (state.kind === 'failed') {
    // "No build for this CPU" is not a transient error and retrying will never
    // help, so it must not read like a network hiccup. Reachable whenever the
    // feed is missing this machine's architecture — which is exactly what Intel
    // hit before the arm64/x64 feeds were merged.
    const key =
      state.code === 'ERR_UPDATER_ZIP_FILE_NOT_FOUND'
        ? 'modals.about.updateNoBuildForArch'
        : 'modals.about.updateFailed'
    return <span className="text-xs text-status-error">{t(key)}</span>
  }

  let text: string
  if (state.kind === 'disabled') {
    text = t('modals.about.updateDisabled')
  } else if (state.kind === 'checking') {
    text = t('modals.about.updateChecking')
  } else if (state.kind === 'downloading') {
    text = t('modals.about.updateDownloading', { percent: state.percent })
  } else if (state.kind === 'staged') {
    text = t('modals.about.updateStaged', { version: state.version })
  } else {
    text = t('modals.about.updateUpToDate')
  }
  return <span className="text-xs text-text-tertiary">{text}</span>
}
