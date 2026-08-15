import { describe, expect, it, mock } from 'bun:test'
import {
  IssueReportExporter,
  redactIssueReportExportLogArgs,
} from '../issue-report-export'

describe('IssueReportExporter', () => {
  it('uses only a safe Markdown basename and writes the selected file as UTF-8 content', async () => {
    const selectDestination = mock(async () => ({
      canceled: false,
      filePath: '/chosen/feedback',
    }))
    const writeUtf8 = mock(async () => {})
    const exporter = new IssueReportExporter({ selectDestination, writeUtf8 })

    const result = await exporter.exportFile({
      suggestedName: '/private/parent/feedback-secret.txt',
      content: '# 完整反馈\n工具输出',
    })

    expect(selectDestination).toHaveBeenCalledWith('feedback-secret.md')
    expect(writeUtf8).toHaveBeenCalledWith('/chosen/feedback.md', '# 完整反馈\n工具输出')
    expect(result).toEqual({ ok: true, path: '/chosen/feedback.md' })
  })

  it('returns a typed cancellation without writing', async () => {
    const writeUtf8 = mock(async () => {})
    const exporter = new IssueReportExporter({
      selectDestination: async () => ({ canceled: true }),
      writeUtf8,
    })

    await expect(exporter.exportFile({ suggestedName: 'feedback.md', content: 'body' }))
      .resolves.toEqual({ ok: false, reason: 'cancelled' })
    expect(writeUtf8).not.toHaveBeenCalled()
  })

  it('keeps an existing Markdown extension and sanitizes control characters', async () => {
    const selectDestination = mock(async () => ({
      canceled: false,
      filePath: '/chosen/report.MD',
    }))
    const exporter = new IssueReportExporter({
      selectDestination,
      writeUtf8: async () => {},
    })

    await exporter.exportFile({ suggestedName: '../bad\nname?.MD', content: 'body' })

    expect(selectDestination).toHaveBeenCalledWith('bad-name-.md')
  })

  it('does not leak a selected path when writing fails', async () => {
    const exporter = new IssueReportExporter({
      selectDestination: async () => ({
        canceled: false,
        filePath: '/Users/private-user/secret-folder/report.md',
      }),
      writeUtf8: async (filePath) => {
        throw new Error(`EACCES: ${filePath}`)
      },
    })

    try {
      await exporter.exportFile({ suggestedName: 'feedback.md', content: 'private body' })
      throw new Error('expected export to fail')
    } catch (error) {
      expect(String(error)).toBe('Error: Failed to export feedback report')
      expect(String(error)).not.toContain('private-user')
      expect(String(error)).not.toContain('private body')
    }
  })
})

describe('redactIssueReportExportLogArgs', () => {
  it('logs only a safe file name and content length', () => {
    const logged = redactIssueReportExportLogArgs([{
      suggestedName: '/Users/private-user/secret/report.md',
      content: 'token=do-not-log',
    }])

    expect(logged).toEqual([{ suggestedName: 'report.md', contentLength: 16 }])
    const serialized = JSON.stringify(logged)
    expect(serialized).not.toContain('private-user')
    expect(serialized).not.toContain('do-not-log')
  })
})
