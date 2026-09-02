/**
 * The "human-friendly display" logic layer for tool calls (pure functions + unit
 * tests): tool name → kind / Chinese label / metrics, plus structured parsers for
 * each tool's **output string**. Components (ToolCallRow / ToolViews) only consume
 * the results produced here.
 *
 * The single-line label uses a three-level fallback, guaranteeing that **any** tool
 * makes "what was done to what" visible on a single line:
 *   1. `REGISTRY`'s ToolKind (8 built-in tools) —— also drives expanded-view dispatch;
 *   2. `TOOL_SPECS` single-line specs (skills / workspace / subagent / schedule /
 *      workflow / browser / PowerPoint) —— **single line only**; the expanded
 *      view still goes through generic input/result JSON;
 *   3. `genericLabel` generic summary (unregistered tools + all MCP) —— picks the
 *      primary argument out of the input.
 * So adding a backend tool without touching this file still won't regress to the
 * information-free "call <tool name>" shape.
 *
 * Robustness: every parser makes a best-effort parse of the backend's text format and
 * **degrades when it can't parse** (the caller falls back to the raw text); it must
 * never white-screen just because the backend tweaked its wording. Fields that can't
 * be obtained are always left empty, never fabricated.
 */

import { i18n } from './i18n'

/** The tool's display kind. `hidden` = internal control flow (not rendered); `generic` = unknown/MCP fallback. */
export type ToolKind =
  | 'read'
  | 'write'
  | 'edit'
  | 'bash'
  | 'grep'
  | 'glob'
  | 'web_search'
  | 'web_fetch'
  | 'generic'
  | 'hidden'

/** Tool name → kind. Exact match for built-in tools; everything else falls to generic. */
const REGISTRY: Record<string, ToolKind> = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  bash: 'bash',
  grep: 'grep',
  glob: 'glob',
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  // The real backend tool name is `switch` (`tools/_switch.py`; FunctionToolSpec takes the function name).
  // It was previously written as `switch_stage` (no such definition anywhere in the repo) = a dead entry, so hiding never took effect.
  switch: 'hidden',
}

export function classifyTool(name: string): ToolKind {
  return REGISTRY[name] ?? 'generic'
}

/* ─── Input-argument extraction (private) ─── */

function strField(input: unknown, ...keys: string[]): string | null {
  if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>
    for (const k of keys) {
      const v = rec[k]
      if (typeof v === 'string' && v) return v
    }
  }
  return null
}

function numField(input: unknown, key: string): number {
  if (input && typeof input === 'object') {
    const v = (input as Record<string, unknown>)[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    // Some models serialize numeric arguments as JSON strings (common for read's offset/limit: "0"/"260").
    // The backend coerces them via type annotations and copes; the frontend must tolerate them too, otherwise read's "first N lines" hint is silently dropped.
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
  }
  return 0
}

export function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function dirOf(p: string): string {
  const parts = p.split(/[/\\]/)
  parts.pop()
  return parts.join('/')
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** The written body (write's code block); returns null when not obtainable. */
export function writeContentOf(input: unknown): string | null {
  return strField(input, 'content', 'text', 'new_content', 'contents')
}

/** The command text (the `$` line of the bash terminal); returns null when not obtainable. */
export function commandOf(input: unknown): string | null {
  return strField(input, 'command', 'cmd')
}

/** Line count of the text (write's "+N lines"). */
export function countWriteLines(content: string): number {
  return content ? content.split('\n').length : 0
}

/* ─── Single-line specs for non-ToolKind tools (skills / browser / workspace / …) ─── */

/**
 * The single-line display spec of a tool. It **only affects the single-line label**;
 * the expanded view still goes through `ToolExpand`'s generic branch (input/result
 * JSON) —— this table deliberately stays out of result rendering.
 *
 * Invariant: `subjectKeys` takes the **first non-empty string** input argument in
 * order; when all are empty, only the verb is displayed.
 */
export interface ToolSpec {
  /** Catalog key for the verb, e.g. `tool.verb.viewSkill`; rendered by `specLabel`. */
  verb: string
  /** Input keys the subject is taken from, ordered by how much information they carry. */
  subjectKeys?: string[]
  /** Subject form: `path` → basename + full-value Tooltip; `url` → domain + full-value Tooltip. */
  subjectAs?: 'path' | 'url'
  /** Render the subject in a monospace font (machine values such as id / ref / key). */
  subjectMono?: boolean
  /** Chinese mapping for enum subjects (e.g. scroll direction); unmatched values are shown as-is. */
  subjectMap?: Record<string, string>
  /** Input keys the note (the de-emphasized text at the right of the line) is taken from. */
  noteKeys?: string[]
}

/**
 * Tool name → single-line spec. Covers the backend's user-facing tool families, including
 * skills / workspace / subagent / schedule / workflow / browser / PowerPoint; unregistered tools fall
 * back to `genericLabel`.
 *
 * When adding a backend tool you **may leave this untouched** —— the fallback picks the
 * primary argument out of the input, the verb is just more generic.
 */
const TOOL_SPECS: Record<string, ToolSpec> = {
  // ── Skills ──
  // skill_dir is an absolute path; the basename is the skill name. Reads of different files within the same skill are distinguished by file_path.
  view_skill: { verb: 'tool.verb.viewSkill', subjectKeys: ['skill_dir'], subjectAs: 'path', noteKeys: ['file_path'] },
  manage_skills: { verb: 'tool.verb.manageSkills' },
  list_skills: { verb: 'tool.verb.listSkills', subjectKeys: ['filter'] },
  set_skill_enabled: { verb: 'tool.verb.setSkillEnabled', subjectKeys: ['name'] },
  uninstall_skill: { verb: 'tool.verb.uninstallSkill', subjectKeys: ['name'] },
  import_skills: { verb: 'tool.verb.importSkills', subjectKeys: ['skill_name', 'path'], subjectAs: 'path' },

  // ── Workspace ──
  workspace_status: { verb: 'tool.verb.workspaceStatus' },
  workspace_diff: { verb: 'tool.verb.workspaceDiff', subjectKeys: ['file_path'], subjectAs: 'path', noteKeys: ['checkpoint_id'] },
  workspace_history: { verb: 'tool.verb.workspaceHistory' },
  workspace_checkpoint: { verb: 'tool.verb.workspaceCheckpoint', subjectKeys: ['message'] },
  workspace_restore_file: {
    verb: 'tool.verb.workspaceRestoreFile',
    subjectKeys: ['file_path'],
    subjectAs: 'path',
    noteKeys: ['checkpoint_id'],
  },
  workspace_restore: { verb: 'tool.verb.workspaceRestore', subjectKeys: ['checkpoint_id'], subjectMono: true },
  load_workspace_tools: { verb: 'tool.verb.loadWorkspaceTools' },

  // ── Subagent ──
  run_subagent: { verb: 'tool.verb.runSubagent', subjectKeys: ['goal'] },
  start_subagent: { verb: 'tool.verb.startSubagent', subjectKeys: ['goal'] },

  // ── Schedule ──
  create_schedule: { verb: 'tool.verb.createSchedule', subjectKeys: ['name'], noteKeys: ['cron'] },
  update_schedule: { verb: 'tool.verb.updateSchedule', subjectKeys: ['name', 'schedule_id'], noteKeys: ['cron'] },
  delete_schedule: { verb: 'tool.verb.deleteSchedule', subjectKeys: ['schedule_id'], subjectMono: true },
  list_schedules: { verb: 'tool.verb.listSchedules', subjectKeys: ['query'] },
  get_schedule: { verb: 'tool.verb.getSchedule', subjectKeys: ['schedule_id'], subjectMono: true },

  // ── Workflow ──
  edit_workflow: { verb: 'tool.verb.editWorkflow', subjectKeys: ['workflow_id'], subjectMono: true },
  remove_workflow: { verb: 'tool.verb.removeWorkflow', subjectKeys: ['workflow_id'], subjectMono: true },
  run_workflow: { verb: 'tool.verb.runWorkflow', subjectKeys: ['workflow_id'], subjectMono: true },
  report_workflow_step: { verb: 'tool.verb.reportWorkflowStep', subjectKeys: ['summary'], noteKeys: ['status'] },
  list_workflow_runs: { verb: 'tool.verb.listWorkflowRuns', subjectKeys: ['query', 'workflow_id'] },
  read_workflow_run: { verb: 'tool.verb.readWorkflowRun', subjectKeys: ['run_id'], subjectMono: true, noteKeys: ['path'] },

  // ── Browser ──
  browser_open: { verb: 'tool.verb.browserOpen', subjectKeys: ['url'], subjectAs: 'url' },
  browser_close: { verb: 'tool.verb.browserClose' },
  browser_snapshot: { verb: 'tool.verb.browserSnapshot' },
  browser_click: { verb: 'tool.verb.browserClick', subjectKeys: ['ref'], subjectMono: true },
  browser_input: { verb: 'tool.verb.browserInput', subjectKeys: ['text'], noteKeys: ['ref'] },
  browser_back: { verb: 'tool.verb.browserBack' },
  browser_forward: { verb: 'tool.verb.browserForward' },
  browser_reload: { verb: 'tool.verb.browserReload' },
  browser_scroll: {
    verb: 'tool.verb.browserScroll',
    subjectKeys: ['direction'],
    subjectMap: {
      up: 'tool.direction.up',
      down: 'tool.direction.down',
      left: 'tool.direction.left',
      right: 'tool.direction.right',
    },
  },
  browser_key: { verb: 'tool.verb.browserKey', subjectKeys: ['key'], subjectMono: true },
  browser_page_info: { verb: 'tool.verb.browserPageInfo' },
  browser_search: { verb: 'tool.verb.browserSearch', subjectKeys: ['query'] },
  browser_tabs: { verb: 'tool.verb.browserTabs' },
  browser_new_tab: { verb: 'tool.verb.browserNewTab', subjectKeys: ['url'], subjectAs: 'url' },
  browser_switch_tab: { verb: 'tool.verb.browserSwitchTab', subjectKeys: ['page_id'], subjectMono: true },
  browser_close_tab: { verb: 'tool.verb.browserCloseTab', subjectKeys: ['page_id'], subjectMono: true },
  browser_wait: { verb: 'tool.verb.browserWait', subjectKeys: ['text', 'selector'] },
  browser_wait_for_network_idle: { verb: 'tool.verb.browserWaitForNetworkIdle' },
  browser_screenshot: { verb: 'tool.verb.browserScreenshot', subjectKeys: ['filename', 'ref'], subjectAs: 'path' },
  browser_verify_text: { verb: 'tool.verb.browserVerifyText', subjectKeys: ['text'] },
  browser_verify_visible: { verb: 'tool.verb.browserVerifyVisible', subjectKeys: ['ref'], subjectMono: true },
  browser_verify_url: { verb: 'tool.verb.browserVerifyUrl', subjectKeys: ['expected_url'], subjectAs: 'url' },
  browser_verify_title: { verb: 'tool.verb.browserVerifyTitle', subjectKeys: ['expected_title'] },
  browser_scroll_to_text: { verb: 'tool.verb.browserScrollToText', subjectKeys: ['text'] },
  browser_hover: { verb: 'tool.verb.browserHover', subjectKeys: ['ref'], subjectMono: true },
  browser_focus: { verb: 'tool.verb.browserFocus', subjectKeys: ['ref'], subjectMono: true },
  browser_select: { verb: 'tool.verb.browserSelect', subjectKeys: ['text'], noteKeys: ['ref'] },
  browser_check: { verb: 'tool.verb.browserCheck', subjectKeys: ['ref'], subjectMono: true },
  browser_uncheck: { verb: 'tool.verb.browserUncheck', subjectKeys: ['ref'], subjectMono: true },
  load_browser_tools: { verb: 'tool.verb.loadBrowserTools' },

  // ── PowerPoint ──
  view_ppt: { verb: 'tool.verb.pptView', subjectKeys: ['target'], subjectAs: 'path' },
  get_ppt_page: { verb: 'tool.verb.pptGetPage', subjectKeys: ['page_id'], subjectMono: true },
  update_ppt_design: { verb: 'tool.verb.pptUpdateDesign', subjectKeys: ['theme', 'page_size'] },
  edit_ppt_page: { verb: 'tool.verb.pptEditPage', subjectKeys: ['page_id'], noteKeys: ['ref'], subjectMono: true },
  insert_ppt_element: { verb: 'tool.verb.pptInsertElement', subjectKeys: ['page_id'], subjectMono: true },
  remove_ppt_element: {
    verb: 'tool.verb.pptRemoveElement',
    subjectKeys: ['page_id'],
    noteKeys: ['ref'],
    subjectMono: true,
  },
  insert_ppt_page: { verb: 'tool.verb.pptInsertPage', subjectKeys: ['after_page_id'], subjectMono: true },
  remove_ppt_page: { verb: 'tool.verb.pptRemovePage', subjectKeys: ['page_id'], subjectMono: true },
  move_ppt_page: {
    verb: 'tool.verb.pptMovePage',
    subjectKeys: ['page_id'],
    subjectMono: true,
    noteKeys: ['target_page_id'],
  },
  goto_ppt_page: { verb: 'tool.verb.pptGotoPage', subjectKeys: ['page_id'], subjectMono: true },
}

/** Look up a tool's single-line spec; returns null when unregistered (the caller uses the generic fallback). */
export function toolSpecOf(name: string): ToolSpec | null {
  return TOOL_SPECS[name] ?? null
}

/** Candidate keys for the fallback primary argument, ordered by "how much information it carries for a human". */
const FALLBACK_SUBJECT_KEYS = [
  'query', 'goal', 'command', 'url', 'file_path', 'path', 'skill_dir',
  'name', 'pattern', 'text', 'message', 'summary', 'id', 'ref',
]

/** Truncation point when the fallback primary argument is too long (it doesn't fit on one line; the full value goes to the Tooltip). */
const FALLBACK_SUBJECT_MAX = 80

/** detail shares the same flexible width as the subject; when too long it squeezes the subject out, hence the truncation. */
const DETAIL_MAX = 40

/** The tool name inside the fallback verb is shrink-0 as well; leaving a long MCP name untruncated squeezes the subject into an ellipsis. */
const GENERIC_VERB_NAME_MAX = 28

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/**
 * The primary argument of an unregistered tool (including MCP): first try the semantic
 * keys, then degrade to "the first not-too-long string input argument".
 * Returns null when nothing is obtainable —— the caller falls back to showing only the
 * tool name, never fabricating content.
 */
export function fallbackSubject(input: unknown): string | null {
  const semantic = strField(input, ...FALLBACK_SUBJECT_KEYS)
  if (semantic) return semantic
  if (input && typeof input === 'object') {
    for (const v of Object.values(input as Record<string, unknown>)) {
      // Only accept short strings: long text (body / HTML) as the subject blows up the single line and carries no distinguishing value.
      if (typeof v === 'string' && v && v.length <= FALLBACK_SUBJECT_MAX) return v
    }
  }
  return null
}

/** MCP tool name `mcp__<server>__<tool>` → `<server>/<tool>`; non-MCP names are returned as-is. */
export function shortToolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[1]}/${m[2]}` : name
}

/* ─── Single-line label + metrics ─── */

/** The Chinese label of a tool's single line: verb + subject (file basename / command / pattern / domain). */
export interface ToolLabel {
  verb: string
  subject: string
  /** Full path / URL, as a Tooltip fallback (when subject is a basename / domain). */
  subjectFull?: string
  /** Render the subject in a monospace font (command / pattern / tool name). */
  subjectMono?: boolean
}

export function toolLabel(kind: ToolKind, name: string, input: unknown): ToolLabel {
  const file = (): string => strField(input, 'file_path', 'path', 'file', 'filename', 'target') ?? name
  switch (kind) {
    case 'read': {
      const p = file()
      return { verb: i18n.t('tool.verb.read'), subject: basename(p), subjectFull: p }
    }
    case 'write': {
      const p = file()
      return { verb: i18n.t('tool.verb.write'), subject: basename(p), subjectFull: p }
    }
    case 'edit': {
      const p = file()
      return { verb: i18n.t('tool.verb.edit'), subject: basename(p), subjectFull: p }
    }
    case 'bash':
      return { verb: i18n.t('tool.verb.bash'), subject: commandOf(input) ?? '', subjectMono: true }
    case 'grep':
      return { verb: i18n.t('tool.verb.grep'), subject: strField(input, 'pattern') ?? '', subjectMono: true }
    case 'glob':
      return { verb: i18n.t('tool.verb.glob'), subject: strField(input, 'pattern') ?? '', subjectMono: true }
    case 'web_search':
      return { verb: i18n.t('tool.verb.webSearch'), subject: strField(input, 'query') ?? '' }
    case 'web_fetch': {
      const u = strField(input, 'url') ?? ''
      return { verb: i18n.t('tool.verb.webFetch'), subject: domainOf(u), subjectFull: u }
    }
    default: {
      const spec = toolSpecOf(name)
      return spec ? specLabel(spec, input) : genericLabel(name, input)
    }
  }
}

/** Label for a registered tool: the verb is fixed, the subject is taken per the spec's key order + form. */
function specLabel(spec: ToolSpec, input: unknown): ToolLabel {
  const verb = i18n.t(spec.verb)
  const raw = spec.subjectKeys ? strField(input, ...spec.subjectKeys) : null
  if (!raw) return { verb, subject: '' }
  const mapped = spec.subjectMap?.[raw]
  if (spec.subjectMap) return { verb, subject: mapped ? i18n.t(mapped) : raw }
  if (spec.subjectAs === 'path') return { verb, subject: basename(raw), subjectFull: raw }
  if (spec.subjectAs === 'url') return { verb, subject: domainOf(raw), subjectFull: raw }
  return { verb, subject: raw, subjectMono: spec.subjectMono }
}

/**
 * Label for an unregistered tool (including MCP): the tool name is de-emphasized into
 * the verb, the primary argument becomes the bolded subject.
 * When no primary argument is obtainable, fall back to the old shape ("call <tool name>" /
 * `call <tool name>`), never fabricate.
 */
function genericLabel(name: string, input: unknown): ToolLabel {
  const short = shortToolName(name)
  const hint = fallbackSubject(input)
  if (!hint) return { verb: i18n.t('tool.verb.call'), subject: short, subjectMono: true }
  return { verb: i18n.t('tool.verb.callNamed', { name: truncate(short, GENERIC_VERB_NAME_MAX) }), subject: hint }
}

/** read's line-number range; when both offset/limit are missing the whole file is read, returning "full text". */
export function readRangeLabel(input: unknown): string {
  const offset = numField(input, 'offset')
  const limit = numField(input, 'limit')
  if (offset > 0 && limit > 0) return i18n.t('tool.range.between', { start: offset, end: offset + limit - 1 })
  if (offset > 0) return i18n.t('tool.range.from', { start: offset })
  if (limit > 0) return i18n.t('tool.range.first', { n: limit })
  return i18n.t('tool.range.full')
}

/**
 * Extra information on the single line. **The position is decided by the source, don't
 * mix them up**:
 *
 * - `detail` —— a concrete value derived from the **input** (`file_path` / `ref` /
 *   `cron`), rendered **immediately after the subject**. It is part of the subject's
 *   semantics ("view file Y of skill X"); pushing it to the end of the line forces the
 *   eye to sweep the whole screen to pair them up —— especially obvious with 9 rows of
 *   the same Skill reading different files.
 * - `note` —— a metric derived from the **output** ("full text", "N spots",
 *   "N hits"), rendered at the **end of the line**. It is a result statistic, and right-aligned is
 *   the correct information hierarchy for it.
 * - `badge` —— green emphasis (only write's "+N lines").
 */
export interface ToolMeta {
  badge?: string
  note?: string
  detail?: string
}

export function toolMeta(kind: ToolKind, name: string, input: unknown, output: string): ToolMeta {
  switch (kind) {
    case 'write': {
      const c = writeContentOf(input)
      return c ? { badge: i18n.t('tool.meta.addedLines', { n: countWriteLines(c) }) } : {}
    }
    case 'read': {
      const r = readRangeLabel(input)
      return r ? { note: r } : {}
    }
    case 'edit': {
      const n = editReplacements(output)
      return n ? { note: i18n.t('tool.meta.replacedCount', { n }) } : {}
    }
    case 'glob': {
      // On overflow-written-to-file, output is a system notice; parsePathList would mistake the notice lines for paths → a bogus count.
      if (parseOverflowNotice(output)) return {}
      const n = parsePathList(output).length
      return n ? { note: i18n.t('tool.meta.matchedCount', { n }) } : {}
    }
    case 'web_search': {
      const n = parseWebSearch(output).length
      return n ? { note: i18n.t('tool.meta.resultCount', { n }) } : {}
    }
    case 'grep': {
      // Same as glob: the overflow notice is not a grep result — don't let parsePathList count its 4 notice lines as "4 files".
      if (parseOverflowNotice(output)) return {}
      const groups = parseGrepContent(output)
      if (groups.length) {
        const hits = groups.reduce((s, f) => s + f.hits.length, 0)
        return { note: i18n.t('tool.meta.hitCount', { n: hits }) }
      }
      const n = parsePathList(output).length
      return n ? { note: i18n.t('tool.meta.fileCount', { n }) } : {}
    }
    default: {
      const spec = toolSpecOf(name)
      if (!spec?.noteKeys) return {}
      const v = strField(input, ...spec.noteKeys)
      // Input-derived → detail (right after the subject), not note (end of line). See the ToolMeta docs.
      return v ? { detail: truncate(v, DETAIL_MAX) } : {}
    }
  }
}

/* ─── Output parsers ─── */

/** read_file's `cat -n` output → line number + content; for non-numbered lines (markers/notices) lineno = null. */
export function parseNumberedLines(output: string): { lineno: number | null; text: string }[] {
  return output.split('\n').map((ln) => {
    const m = /^\s*(\d+)\t(.*)$/.exec(ln)
    return m ? { lineno: Number(m[1]), text: m[2] ?? '' } : { lineno: null, text: ln }
  })
}

/** The grep hits under a single file. */
export interface GrepFileHits {
  file: string
  hits: { lineno: number; text: string }[]
}

/** grep `content` mode output (`path:lineno:content`) → grouped by file (preserving order of appearance).
 *  Other shapes (files_with_matches / count) parse to an empty array, and the caller falls back to the file list. */
export function parseGrepContent(output: string): GrepFileHits[] {
  const groups: GrepFileHits[] = []
  const byFile = new Map<string, GrepFileHits>()
  for (const ln of output.split('\n')) {
    const m = /^(.*?):(\d+):(.*)$/.exec(ln)
    if (!m) continue
    const file = m[1] ?? ''
    let g = byFile.get(file)
    if (!g) {
      g = { file, hits: [] }
      byFile.set(file, g)
      groups.push(g)
    }
    g.hits.push({ lineno: Number(m[2]), text: m[3] ?? '' })
  }
  return groups
}

/** Path-list output (glob / grep files_with_matches) → array of paths (truncation/empty notice lines removed). */
export function parsePathList(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('...') && !l.startsWith('('))
}

/** The backend's "result exceeded the inline limit and was written to a file" sentinel (`_agent.py`): a fixed 4-line text. */
export interface OverflowNotice {
  path: string
  bytes: number
  limit: number
}

const OVERFLOW_SENTINEL = 'Tool result exceeded inline limit and was written to file.'

/** Recognize and parse the overflow-written-to-file sentinel (any tool may produce it) → path / bytes / limit;
 *  other shapes return null and the caller falls back to the regular view. Rendering it uniformly avoids the same
 *  system notice being misread separately by each tool view. */
export function parseOverflowNotice(output: string): OverflowNotice | null {
  if (!output.startsWith(OVERFLOW_SENTINEL)) return null
  return {
    path: /^Path:\s*(.+)$/m.exec(output)?.[1]?.trim() ?? '',
    bytes: Number(/^Bytes:\s*(\d+)/m.exec(output)?.[1] ?? 0),
    limit: Number(/^Inline limit:\s*(\d+)/m.exec(output)?.[1] ?? 0),
  }
}

/** Byte count → human-readable size (B / KB / MB; one decimal place for KB and above). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** A single web_search result. */
export interface WebResult {
  title: string
  url: string
  snippet: string
}

/** web_search output (`  - [title](url): snippet`) → array of results. */
export function parseWebSearch(output: string): WebResult[] {
  const out: WebResult[] = []
  for (const ln of output.split('\n')) {
    const m = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/.exec(ln)
    if (m) out.push({ title: m[1] ?? '', url: m[2] ?? '', snippet: (m[3] ?? '').trim() })
  }
  return out
}

/** edit_file's input → old / new / replaceAll (used by the diff view). */
export function parseEdit(input: unknown): { oldText: string; newText: string; replaceAll: boolean } {
  const replaceAll =
    !!(input && typeof input === 'object' && (input as Record<string, unknown>).replace_all === true)
  return {
    oldText: strField(input, 'old_string', 'old', 'oldText') ?? '',
    newText: strField(input, 'new_string', 'new', 'newText') ?? '',
    replaceAll,
  }
}

/** The replacement count in edit_file's output (`replaced N occurrence(s)`); returns 0 when not obtainable. */
export function editReplacements(output: string): number {
  const m = /replaced\s+(\d+)\s+occurrence/i.exec(output)
  return m ? Number(m[1]) : 0
}
