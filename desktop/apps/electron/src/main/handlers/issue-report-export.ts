import path from 'node:path'
import { ISSUE_REPORT_FILE_STEM } from '../../shared/app-meta'
import type {
  IssueReportExportRequest,
  IssueReportExportResult,
} from '../../shared/types'

interface IssueReportDestination {
  canceled: boolean
  filePath?: string
}

export interface IssueReportExporterDependencies {
  selectDestination(suggestedName: string): Promise<IssueReportDestination>
  writeUtf8(filePath: string, content: string): Promise<void>
}

const DEFAULT_REPORT_NAME = `${ISSUE_REPORT_FILE_STEM}.md`
const MAX_FILE_NAME_LENGTH = 120

function markdownFileName(input: unknown): string {
  if (typeof input !== 'string') return DEFAULT_REPORT_NAME
  const basename = path.win32.basename(path.posix.basename(input.trim()))
  const printable = Array.from(basename, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 ? '-' : character
  }).join('')
  const safe = printable.replace(/[<>:"/\\|?*]/g, '-').trim()
  const stem = safe.replace(/\.md$/i, '').replace(/\.[^.]+$/, '').replace(/^\.+$/, '').trim()
  if (!stem) return DEFAULT_REPORT_NAME
  return `${stem.slice(0, MAX_FILE_NAME_LENGTH - 3)}.md`
}

function markdownPath(filePath: string): string {
  return filePath.toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`
}

/**
 * Owns the user-confirmed export flow for an oversized issue report.
 *
 * The renderer supplies only content and a suggested file name. It never
 * supplies the destination path; that value must come from the native dialog.
 */
export class IssueReportExporter {
  constructor(private readonly dependencies: IssueReportExporterDependencies) {}

  async exportFile(request: IssueReportExportRequest): Promise<IssueReportExportResult> {
    try {
      if (!request || typeof request.content !== 'string') throw new Error('Invalid report')
      const destination = await this.dependencies.selectDestination(
        markdownFileName(request.suggestedName),
      )
      if (destination.canceled || !destination.filePath) {
        return { ok: false, reason: 'cancelled' }
      }
      const target = markdownPath(destination.filePath)
      await this.dependencies.writeUtf8(target, request.content)
      return { ok: true, path: target }
    } catch {
      // Do not surface OS errors: they commonly contain the user's private path.
      throw new Error('Failed to export feedback report')
    }
  }
}

/** Keep report content and renderer-supplied path fragments out of IPC logs. */
export function redactIssueReportExportLogArgs(args: readonly unknown[]): unknown {
  const request = args[0]
  if (!request || typeof request !== 'object') {
    return [{ suggestedName: DEFAULT_REPORT_NAME, contentLength: 0 }]
  }
  const values = request as Partial<IssueReportExportRequest>
  return [{
    suggestedName: markdownFileName(values.suggestedName),
    contentLength: typeof values.content === 'string' ? values.content.length : 0,
  }]
}
