import { APP_NEW_ISSUE_URL } from './app-meta'

export const ISSUE_REPORT_URL_MAX_LENGTH = 8_000

/**
 * The single destination an issue report may be sent to, derived from
 * `APP_NEW_ISSUE_URL` rather than restated.
 *
 * These used to be three hard-coded literals sitting directly below an import
 * of the very constant they mirrored. Repointing `APP_NEW_ISSUE_URL` at the
 * renamed repository therefore broke every issue-report path at runtime: the
 * guard went on comparing against the old owner/name and rejected the app's own
 * URL with `Invalid issue report destination`. Deriving preserves the guard's
 * purpose — anything that does not match app-meta is still refused — while
 * making that particular drift unrepresentable.
 */
const EXPECTED_DESTINATION = new URL(APP_NEW_ISSUE_URL)

export type IssueReportSectionFormat = 'markdown' | 'code'

export interface IssueReportSection {
  heading: string
  content: string
  format?: IssueReportSectionFormat
}

export interface IssueReportDraft {
  title?: string | null
  sections?: readonly IssueReportSection[]
}

export interface IssueReportUrlPlan {
  mode: 'url'
  url: string
  body: string
}

export interface IssueReportFilePlan {
  mode: 'file'
  githubUrl: string
  body: string
  actualUrlLength: number
  maxUrlLength: number
}

export type IssueReportPlan = IssueReportUrlPlan | IssueReportFilePlan

export class IssueReportUrlTooLongError extends RangeError {
  constructor(
    public readonly actualLength: number,
    public readonly maxLength: number,
  ) {
    super(`Issue report URL is ${actualLength} characters; maximum is ${maxLength}`)
    this.name = 'IssueReportUrlTooLongError'
  }
}

function assertIssueDestination(url: URL): void {
  if (
    url.protocol !== EXPECTED_DESTINATION.protocol ||
    url.hostname !== EXPECTED_DESTINATION.hostname ||
    url.port !== EXPECTED_DESTINATION.port ||
    // Credentials are refused outright rather than compared: an issue URL
    // carrying any is a misconfiguration, not a destination to honour.
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== EXPECTED_DESTINATION.pathname
  ) {
    throw new Error('Invalid issue report destination')
  }
}

function normalizeHeading(heading: string): string {
  return heading.replace(/[\r\n]+/g, ' ').trim()
}

function codeFence(content: string): string {
  const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}text\n${content}\n${fence}`
}

export function buildIssueReportBody(sections: readonly IssueReportSection[]): string {
  const rendered: string[] = []
  for (const section of sections) {
    const heading = normalizeHeading(section.heading)
    const content = section.content.trim()
    if (!heading || !content) continue
    const body = section.format === 'code' ? codeFence(content) : content
    rendered.push(`## ${heading}\n\n${body}`)
  }
  return rendered.join('\n\n')
}

function composeIssueReportUrl(draft: IssueReportDraft): { url: string; body: string } {
  const title = draft.title?.trim() ?? ''
  const body = buildIssueReportBody(draft.sections ?? [])
  if (!title && !body) return { url: APP_NEW_ISSUE_URL, body }

  const url = new URL(APP_NEW_ISSUE_URL)
  assertIssueDestination(url)
  const params = new URLSearchParams()
  if (title) params.set('title', title)
  if (body) params.set('body', body)
  url.search = params.toString()
  assertIssueDestination(url)

  return { url: url.toString(), body }
}

/**
 * Plan how to transfer an issue report without discarding selected content.
 *
 * Parameters
 * ----------
 * draft
 *     Report title and disclosure sections selected by the user.
 *
 * Returns
 * -------
 * IssueReportPlan
 *     A prefilled URL plan when it is safe to navigate, otherwise a file plan
 *     containing the complete Markdown body and a short GitHub destination.
 */
export function planIssueReport(draft: IssueReportDraft = {}): IssueReportPlan {
  const { url, body } = composeIssueReportUrl(draft)
  if (url.length <= ISSUE_REPORT_URL_MAX_LENGTH) return { mode: 'url', url, body }

  return {
    mode: 'file',
    githubUrl: APP_NEW_ISSUE_URL,
    body,
    actualUrlLength: url.length,
    maxUrlLength: ISSUE_REPORT_URL_MAX_LENGTH,
  }
}

export function buildIssueReportUrl(draft: IssueReportDraft = {}): string {
  const plan = planIssueReport(draft)
  if (plan.mode === 'url') return plan.url

  throw new IssueReportUrlTooLongError(plan.actualUrlLength, plan.maxUrlLength)
}
