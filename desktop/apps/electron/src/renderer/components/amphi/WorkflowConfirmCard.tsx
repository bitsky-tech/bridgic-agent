import { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { MessageBlock } from '@/atoms/agent'
import {
  activeSessionWorkflowsAtom,
  confirmWorkflowBuildAtom,
  workflowsAtom,
} from '@/atoms/workflows'
import { activeSessionIdAtom, requestComposerInsertAtom } from '@/atoms/sessions'
import { ComposerTarget, ModalKind, openModalAtom } from '@/atoms/amphi'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import { cn } from '@/lib/cn'
import { Icons } from './Icons'
import { Badge } from './Primitives'

type WorkflowConfirmBlock = Extract<MessageBlock, { type: 'workflow_confirm' }>
type WorkflowConfirmAction = 'confirm' | 'save_as_new' | 'cancel'

/** Workflow status → badge color. */
function pickStatusBadgeColor(status: string) {
  if (status === 'confirmed') return 'success'
  if (status === 'cancelled') return 'default'
  return 'brand'
}

/** Workflow status → badge icon. */
function pickStatusIcon(status: string) {
  if (status === 'confirmed') return Icons.check(12)
  if (status === 'cancelled') return Icons.x(12)
  return Icons.workflow(12)
}

/** Workflow status → badge label. */
function pickStatusLabel(status: string, editing: boolean, t: TFunction): string {
  if (status === 'confirmed') return t('workflow.confirm.status.buildSuccess')
  if (status === 'cancelled') return t('workflow.confirm.status.cancelled')
  if (status === 'continued') return editing
    ? t('workflow.confirm.status.updating')
    : t('workflow.confirm.status.saving')
  return editing ? t('workflow.confirm.status.editDone') : t('workflow.confirm.status.buildDone')
}

/** Card description text (pending / saved / not saved). */
function pickDescription(status: string, pending: boolean, editing: boolean, t: TFunction): string {
  if (editing && pending) return t('workflow.confirm.desc.editPending')
  if (pending) return t('workflow.confirm.desc.pending')
  if (status === 'continued') return editing
    ? t('workflow.confirm.desc.continuedEdit')
    : t('workflow.confirm.desc.continued')
  if (status === 'confirmed') return editing
    ? t('workflow.confirm.desc.confirmedEdit')
    : t('workflow.confirm.desc.confirmed')
  return t('workflow.confirm.desc.notSaved')
}

/** Confirm button label (submitting / updating an existing one / creating a new one). */
function pickConfirmLabel(busy: WorkflowConfirmAction | null, editing: boolean, t: TFunction): string {
  if (busy === 'confirm') return t('workflow.confirm.status.saving')
  return editing ? t('workflow.confirm.confirmUpdate') : t('workflow.common.confirm')
}

export function WorkflowConfirmCard({ block, floating = false }: { block: WorkflowConfirmBlock; floating?: boolean }) {
  const { t } = useTranslation()
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const workflows = useAtomValue(workflowsAtom)
  const sessionWorkflows = useAtomValue(activeSessionWorkflowsAtom)
  const confirmWorkflow = useSetAtom(confirmWorkflowBuildAtom)
  const requestComposerInsert = useSetAtom(requestComposerInsertAtom)
  const openModal = useSetAtom(openModalAtom)
  const status = block.status ?? 'pending'
  const pending = status === 'pending'
  const editing = block.operation === 'edit'
  const currentName = block.workflowId
    ? workflows.find((workflow) => workflow.id === block.workflowId)?.name
      ?? sessionWorkflows.find((workflow) => workflow.id === block.workflowId)?.name
    : undefined
  const originalName = currentName || block.defaultName
  const [name, setName] = useState(
    block.name || (editing ? t('workflow.confirm.copyName', { name: originalName }) : block.defaultName),
  )
  const [saveAsNewOpen, setSaveAsNewOpen] = useState(false)
  const [busy, setBusy] = useState<WorkflowConfirmAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const displayName = currentName || block.name || name || block.defaultName

  function runWorkflow() {
    if (!block.workflowId) return
    requestComposerInsert([
      {
        type: 'slash',
        id: block.workflowId,
        label: displayName,
        resource: 'workflow',
      },
      { type: 'text', value: ' ' },
    ])
  }

  async function submit(action: WorkflowConfirmAction) {
    if (!activeSessionId || busy) return
    let submittedName = name
    if (editing && action !== 'save_as_new') submittedName = originalName
    const trimmed = submittedName.trim()
    if (action !== 'cancel' && !trimmed) {
      setError(t('workflow.confirm.nameRequired'))
      return
    }
    setBusy(action)
    setError(null)
    try {
      await confirmWorkflow({
        sessionId: activeSessionId,
        requestId: block.requestId,
        action,
        name: action !== 'cancel' ? trimmed : undefined,
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('workflow.common.actionFailed'))
    } finally {
      setBusy(null)
    }
  }

  if (status === 'confirmed') {
    const successTitle = editing
      ? t('workflow.confirm.successTitle.edit')
      : t('workflow.confirm.successTitle.create')
    const successDescription = editing
      ? t('workflow.confirm.successDesc.edit', { name: displayName })
      : t('workflow.confirm.successDesc.create', { name: displayName })

    return (
      <section
        role="status"
        aria-label={successTitle}
        className={cn(
          'rounded-lg border border-status-success bg-status-success-bg px-3.5 py-3',
          floating ? 'w-full' : 'max-w-3xl',
        )}
      >
        <div className="flex items-start gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-status-success bg-bg-elevated text-status-success"
          >
            {Icons.check(17)}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-text-primary">{successTitle}</h3>
            <p className="mt-0.5 text-sm leading-5 text-text-secondary">{successDescription}</p>
            {block.summary ? (
              <MarkdownMessage
                content={block.summary}
                density="compact"
                className="mt-1.5 max-h-16 overflow-y-auto text-xs leading-5 text-text-tertiary"
              />
            ) : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="inline-flex items-center gap-1 text-xs font-medium text-status-success">
                {Icons.workflow(12)} {t('workflow.confirm.reusable')}
              </span>
              {block.workflowId ? (
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => openModal({
                      type: ModalKind.WorkflowDetail,
                      workflowId: block.workflowId!,
                      workflowName: displayName,
                      composerTarget: ComposerTarget.CurrentSession,
                    })}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  >
                    {Icons.eye(13)} {t('workflow.confirm.viewWorkflow')}
                  </button>
                  <button
                    type="button"
                    onClick={runWorkflow}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-text-accent hover:bg-bg-hover"
                  >
                    {Icons.play(11)} {t('workflow.confirm.runNow')}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <div className={floating ? 'w-full' : 'rounded-lg border border-border-subtle bg-bg-elevated p-3.5'}>
      <div className="flex items-center gap-2">
        <Badge color={pickStatusBadgeColor(status)}>
          <span className="inline-flex items-center gap-1">
            {pickStatusIcon(status)}
            {pickStatusLabel(status, editing, t)}
          </span>
        </Badge>
      </div>

      <div className="mt-3 text-sm text-text-secondary leading-[1.6]">
        {editing && pending && saveAsNewOpen
          ? t('workflow.confirm.desc.saveAsNew')
          : pickDescription(status, pending, editing, t)}
      </div>

      {block.summary && (
        <MarkdownMessage
          content={block.summary}
          density="compact"
          className="mt-2 max-h-24 overflow-y-auto text-xs leading-[1.6] text-text-tertiary"
        />
      )}

      {editing && pending ? (
        <div className="mt-3 space-y-3">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="shrink-0 text-xs font-medium text-text-tertiary">
              {t('workflow.confirm.originalWorkflow')}
            </span>
            <span className="truncate font-medium text-text-primary">{originalName}</span>
          </div>

          {saveAsNewOpen ? (
            <form
              className="space-y-3 rounded-md border border-border-subtle bg-bg-hover p-3"
              onSubmit={(event) => {
                event.preventDefault()
                void submit('save_as_new')
              }}
            >
              <label className="block min-w-0">
                <span className="mb-1 block text-xs font-medium text-text-tertiary">
                  {t('workflow.confirm.newWorkflowName')}
                </span>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    setError(null)
                  }}
                  disabled={busy !== null}
                  aria-invalid={Boolean(error)}
                  className={cn(
                    'h-10 w-full rounded-md border border-border-subtle bg-bg-input px-3 text-sm text-text-primary outline-none',
                    'disabled:cursor-default disabled:opacity-80',
                    error ? 'border-status-error focus:border-status-error' : 'focus:border-brand-blue',
                  )}
                />
              </label>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    setSaveAsNewOpen(false)
                    setError(null)
                  }}
                  className="h-10 px-3 rounded-md text-sm font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-50"
                >
                  {t('workflow.confirm.back')}
                </button>
                <button
                  type="submit"
                  disabled={busy !== null || !name.trim()}
                  className="h-10 px-4 rounded-md text-sm font-semibold text-text-on-brand bg-[image:var(--brand-gradient)] disabled:opacity-50"
                >
                  {busy === 'save_as_new'
                    ? t('workflow.confirm.status.saving')
                    : t('workflow.confirm.createNew')}
                </button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void submit('cancel')}
                className="h-10 px-3 rounded-md text-sm font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-50"
              >
                {t('workflow.confirm.continueEditing')}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setSaveAsNewOpen(true)
                  setError(null)
                }}
                className="h-10 px-3 rounded-md border border-border-subtle text-sm font-semibold text-text-primary hover:bg-bg-hover disabled:opacity-50"
              >
                {t('workflow.confirm.saveAsNew')}
              </button>
              <button
                type="button"
                disabled={busy !== null || !originalName.trim()}
                onClick={() => void submit('confirm')}
                className="h-10 px-4 rounded-md text-sm font-semibold text-text-on-brand bg-[image:var(--brand-gradient)] disabled:opacity-50"
              >
                {busy === 'confirm'
                  ? t('workflow.confirm.status.updating')
                  : t('workflow.confirm.overwriteOriginal')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          {editing ? (
            <div className="min-w-0 flex-1 h-10 rounded-md border border-border-subtle bg-bg-input px-3 text-sm text-text-primary flex items-center">
              <span className="truncate">{displayName}</span>
            </div>
          ) : (
            <input
              value={pending ? name : displayName}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              disabled={!pending || busy !== null}
              aria-invalid={Boolean(error)}
              className={cn(
                'min-w-0 flex-1 h-10 rounded-md border border-border-subtle bg-bg-input px-3 text-sm text-text-primary outline-none',
                'disabled:cursor-default disabled:opacity-80',
                error ? 'border-status-error focus:border-status-error' : 'focus:border-brand-blue',
              )}
            />
          )}
          {pending ? (
            <>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void submit('cancel')}
                className="h-10 px-3 rounded-md text-sm font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-50"
              >
                {editing ? t('workflow.confirm.continueEditing') : t('workflow.common.cancel')}
              </button>
              <button
                type="button"
                disabled={busy !== null || !(editing ? originalName : name).trim()}
                onClick={() => void submit('confirm')}
                className="h-10 px-4 rounded-md text-sm font-semibold text-text-on-brand bg-[image:var(--brand-gradient)] disabled:opacity-50"
              >
                {pickConfirmLabel(busy, editing, t)}
              </button>
            </>
          ) : null}
        </div>
      )}

      {error && <div role="alert" className="mt-2 text-xs text-status-error">{error}</div>}
    </div>
  )
}
