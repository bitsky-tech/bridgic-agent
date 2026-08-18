/**
 * Skill import wizard (container) — choose a method (local directory / remote GitHub address) → scan + conflict pre-check →
 * decide item by item → install → result.
 *
 * Both sources share the same backend flow and subsequent steps: local picks a directory via `dialog:open`; remote hands the
 * github.com URL the user typed to the very same `scanSkillsAtom` verbatim (the backend downloads it to a temp directory and then
 * scans it, supporting repository root / `tree` / `blob` SKILL.md URL shapes). The wizard state (step / method / scan results /
 * per-item decisions) is modal-local and held in useState; the three network actions scan / check / import are issued through
 * atoms/skills' write atoms. The presentational step components live in `SkillImportPick.tsx` (step one) and
 * `SkillImportSteps.tsx` (review / result).
 *
 * Decisions are keyed by each row's unique `local_path` — a remote repository scan gives multiple Skills from the same repository
 * an identical `source_uri`, so keying by that would collide.
 */
import { useState } from 'react'
import { useSetAtom } from 'jotai'
import { Trans, useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { checkSkillImportAtom, importSkillsAtom, scanSkillsAtom } from '@/atoms/skills'
import { detectSkillRemoteSource } from '@/lib/skillImportSource'
import type {
  ImportCheckResult,
  ImportSummary,
  ScannedSkill,
  SkillImportItem,
} from '@/lib/amphiClient'
import { Icons } from './Icons'
import { Modal } from './Modal'
import { Btn } from './Primitives'
import { isNewer } from './SkillConflictRow'
import { ImportMethod, ImportPickStep } from './SkillImportPick'
import { ImportResultStep, ImportReviewStep, type ReviewItem } from './SkillImportSteps'

/** Wizard steps (closed state set, §4.11): a single source of truth reused for the useState initial value and for comparisons in each branch. */
const Step = { Pick: 'pick', Review: 'review', Result: 'result' } as const
type Step = (typeof Step)[keyof typeof Step]

/** Map a scan row to the import-request element handed back to the daemon.
 *  `local_path` (the copy source) is load-bearing — a remote scan's `local_path`
 *  is a temp download dir distinct from `source_uri` (the github.com URL). */
function toItem(s: ScannedSkill): SkillImportItem {
  return {
    name: s.name,
    source_uri: s.source_uri,
    local_path: s.local_path,
    description: s.description,
    source: s.source,
    updated_at: s.updated_at,
  }
}

/** Initial per-item decision keyed by `local_path`: new → import (true);
 *  conflict → keep current (false), the safe default. */
function initDecisions(rows: ScannedSkill[], checks: ImportCheckResult[]): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  rows.forEach((s, i) => {
    out[s.local_path] = checks[i]?.conflict ? false : true
  })
  return out
}

/** The import wizard modal. Mounted by ActiveModalHost on `ModalKind.SkillImport`. */
export function SkillImportModal({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation()
  const scan = useSetAtom(scanSkillsAtom)
  const check = useSetAtom(checkSkillImportAtom)
  const runImport = useSetAtom(importSkillsAtom)

  const [step, setStep] = useState<Step>(Step.Pick)
  const [method, setMethod] = useState<ImportMethod>(ImportMethod.Local)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // `source` records which method produced the reviewed rows (drives the Review
  // source bar). `path` is the display string — the picked dir or the repo URL.
  const [source, setSource] = useState<ImportMethod>(ImportMethod.Local)
  const [path, setPath] = useState('')
  const [rows, setRows] = useState<ScannedSkill[]>([])
  const [checks, setChecks] = useState<ImportCheckResult[]>([])
  const [decide, setDecide] = useState<Record<string, boolean>>({})
  const [summary, setSummary] = useState<ImportSummary | null>(null)

  const remoteSource = detectSkillRemoteSource(remoteUrl)
  // Review source-bar badge (GitHub / skills.sh), derived from the scanned
  // source; undefined for a local import (its bar shows no badge).
  const remoteBadge =
    source === ImportMethod.Remote ? detectSkillRemoteSource(path)?.badge : undefined

  const review: ReviewItem[] = rows.map((s, i) => ({
    scanned: s,
    conflict: checks[i]?.conflict ?? false,
    existing: checks[i]?.existing ?? null,
  }))
  const willImport = rows.filter((s) => decide[s.local_path]).length
  const conflictItems = review.filter((r) => r.conflict)
  const replaceCount = conflictItems.filter((r) => decide[r.scanned.local_path]).length
  const keepCount = conflictItems.length - replaceCount
  const newCount = review.filter((r) => !r.conflict && decide[r.scanned.local_path]).length
  const newerSkipped = conflictItems.filter(
    (r) => !decide[r.scanned.local_path] && isNewer(r.scanned.updated_at, r.existing?.updated_at ?? null),
  ).length

  // Shared scan → check → Review transition for both methods. `input` is a
  // daemon-side absolute dir (local) or a github.com URL (remote).
  const runScan = async (input: string, from: ImportMethod) => {
    setBusy(true)
    setError(null)
    try {
      const scanned = await scan(input)
      const verdicts = scanned.length ? await check(scanned.map(toItem)) : []
      setSource(from)
      setPath(input)
      setRows(scanned)
      setChecks(verdicts)
      setDecide(initDecisions(scanned, verdicts))
      setStep(Step.Review)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handlePickLocal = async () => {
    setError(null)
    let picked: string
    try {
      const res = await window.api.dialog.open({ properties: ['openDirectory'] })
      if (res.canceled || res.filePaths.length === 0) return
      picked = res.filePaths[0]!
    } catch {
      setError(t('skill.import.modal.directoryPickerFailed'))
      return
    }
    await runScan(picked, ImportMethod.Local)
  }

  const handleImportRemote = () => {
    const url = remoteUrl.trim()
    if (!detectSkillRemoteSource(url)?.importable) return
    void runScan(url, ImportMethod.Remote)
  }

  const handleImport = async () => {
    const payload = rows.filter((s) => decide[s.local_path]).map(toItem)
    setBusy(true)
    setError(null)
    try {
      setSummary(await runImport(payload))
      setStep(Step.Result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleDecide = (key: string, value: boolean) => setDecide((d) => ({ ...d, [key]: value }))
  const batchConflicts = (replaceAll: boolean) =>
    setDecide((d) => {
      const next = { ...d }
      review.forEach((r) => {
        if (r.conflict) next[r.scanned.local_path] = replaceAll
      })
      return next
    })

  return (
    <Modal width={800} title={t('skill.import.modal.title')} onClose={onClose}>
      {step === Step.Pick && (
        <ImportPickStep
          method={method}
          onMethodChange={setMethod}
          busy={busy}
          onPickLocal={handlePickLocal}
          remoteUrl={remoteUrl}
          onRemoteUrlChange={setRemoteUrl}
          remoteSource={remoteSource}
          onSubmitRemote={handleImportRemote}
        />
      )}
      {step === Step.Review && (
        <ImportReviewStep
          source={source}
          path={path}
          remoteBadge={remoteBadge}
          review={review}
          decide={decide}
          onToggle={toggleDecide}
          onBatch={batchConflicts}
        />
      )}
      {step === Step.Result && summary && <ImportResultStep summary={summary} />}

      {error && <div className="px-6 text-xs text-status-error">{error}</div>}

      {step === Step.Review && newerSkipped > 0 && (
        <div className="px-6 pt-2 flex items-center gap-2 text-xs text-text-secondary">
          <span className="flex shrink-0 text-text-tertiary">{Icons.clock(13)}</span>
          <Trans
            i18nKey="skill.import.modal.newerSkipped"
            values={{ n: newerSkipped }}
            components={{ b: <strong className="text-text-primary" /> }}
          />
          <button
            type="button"
            className="font-semibold text-text-accent"
            onClick={() => batchConflicts(true)}
          >
            {t('skill.import.review.replaceAll')}
          </button>
        </div>
      )}

      <div className="px-5 py-3.5 mt-2 border-t border-border-subtle flex items-center justify-between">
        <span className="text-xs text-text-tertiary">
          {step === Step.Review && (
            <>
              <Trans
                i18nKey="skill.import.modal.summary"
                values={{ total: willImport, new: newCount }}
                components={{ b: <strong className="text-text-primary" /> }}
              />
              {conflictItems.length > 0 && (
                <>
                  <Trans
                    i18nKey="skill.import.modal.summaryConflicts"
                    values={{ replaced: replaceCount, kept: keepCount }}
                    components={{ muted: <span className="text-text-tertiary" /> }}
                  />
                </>
              )}
            </>
          )}
        </span>
        <div className="flex gap-2.5">
          {step === Step.Result ? (
            <Btn variant="primary" size="md" onClick={onClose}>
              {t('skill.import.modal.done')}
            </Btn>
          ) : (
            <Btn onClick={onClose}>{t('common.cancel')}</Btn>
          )}
          {step === Step.Pick && method === ImportMethod.Remote && (
            <Btn
              variant="primary"
              size="md"
              className={cn((busy || !remoteSource?.importable) && 'opacity-50 pointer-events-none')}
              onClick={handleImportRemote}
            >
              {Icons.download(14)} {busy ? t('skill.import.modal.parsing') : t('center.common.import')}
            </Btn>
          )}
          {step === Step.Review && (
            <Btn
              variant="primary"
              size="md"
              className={cn((busy || willImport === 0) && 'opacity-50 pointer-events-none')}
              onClick={handleImport}
            >
              {Icons.download(14)} {busy ? t('skill.import.modal.importing') : t('skill.import.modal.confirmImport', { n: willImport })}
            </Btn>
          )}
        </div>
      </div>
    </Modal>
  )
}
