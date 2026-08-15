import { describe, expect, it } from 'bun:test'
import { APP_NEW_ISSUE_URL } from '../app-meta'
import {
  buildIssueReportBody,
  buildIssueReportUrl,
  ISSUE_REPORT_URL_MAX_LENGTH,
  IssueReportUrlTooLongError,
  planIssueReport,
} from '../issue-report'

describe('issue report URL builder', () => {
  it('returns the exact unparameterized destination when nothing is selected', () => {
    expect(buildIssueReportUrl()).toBe(APP_NEW_ISSUE_URL)
    expect(buildIssueReportUrl({ title: '  ', sections: [{ heading: 'Context', content: ' ' }] }))
      .toBe(APP_NEW_ISSUE_URL)
  })

  it('keeps the destination fixed and round-trips user text through URLSearchParams', () => {
    const title = '窗口异常 & body=https://evil.example/#片段'
    const url = new URL(buildIssueReportUrl({
      title,
      sections: [{ heading: '补充说明', content: '包含 ?、&、# 和中文。' }],
    }))

    expect(url.origin).toBe('https://github.com')
    expect(url.pathname).toBe('/bitsky-tech/bridgic-agent/issues/new')
    expect(url.searchParams.get('title')).toBe(title)
    expect(url.searchParams.get('body')).toBe('## 补充说明\n\n包含 ?、&、# 和中文。')
    expect([...url.searchParams.keys()].sort()).toEqual(['body', 'title'])
  })

  it('filters blank sections and flattens heading newlines', () => {
    expect(buildIssueReportBody([
      { heading: '本轮\n上下文', content: 'selected' },
      { heading: '系统信息', content: '   ' },
      { heading: '   ', content: 'hidden' },
    ])).toBe('## 本轮 上下文\n\nselected')
  })

  it('uses a fence longer than every backtick run in selected code', () => {
    const body = buildIssueReportBody([{
      heading: 'Agent 回复',
      content: 'before ````` nested fence after',
      format: 'code',
    }])
    expect(body).toBe(
      '## Agent 回复\n\n``````text\nbefore ````` nested fence after\n``````',
    )
  })

  it('throws a typed error instead of truncating an overlong disclosure', () => {
    try {
      buildIssueReportUrl({
        sections: [{ heading: 'Context', content: 'x'.repeat(ISSUE_REPORT_URL_MAX_LENGTH) }],
      })
      throw new Error('expected an overlong URL error')
    } catch (error) {
      expect(error).toBeInstanceOf(IssueReportUrlTooLongError)
      const typed = error as IssueReportUrlTooLongError
      expect(typed.actualLength).toBeGreaterThan(typed.maxLength)
      expect(typed.maxLength).toBe(ISSUE_REPORT_URL_MAX_LENGTH)
    }
  })

  it('plans a prefilled URL while the encoded report fits', () => {
    const plan = planIssueReport({
      title: '反馈标题',
      sections: [{ heading: '上下文', content: '短内容' }],
    })

    expect(plan.mode).toBe('url')
    if (plan.mode !== 'url') throw new Error('expected a URL plan')
    expect(plan.body).toBe('## 上下文\n\n短内容')

    const url = new URL(plan.url)
    expect(url.origin).toBe('https://github.com')
    expect(url.pathname).toBe('/bitsky-tech/bridgic-agent/issues/new')
    expect(url.searchParams.get('title')).toBe('反馈标题')
    expect(url.searchParams.get('body')).toBe(plan.body)
  })

  it('plans a file without truncating an overlong Unicode report', () => {
    const content = '命令输出🙂与路径/Users/example/work '.repeat(500)
    const sections = [{ heading: 'Agent 回复与执行过程', content, format: 'code' as const }]
    const expectedBody = buildIssueReportBody(sections)
    const plan = planIssueReport({ title: '问题反馈', sections })

    expect(plan.mode).toBe('file')
    if (plan.mode !== 'file') throw new Error('expected a file plan')
    expect(plan.body).toBe(expectedBody)
    expect(plan.body).toContain(content.trim())
    expect(plan.actualUrlLength).toBeGreaterThan(plan.maxUrlLength)
    expect(plan.maxUrlLength).toBe(ISSUE_REPORT_URL_MAX_LENGTH)
    expect(plan.actualUrlLength).toBeGreaterThan(plan.body.length)
    expect(plan.githubUrl).toBe(APP_NEW_ISSUE_URL)

    const destination = new URL(plan.githubUrl)
    expect(destination.origin).toBe('https://github.com')
    expect(destination.pathname).toBe('/bitsky-tech/bridgic-agent/issues/new')
    expect(destination.search).toBe('')
  })
})
