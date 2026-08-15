/**
 * Modal host — routes activeModalAtom's ModalKey discriminated union to the concrete Modal component.
 *
 * Self-contained reads/writes: renders null when activeModal is null; the switch has no default, so adding a new
 * ModalKind makes typecheck report not-exhaustive here, forcing the case to be added.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { activeModalAtom, closeModalAtom, ModalKind, type ModalKey } from '@/atoms/amphi'
import { removeSessionAtom } from '@/atoms/sessions'
import { deleteSkillAtom } from '@/atoms/skills'
import { SettingsTabId } from '@/components/amphi/Modals'
import {
  DeleteConfirmModal,
  DependencyCheckModal,
  EditFieldModal,
  FileOpenConfirmModal,
  MarketPreviewModal,
  PreviewFieldModal,
  SessionDeleteModal,
  SettingsModal,
  SkillDeleteModal,
  SkillImportModal,
  WorkflowDetailModal,
  WorkflowRunDetailModal,
} from '@/components/amphi'
import { SubagentModal } from '@/components/amphi/SubagentModal'

/** ModalKey → Modal component switch routing (a pure mapping, stateless). */
function ModalSwitch({ modal, onClose }: { modal: ModalKey; onClose: () => void }) {
  const removeSession = useSetAtom(removeSessionAtom)
  const deleteSkill = useSetAtom(deleteSkillAtom)
  switch (modal.type) {
    case ModalKind.Settings:
      return <SettingsModal initialTab={modal.initialTab ?? SettingsTabId.Model} onClose={onClose} />
    case ModalKind.WorkflowDetail:
      return (
        <WorkflowDetailModal
          key={modal.workflowId ?? 'workflow-detail'}
          workflowId={modal.workflowId}
          name={modal.workflowName}
          composerTarget={modal.composerTarget}
          onClose={onClose}
        />
      )
    case ModalKind.WorkflowRunDetail:
      return (
        <WorkflowRunDetailModal
          key={`${modal.runId}:${modal.initialFilePath ?? ''}`}
          runId={modal.runId}
          initialFilePath={modal.initialFilePath}
          composerTarget={modal.composerTarget}
          onClose={onClose}
        />
      )
    case ModalKind.MarketPreview:
      return <MarketPreviewModal workflow={modal.workflow} onClose={onClose} />
    case ModalKind.DeleteConfirm:
      return (
        <DeleteConfirmModal
          type={modal.target}
          name={modal.name}
          relatedCount={modal.relatedCount}
          onClose={onClose}
        />
      )
    case ModalKind.EditField:
      return (
        <EditFieldModal
          field={modal.field}
          title={modal.title}
          hasChange={modal.hasChange}
          onClose={onClose}
        />
      )
    case ModalKind.PreviewField:
      return <PreviewFieldModal field={modal.field} onClose={onClose} />
    case ModalKind.DependencyCheck:
      return <DependencyCheckModal allGood={modal.allGood} onClose={onClose} />
    case ModalKind.SessionDelete:
      return (
        <SessionDeleteModal
          name={modal.name}
          onConfirm={() => removeSession(modal.id)}
          onClose={onClose}
        />
      )
    case ModalKind.FileOpenConfirm:
      return <FileOpenConfirmModal path={modal.path} name={modal.name} onClose={onClose} />
    case ModalKind.SkillImport:
      return <SkillImportModal onClose={onClose} />
    case ModalKind.SkillDelete:
      return (
        <SkillDeleteModal
          name={modal.name}
          onConfirm={() => deleteSkill(modal.skillId)}
          onClose={onClose}
        />
      )
    case ModalKind.Subagent:
      return (
        <SubagentModal
          invocationId={modal.invocationId}
          goal={modal.goal}
          status={modal.status}
          onClose={onClose}
        />
      )
  }
}

/** The currently active modal (null when there is none). Mounted after AppLayout and before ToastHost. */
export function ActiveModalHost() {
  const activeModal = useAtomValue(activeModalAtom)
  const closeModal = useSetAtom(closeModalAtom)
  if (!activeModal) return null
  return <ModalSwitch modal={activeModal} onClose={() => closeModal()} />
}
