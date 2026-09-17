import type { OfficeCloseDecision, OfficeFilesAPI } from '../../../shared/office-files'
import { i18n } from '../i18n'

export function officeFiles(): OfficeFilesAPI {
  if (!window.officeFiles) throw new Error('Office file storage is unavailable')
  return window.officeFiles
}

/** A canceled or unsuccessful save must keep the document open. */
export async function confirmOfficeClose(name: string, save: () => Promise<boolean>): Promise<boolean> {
  const choice: OfficeCloseDecision = await officeFiles().confirmClose(name, i18n.language)
  if (choice === 'cancel') return false
  if (choice === 'discard') return true
  return save()
}
