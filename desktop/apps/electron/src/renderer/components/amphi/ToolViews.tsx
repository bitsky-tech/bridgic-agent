/**
 * The set of structured renderers for a tool call's "click to expand" view (tier B) + the ToolExpand dispatcher.
 *
 * One view per tool: read/write → code block with line numbers (read neutral, write with a green
 * left border); edit → unified diff; bash → fixed dark terminal; grep → grouped by file; glob → file
 * list; web_search → clickable result cards; web_fetch → Markdown; generic → arguments/result JSON.
 * Anything that fails to parse falls back to RawText. The backend's "result exceeded the inline cap,
 * it has been written to a file" sentinel takes precedence over the tool shape and always goes
 * through the OverflowNoticeView info card (tool-independent, to guarantee a consistent presentation).
 *
 * §1.14 collection file (a family of small renderers); §LS1: no glow, the code block's left border is
 * a permanently visible decoration.
 * §1.25: external links go through openExternal (same as MarkdownMessage), §1.23 cursor-pointer.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { rlog } from '@/lib/logger'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import { Collapse } from './Collapse'
import { Icons } from './Icons'
import {
  basename,
  commandOf,
  dirOf,
  formatBytes,
  parseEdit,
  parseGrepContent,
  parseNumberedLines,
  parseOverflowNotice,
  parsePathList,
  parseWebSearch,
  writeContentOf,
  type OverflowNotice,
  type ToolKind,
} from '@/lib/toolDisplay'
import type { AgentMessageToolCall } from '@/atoms/agent'

/** Serialize any value into a readable string: strings as-is, everything else as indented JSON, falling back to String(). */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Fallback when nothing parses: a raw text block. */
function RawText({ text }: { text: string }) {
  const { t } = useTranslation()
  return (
    <pre className="m-0 max-h-[280px] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-bg-hover px-3 py-2.5 text-[11px] font-mono leading-[1.6] text-text-secondary">
      {text || t('session.tool.noOutput')}
    </pre>
  )
}

/** The "overflowed to a file" sentinel → a single info card (shared by every tool shape, intercepted first by ToolExpand). */
function OverflowNoticeView({ notice }: { notice: OverflowNotice }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-md border border-border-subtle bg-bg-hover px-3.5 py-3">
      <div className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
        <span className="flex shrink-0 text-text-tertiary">{Icons.file(13)}</span>
        {t('session.tool.overflow.title')}
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[11px] leading-[1.6]">
        <dt className="text-text-tertiary">{t('session.tool.overflow.size')}</dt>
        <dd className="m-0 font-mono text-text-secondary">
          {t('session.tool.overflow.bytes', {
            size: formatBytes(notice.bytes),
            count: notice.bytes.toLocaleString(),
          })}
        </dd>
        {notice.limit > 0 && (
          <>
            <dt className="text-text-tertiary">{t('session.tool.overflow.limit')}</dt>
            <dd className="m-0 font-mono text-text-secondary">{t('session.tool.overflow.chars', { count: notice.limit.toLocaleString() })}</dd>
          </>
        )}
        <dt className="text-text-tertiary">{t('session.tool.overflow.path')}</dt>
        {/* break-all: show the full path wrapped instead of truncated — the same consistency goal as the read view. */}
        <dd className="m-0 break-all font-mono text-text-secondary">{notice.path}</dd>
      </dl>
    </div>
  )
}

/** External-link button: open in the system browser (same as MarkdownMessage's `a` handling). */
function ExtLink({ url }: { url: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        void window.api.shell
          .openExternal(url)
          .catch((e: unknown) => rlog.warn('[tool] openExternal failed', e))
      }}
      className="cursor-pointer break-all text-left text-xs text-brand-blue hover:underline"
    >
      {url}
    </button>
  )
}

/** Code block with line numbers: read uses a neutral left border, write a green one (= added). */
function CodeLines({
  rows,
  accent,
}: {
  rows: { lineno: number | null; text: string }[]
  accent: 'success' | 'neutral'
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-border-subtle border-l-[3px] bg-bg-hover',
        accent === 'success' ? 'border-l-status-success' : 'border-l-border-strong',
      )}
    >
      <div className="max-h-[280px] overflow-auto py-2.5 font-mono text-xs leading-[21px]">
        {rows.map((r, i) => (
          <div key={i} className="flex min-w-max">
            <span className="w-10 shrink-0 select-none pr-3.5 text-right text-text-tertiary">
              {r.lineno ?? ''}
            </span>
            <span className="whitespace-pre pr-4 text-text-primary">{r.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** edit_file: unified diff — old lines red/`−`, new lines green/`+`. */
function EditDiffView({ input }: { input: unknown }) {
  const { t } = useTranslation()
  const { oldText, newText } = parseEdit(input)
  const rows: { sign: string; text: string; del: boolean }[] = []
  if (oldText) oldText.split('\n').forEach((t) => rows.push({ sign: '−', text: t, del: true }))
  if (newText) newText.split('\n').forEach((t) => rows.push({ sign: '+', text: t, del: false }))
  if (!rows.length) return <RawText text={t('session.tool.noDiff')} />
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle font-mono text-xs leading-[1.7]">
      <div className="max-h-[280px] overflow-auto">
        {rows.map((r, i) => (
          <div
            key={i}
            className={cn(
              'flex',
              r.del ? 'bg-status-error-bg text-status-error' : 'bg-status-success-bg text-status-success',
            )}
          >
            <span className="w-6 shrink-0 select-none text-center">{r.sign}</span>
            <span className="whitespace-pre-wrap break-all pr-3">{r.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Colour each terminal line by its content (matching the QATerminal design). */
function termLineColor(ln: string): string {
  if (ln.startsWith('$')) return '#7DD3A8'
  if (ln.startsWith('—')) return '#3A3D4D'
  if (ln.includes('报告')) return '#E8EAEF'
  return '#AEB2C0'
}

/** bash: fixed dark terminal (`$ command` + stdout). */
function TerminalView({ command, output }: { command: string | null; output: string }) {
  const text = command ? `$ ${command}\n${output}` : output
  return (
    <div className="overflow-hidden rounded-md border border-[#232633] bg-[#0E0F16]">
      <div className="max-h-[260px] overflow-auto px-3.5 py-3 font-mono text-xs leading-[1.75] whitespace-pre-wrap break-words">
        {text.split('\n').map((ln, i) => (
          // Per-line colour is computed from the content — §1.22 dynamic values use inline style.
          <div key={i} style={{ color: termLineColor(ln) }}>
            {ln || ' '}
          </div>
        ))}
      </div>
    </div>
  )
}

/** File path list (glob / grep files mode): basename in the primary colour, directory as a grey prefix. */
function FileList({ paths }: { paths: string[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-hover">
      <div className="max-h-[260px] overflow-auto py-1.5">
        {paths.map((p, i) => (
          // break-all: show the full path wrapped instead of truncated (same as OverflowNoticeView) — long paths are never elided.
          <div key={i} className="break-all px-3 py-0.5 font-mono text-xs">
            {dirOf(p) && <span className="text-text-tertiary">{dirOf(p)}/</span>}
            <span className="text-text-primary">{basename(p)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The body of grep hits (without the argument section) — grouped by file, falling back to a file list / raw text. */
function GrepHits({ output }: { output: string }) {
  const groups = parseGrepContent(output)
  if (!groups.length) {
    const files = parsePathList(output)
    return files.length ? <FileList paths={files} /> : <RawText text={output} />
  }
  return (
    <div className="flex flex-col gap-2.5">
      {groups.map((g) => (
        <div key={g.file} className="overflow-hidden rounded-md border border-border-subtle">
          {/* break-all: file paths wrap in full instead of being truncated (consistent with FileList / OverflowNoticeView). */}
          <div className="break-all bg-bg-hover px-3 py-1.5 font-mono text-xs text-text-secondary">
            {g.file}
          </div>
          <div className="max-h-[220px] overflow-auto py-1.5 font-mono text-xs leading-[1.7]">
            {g.hits.map((h, i) => (
              <div key={i} className="flex min-w-max px-3">
                <span className="w-10 shrink-0 select-none pr-3 text-right text-text-tertiary">
                  {h.lineno}
                </span>
                <span className="whitespace-pre text-text-primary">{h.text || ' '}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** grep: arguments (collapsed) + hits. Everything besides `pattern` — path / glob / output_mode /
 *  case_insensitive / head_limit — does not fit on one line, so this is the only place to see it. */
function GrepView({ call, output }: { call: AgentMessageToolCall; output: string }) {
  return (
    <div className="space-y-2.5">
      <ParamsSection input={call.input} hasError={call.result?.isError === true} />
      <GrepHits output={output} />
    </div>
  )
}

/** web_search: result cards (title + clickable URL + snippet). */
function WebSearchView({ output }: { output: string }) {
  const results = parseWebSearch(output)
  if (!results.length) return <RawText text={output} />
  return (
    <div className="flex flex-col gap-2">
      {results.map((r, i) => (
        <div key={i} className="rounded-md border border-border-subtle bg-bg-hover px-3 py-2">
          <div className="text-sm font-medium text-text-primary">{r.title}</div>
          <ExtLink url={r.url} />
          {r.snippet && (
            <div className="mt-1 text-xs leading-[1.6] text-text-secondary">{r.snippet}</div>
          )}
        </div>
      ))}
    </div>
  )
}

/** web_fetch: the markdown produced after fetching and parsing. */
function WebFetchView({ output }: { output: string }) {
  return (
    <MarkdownMessage
      content={output}
      className="max-h-[320px] overflow-auto rounded-md border border-border-subtle bg-bg-hover px-3.5 py-2.5 text-sm"
    />
  )
}

/** Whether the argument object has any content (empty object / non-object → not worth its own section). */
function hasInputFields(input: unknown): boolean {
  return !!input && typeof input === 'object' && Object.keys(input as object).length > 0
}

/**
 * The "arguments" collapsible section — collapsed by default, expanded by default on error.
 *
 * Reused by **every** tool view: one line only fits the main argument, so the remaining arguments
 * (grep's path / glob / output_mode / case_insensitive / head_limit, etc.) would otherwise be
 * completely invisible in the UI. When there are no arguments the whole section is not rendered, so
 * no empty label is left behind.
 */
function ParamsSection({ input, hasError }: { input: unknown; hasError: boolean }) {
  const { t } = useTranslation()
  // null = the user has never toggled it manually, so it follows hasError; once toggled, the user's
  // intent wins. Derived rather than synced with useEffect, so a late-arriving result (an error during
  // streaming) still defaults to expanded correctly (§1.17).
  const [override, setOverride] = useState<boolean | null>(null)
  const open = override ?? hasError
  if (!hasInputFields(input)) return null

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOverride(!open)}
        className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.4px] text-text-tertiary transition-colors hover:text-text-secondary"
      >
        <span className={cn('flex transition-transform duration-300 ease-out', open && 'rotate-90')}>
          {Icons.chevronRight(9)}
        </span>
        {t('session.tool.parameters')}
      </button>
      <Collapse open={open}>
        <JsonBlock body={stringify(input)} />
      </Collapse>
    </div>
  )
}

/**
 * generic / unknown tools: the result is always shown, but the **arguments are collapsed by default**
 * (the single-line label already carries the main argument, and spreading the full JSON again in the
 * expanded area is noise). On error it defaults to expanded — argument-related failures can only be
 * diagnosed by looking at the arguments.
 */
function JsonView({ call }: { call: AgentMessageToolCall }) {
  const { t } = useTranslation()
  const { input, result } = call
  const hasError = result?.isError === true
  return (
    <div className="space-y-2.5">
      <ParamsSection input={input} hasError={hasError} />
      {result && <Section label={hasError ? t('session.tool.error') : t('session.tool.result')} body={stringify(result.output)} error={hasError} />}
    </div>
  )
}

function JsonBlock({ body, error }: { body: string; error?: boolean }) {
  return (
    <pre
      className={cn(
        'mb-0 mt-1.5 max-h-[148px] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-bg-hover px-3 py-2.5 text-[11px] font-mono leading-[1.65]',
        error ? 'text-status-error' : 'text-text-secondary',
      )}
    >
      {body}
    </pre>
  )
}

function Section({ label, body, error }: { label: string; body: string; error?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.4px] text-text-tertiary">
        {label}
      </div>
      <JsonBlock body={body} error={error} />
    </div>
  )
}

/** Numbered code content (the write body, with its own 1..N line numbers). */
function numberLines(content: string): { lineno: number | null; text: string }[] {
  return content.split('\n').map((t, i) => ({ lineno: i + 1, text: t }))
}

/** Dispatch to the matching view by tool shape (§1.24). */
export function ToolExpand({ kind, call }: { kind: ToolKind; call: AgentMessageToolCall }) {
  const { input, result } = call
  const output = result ? String(result.output ?? '') : ''
  // The "overflowed to a file" sentinel wins: this system notice goes through the shared info card for
  // every tool instead of falling into each tool's own shape (otherwise grep's / read's parsers would
  // misread it as a path list / code lines and the presentation would be inconsistent).
  const overflow = parseOverflowNotice(output)
  if (overflow) return <OverflowNoticeView notice={overflow} />
  if (kind === 'read') return <CodeLines rows={parseNumberedLines(output)} accent="neutral" />
  if (kind === 'write') {
    const content = writeContentOf(input)
    return content ? <CodeLines rows={numberLines(content)} accent="success" /> : <RawText text={output} />
  }
  if (kind === 'edit') return <EditDiffView input={input} />
  if (kind === 'bash') return <TerminalView command={commandOf(input)} output={output} />
  if (kind === 'grep') return <GrepView call={call} output={output} />
  if (kind === 'glob') return <FileListView call={call} output={output} />
  if (kind === 'web_search') return <WebSearchView output={output} />
  if (kind === 'web_fetch') return <WebFetchView output={output} />
  return <JsonView call={call} />
}

/** glob: arguments (collapsed) + matched file list. `path` does not fit on one line, so this is the only place to see it. */
function FileListView({ call, output }: { call: AgentMessageToolCall; output: string }) {
  const paths = parsePathList(output)
  return (
    <div className="space-y-2.5">
      <ParamsSection input={call.input} hasError={call.result?.isError === true} />
      {paths.length ? <FileList paths={paths} /> : <RawText text={output} />}
    </div>
  )
}
