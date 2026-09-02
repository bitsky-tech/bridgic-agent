/**
 * Single-line tool row — a human-friendly presentation of one tool call inside the QA execution process (tier B).
 *
 * One line: category icon + label (verb + subject, e.g. "read main.ts", "run ls") + measurement
 * (write: green +N lines / read: line range / grep: N matches …) + duration + chevron + (for write) a preview.
 * Expanding dispatches to a structured view depending on the tool's shape (code / diff / terminal / file list /
 * result card / markdown / JSON) — see ToolViews. `hidden` (switch_stage) is not rendered.
 *
 * §LS1: hover / expand only change color and visibility. §1.25: long subjects / full paths use a Tooltip.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Icons } from './Icons'
import { Tooltip } from './Tooltip'
import { Collapse } from './Collapse'
import { ToolExpand } from './ToolViews'
import { classifyTool, toolLabel, toolMeta, type ToolKind, type ToolLabel } from '@/lib/toolDisplay'
import { isBrowserAgentActionToolName, type AgentMessageToolCall } from '@/atoms/agent'
import { SubagentGroup } from './SubagentGroup'
import { ImageGenerationCard } from './ImageGenerationCard'

export interface ToolCallRowProps {
  call: AgentMessageToolCall
}

/** Tool families not covered by ToolKind → icon (prefix match, first hit wins). */
const FAMILY_ICONS: [RegExp, () => JSX.Element][] = [
  [/^browser_|^load_browser_tools$/, () => Icons.globe(14)],
  [/^workspace_|^load_workspace_tools$/, () => Icons.folder(14)],
  [/skill/, () => Icons.lightbulb(14)],
  [/subagent/, () => Icons.robot(14)],
  [/schedule/, () => Icons.clock(14)],
  [/workflow/, () => Icons.workflow(14)],
  [/^mcp__/, () => Icons.wrench(14)],
]

/** Tool shape + status → single-line icon (helper for value mapping, avoiding nested ternaries, §1.24). */
function toolIcon(kind: ToolKind, name: string, isError: boolean): JSX.Element {
  if (isError) return Icons.xCircle(14)
  if (kind === 'write' || kind === 'edit') return Icons.edit(13)
  if (kind === 'read') return Icons.file(13)
  if (kind === 'bash') return Icons.terminal(14)
  if (kind === 'grep') return Icons.search(14)
  if (kind === 'glob') return Icons.folder(14)
  // Web search uses the magnifier (search semantics); web page fetching keeps the globe.
  if (kind === 'web_search') return Icons.search(14)
  if (kind === 'web_fetch') return Icons.globe(14)
  // Within generic, split further by family — otherwise ten browser_* calls on one screen all get the same dots icon.
  const family = FAMILY_ICONS.find(([re]) => re.test(name))
  return family ? family[1]() : Icons.dots(14)
}

/** ms → human-readable duration: under 1s show ms, otherwise seconds with one decimal. */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Subject text: secondary and bold, optionally monospaced / truncated / with a full-value Tooltip. */
function SubjectText({ label }: { label: ToolLabel }) {
  const inner = (
    <span className={cn('truncate font-medium text-text-secondary', label.subjectMono && 'font-mono')}>
      {label.subject}
    </span>
  )
  if (label.subjectFull && label.subjectFull !== label.subject) {
    return <Tooltip content={label.subjectFull}>{inner}</Tooltip>
  }
  return inner
}

/** Long subjects (command / pattern / query / tool name) are flexible inline and truncate; short subjects (file names)
 *  keep whitespace to their right, pushing the duration / chevron to the end of the line. */
function hasLongSubject(kind: ToolKind): boolean {
  return kind === 'bash' || kind === 'grep' || kind === 'glob' || kind === 'web_search' || kind === 'generic'
}

function GenericToolCallRow({ call }: ToolCallRowProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // lazy-mount: the expanded content is mounted (and kept) only after the first expansion — this both animates the
  // collapse direction and avoids rendering heavy content (code/terminal) for tools that were never opened.
  const [mounted, setMounted] = useState(false)
  const { name, input, result } = call
  const kind = classifyTool(name)
  if (kind === 'hidden') return null

  const isError = result?.isError === true
  const output = result ? String(result.output ?? '') : ''
  const durationMs = result?.durationMs ?? 0
  const label = toolLabel(kind, name, input)
  const meta = toolMeta(kind, name, input, output)
  const longSubject = hasLongSubject(kind)
  const isBrowserRunning = isBrowserAgentActionToolName(name) && result === undefined

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v)
          setMounted(true)
        }}
        className={cn(
          'flex w-full items-center gap-[7px] rounded-md py-[3px] transition-colors',
          isError ? 'text-status-error' : 'text-text-tertiary hover:text-text-secondary',
          isBrowserRunning && 'bg-accent-blue-subtle text-text-accent',
        )}
        data-browser-tool-state={isBrowserRunning ? 'running' : undefined}
      >
        <span className={cn(
          'flex shrink-0',
          isBrowserRunning && 'text-text-accent',
        )}>
          {toolIcon(kind, name, isError)}
        </span>
        <span
          className={cn('flex min-w-0 items-baseline gap-1 text-xs', longSubject ? 'flex-1' : 'shrink-0')}
        >
          <span className={cn('shrink-0 text-text-tertiary', isBrowserRunning && 'text-text-accent')}>
            {label.verb}
          </span>
          <SubjectText label={label} />
          {/* detail follows the subject immediately (rather than being pushed to the end of the line): it is semantically
              part of the subject, e.g. "view file Y of skill X". With nine rows of the same skill reading different files,
              putting them apart would require scanning the whole width to pair them up. */}
          {meta.detail && (
            <span className="min-w-0 truncate text-xs text-text-tertiary">
              <span className="px-0.5">·</span>
              {meta.detail}
            </span>
          )}
          {/* Put the badge inside the items-baseline group so it aligns to the file name's text baseline (otherwise an 11px
              badge floats high relative to a 12px file name inside an items-center row). */}
          {meta.badge && (
            <span className="shrink-0 font-mono text-xs font-semibold text-status-success">
              {meta.badge}
            </span>
          )}
        </span>
        {meta.note && <span className="shrink-0 text-xs text-text-tertiary">{meta.note}</span>}
        {!longSubject && <span className="flex-1" />}
        {durationMs > 0 && (
          <span className="shrink-0 font-mono text-xs text-text-tertiary">
            {formatDuration(durationMs)}
          </span>
        )}
        <span
          className={cn(
            'flex shrink-0 text-text-tertiary transition-transform duration-300 ease-out',
            open && 'rotate-90',
          )}
        >
          {Icons.chevronRight(11)}
        </span>
        {kind === 'write' && !open && <span className="shrink-0 text-xs text-text-accent">{t('session.tool.preview')}</span>}
      </button>
      {kind === 'bash' && call.subagents?.length ? (
        <SubagentGroup subagents={call.subagents} />
      ) : null}
      <Collapse open={open}>
        <div className="pt-2">{mounted ? <ToolExpand kind={kind} call={call} /> : null}</div>
      </Collapse>
    </div>
  )
}

export function ToolCallRow({ call }: ToolCallRowProps) {
  if (call.name === 'generate_image') return <ImageGenerationCard call={call} />
  return <GenericToolCallRow call={call} />
}
