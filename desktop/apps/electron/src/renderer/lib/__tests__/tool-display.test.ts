/**
 * Tests for lib/toolDisplay.ts — the tool-call display registry, Chinese labels,
 * inline meta, and the output parsers (with graceful fallback). bun:test, §4.12.
 */
import { describe, it, expect } from 'bun:test'
import {
  basename,
  classifyTool,
  commandOf,
  countWriteLines,
  dirOf,
  domainOf,
  editReplacements,
  formatBytes,
  parseEdit,
  parseGrepContent,
  parseNumberedLines,
  parseOverflowNotice,
  parsePathList,
  parseWebSearch,
  readRangeLabel,
  toolLabel,
  toolMeta,
  writeContentOf,
} from '../toolDisplay'

/** Real four-line file-overflow sentinel emitted by backend `_agent.py` (test fixture). */
const OVERFLOW = [
  'Tool result exceeded inline limit and was written to file.',
  'Path: /Users/t/.bridgic/AmphiAgent/sessions/s_1/.internal/tool_results/2026-07-06_a4a901e4.txt',
  'Bytes: 28068',
  'Inline limit: 16384 characters.',
].join('\n')

describe('classifyTool', () => {
  it('maps built-in tools to their kind', () => {
    expect(classifyTool('read_file')).toBe('read')
    expect(classifyTool('write_file')).toBe('write')
    expect(classifyTool('edit_file')).toBe('edit')
    expect(classifyTool('bash')).toBe('bash')
    expect(classifyTool('grep')).toBe('grep')
    expect(classifyTool('glob')).toBe('glob')
    expect(classifyTool('web_search')).toBe('web_search')
    expect(classifyTool('web_fetch')).toBe('web_fetch')
    expect(classifyTool('switch')).toBe('hidden')
  })
  it('falls back to generic for unknown / MCP tools', () => {
    expect(classifyTool('some_mcp_tool')).toBe('generic')
  })
})

describe('toolLabel', () => {
  it('reads/writes/edits show the basename as subject, full path for tooltip', () => {
    expect(toolLabel('read', 'read_file', { file_path: 'src/app/main.ts' })).toEqual({
      verb: '读取',
      subject: 'main.ts',
      subjectFull: 'src/app/main.ts',
    })
    expect(toolLabel('write', 'write_file', { file_path: '/abs/a.py' }).verb).toBe('写入')
    expect(toolLabel('edit', 'edit_file', { file_path: 'a.py' }).verb).toBe('编辑')
  })
  it('bash/grep/glob use command/pattern (mono)', () => {
    expect(toolLabel('bash', 'bash', { command: 'ls -la' })).toEqual({
      verb: '执行',
      subject: 'ls -la',
      subjectMono: true,
    })
    expect(toolLabel('grep', 'grep', { pattern: 'foo' }).verb).toBe('搜索')
    expect(toolLabel('glob', 'glob', { pattern: '**/*.ts' }).verb).toBe('查找')
  })
  it('web tools use query / domain', () => {
    expect(toolLabel('web_search', 'web_search', { query: 'react hooks' }).subject).toBe('react hooks')
    expect(toolLabel('web_fetch', 'web_fetch', { url: 'https://www.example.com/p' })).toEqual({
      verb: '抓取网页',
      subject: 'example.com',
      subjectFull: 'https://www.example.com/p',
    })
  })
  it('generic falls back to the tool name', () => {
    expect(toolLabel('generic', 'weird_tool', {})).toEqual({
      verb: '调用',
      subject: 'weird_tool',
      subjectMono: true,
    })
  })
})

describe('readRangeLabel', () => {
  it('renders offset+limit / offset-only / limit-only in Chinese', () => {
    expect(readRangeLabel({ offset: 20, limit: 41 })).toBe('第 20–60 行')
    expect(readRangeLabel({ offset: 20 })).toBe('第 20 行起')
    expect(readRangeLabel({ limit: 60 })).toBe('前 60 行')
    expect(readRangeLabel({})).toBe('全文')
  })
  it('coerces numeric-string offset/limit (some models serialize args as strings)', () => {
    // Real case: model emitted { offset: "0", limit: "260" } — the note was
    // silently dropped because numField only accepted typeof === 'number'.
    expect(readRangeLabel({ offset: '0', limit: '260' })).toBe('前 260 行')
    expect(readRangeLabel({ offset: '20', limit: '41' })).toBe('第 20–60 行')
    expect(readRangeLabel({ offset: '', limit: 'abc' })).toBe('全文')
  })
})

describe('toolMeta', () => {
  it('write → green +N行 badge', () => {
    expect(toolMeta('write', 'write_file', { content: 'a\nb\nc' }, '')).toEqual({ badge: '+3行' })
  })
  it('read → range note; edit → replacement note', () => {
    expect(toolMeta('read', 'read_file', { offset: 1, limit: 10 }, '')).toEqual({ note: '第 1–10 行' })
    expect(toolMeta('read', 'read_file', { offset: '0', limit: '260' }, '')).toEqual({ note: '前 260 行' })
    expect(toolMeta('read', 'read_file', {}, '')).toEqual({ note: '全文' })
    expect(toolMeta('edit', 'edit_file', {}, 'Edited a.py: replaced 2 occurrences.')).toEqual({ note: '替换 2 处' })
  })
  it('glob / web_search / grep counts', () => {
    expect(toolMeta('glob', 'glob', {}, 'a.ts\nb.ts')).toEqual({ note: '命中 2 个' })
    expect(toolMeta('web_search', 'web_search', {}, '  - [t](http://u): s')).toEqual({ note: '1 条' })
    expect(toolMeta('grep', 'grep', {}, 'a.py:3:hit\na.py:9:hit2')).toEqual({ note: '2 处' })
    expect(toolMeta('grep', 'grep', {}, 'a.py\nb.py')).toEqual({ note: '2 文件' })
  })
  it('grep / glob suppress fake counts on the overflow notice (no more "4 文件")', () => {
    expect(toolMeta('grep', 'grep', {}, OVERFLOW)).toEqual({})
    expect(toolMeta('glob', 'glob', {}, OVERFLOW)).toEqual({})
  })
  it('入参派生的值走 detail(紧跟主语),不是 note(行尾)', () => {
    // Position is semantic: detail belongs to the subject ("view file Y of skill X"). Moving
    // it to the end makes nine same-named Skill rows require a full-width scan to match files.
    expect(toolMeta('generic', 'view_skill', { skill_dir: '/s/a', file_path: 'ref.md' }, '')).toEqual({
      detail: 'ref.md',
    })
    expect(toolMeta('generic', 'browser_input', { text: 'hi', ref: 'e42' }, '')).toEqual({ detail: 'e42' })
    // Missing or unresolved noteKeys produce no detail; do not invent one.
    expect(toolMeta('generic', 'view_skill', { skill_dir: '/s/a' }, '')).toEqual({})
    expect(toolMeta('generic', 'browser_click', { ref: 'e1' }, '')).toEqual({})
    expect(toolMeta('generic', 'mcp__x__y', { query: 'q' }, '')).toEqual({})
  })
  it('输出派生的计量仍走 note(行尾),不被 detail 改动波及', () => {
    expect(toolMeta('read', 'read_file', {}, '').note).toBe('全文')
    expect(toolMeta('grep', 'grep', {}, 'a.py:3:hit').note).toBe('1 处')
    expect(toolMeta('read', 'read_file', {}, '').detail).toBeUndefined()
  })
  it('截断过长的 detail(与主语共享宽度,过长会把主语挤没)', () => {
    const long = 'a'.repeat(60)
    expect(toolMeta('generic', 'view_skill', { skill_dir: '/s/a', file_path: long }, '').detail).toBe(
      `${'a'.repeat(39)}…`,
    )
  })
})

describe('toolLabel — 已登记工具族(spec 驱动)', () => {
  // Real regression: three view_skill calls in one turn, with the first two reading different
  // files from the same skill. Previously all three rows said only "calling view_skill".
  it('view_skill 用技能名作主语、文件名作备注,三次调用彼此可分', () => {
    const a = { skill_dir: '/x/builtin_skills/hyperframes' }
    const b = { skill_dir: '/x/builtin_skills/remotion-best-practices', file_path: 'remotion-create/REFERENCE.md' }
    const c = { skill_dir: '/x/builtin_skills/remotion-best-practices', file_path: 'remotion-markup/REFERENCE.md' }
    expect(toolLabel('generic', 'view_skill', a)).toEqual({
      verb: '查看技能',
      subject: 'hyperframes',
      subjectFull: '/x/builtin_skills/hyperframes',
    })
    expect(toolLabel('generic', 'view_skill', b).subject).toBe('remotion-best-practices')
    expect(toolMeta('generic', 'view_skill', b, '').detail).toBe('remotion-create/REFERENCE.md')
    expect(toolMeta('generic', 'view_skill', c, '').detail).toBe('remotion-markup/REFERENCE.md')
  })
  it('browser 族:url 取域名、ref 等宽、方向枚举转中文', () => {
    expect(toolLabel('generic', 'browser_open', { url: 'https://www.example.com/a?b=1' })).toEqual({
      verb: '打开网页',
      subject: 'example.com',
      subjectFull: 'https://www.example.com/a?b=1',
    })
    expect(toolLabel('generic', 'browser_click', { ref: 'e42' })).toEqual({
      verb: '点击',
      subject: 'e42',
      subjectMono: true,
    })
    expect(toolLabel('generic', 'browser_scroll', { direction: 'down' }).subject).toBe('向下')
    // Preserve unmapped enum values instead of dropping them.
    expect(toolLabel('generic', 'browser_scroll', { direction: 'sideways' }).subject).toBe('sideways')
  })
  it('PPT 工具显示页面级动作和稳定页 id', () => {
    expect(toolLabel('generic', 'view_ppt', { target: 'decks/review.pptx' })).toEqual({
      verb: '打开 PPT',
      subject: 'review.pptx',
      subjectFull: 'decks/review.pptx',
    })
    expect(toolLabel('generic', 'edit_ppt_page', { page_id: 'page-2', ref: 'title' })).toEqual({
      verb: '编辑 PPT 页',
      subject: 'page-2',
      subjectMono: true,
    })
    expect(toolMeta('generic', 'edit_ppt_page', { page_id: 'page-2', ref: 'title' }, '').detail).toBe('title')
    expect(toolLabel('generic', 'update_ppt_design', { theme: 'midnight' })).toEqual({
      verb: '更新 PPT 设计',
      subject: 'midnight',
    })
    expect(toolMeta('generic', 'move_ppt_page', {
      page_id: 'page-2',
      target_page_id: 'page-4',
    }, '').detail).toBe('page-4')
  })
  it('无参工具只显示动词', () => {
    expect(toolLabel('generic', 'workspace_status', {})).toEqual({ verb: '查看工作区状态', subject: '' })
    expect(toolLabel('generic', 'browser_snapshot', {})).toEqual({ verb: '页面快照', subject: '' })
  })
  it('subjectKeys 按序取首个非空(update_schedule: name 优先于 schedule_id)', () => {
    expect(toolLabel('generic', 'update_schedule', { schedule_id: 's1', name: '每日晨报' }).subject).toBe('每日晨报')
    expect(toolLabel('generic', 'update_schedule', { schedule_id: 's1' }).subject).toBe('s1')
  })
  it('remove_workflow 显示明确的删除动作和 Workflow id', () => {
    expect(toolLabel('generic', 'remove_workflow', { workflow_id: 'wf_report' })).toEqual({
      verb: '删除工作流',
      subject: 'wf_report',
      subjectMono: true,
    })
  })
})

describe('toolLabel — 未登记工具 / MCP 兜底', () => {
  it('MCP 名压成 server/tool,主参数当主语', () => {
    expect(toolLabel('generic', 'mcp__codegraph__codegraph_search', { query: 'toolLabel' })).toEqual({
      verb: '调用 codegraph/codegraph_search',
      subject: 'toolLabel',
    })
  })
  it('长 MCP 名截断,保住主语不被 shrink-0 的动词挤没', () => {
    const label = toolLabel('generic', 'mcp__claude_ai_Google_Drive__search_files', { query: '季度报告' })
    expect(label.verb).toBe('调用 claude_ai_Google_Drive/sear…')
    expect(label.subject).toBe('季度报告')
  })
  it('没有语义键时退化到首个短字符串入参', () => {
    expect(toolLabel('generic', 'future_tool', { whatever: 'abc' }).subject).toBe('abc')
  })
  it('取不到主参数 → 保持旧形态「调用 <工具名>」,不编造', () => {
    expect(toolLabel('generic', 'future_tool', {})).toEqual({
      verb: '调用',
      subject: 'future_tool',
      subjectMono: true,
    })
    // Do not use long body text or HTML as the subject; it overflows the row without adding identity.
    expect(toolLabel('generic', 'future_tool', { body: 'x'.repeat(200) }).subject).toBe('future_tool')
  })
  it('非对象入参不炸', () => {
    expect(toolLabel('generic', 'future_tool', null).subject).toBe('future_tool')
    expect(toolLabel('generic', 'future_tool', 'raw').subject).toBe('future_tool')
  })
})

describe('parseOverflowNotice / formatBytes', () => {
  it('parses the backend "written to file" sentinel into path / bytes / limit', () => {
    expect(parseOverflowNotice(OVERFLOW)).toEqual({
      path: '/Users/t/.bridgic/AmphiAgent/sessions/s_1/.internal/tool_results/2026-07-06_a4a901e4.txt',
      bytes: 28068,
      limit: 16384,
    })
  })
  it('returns null for ordinary tool output', () => {
    expect(parseOverflowNotice('src/a.ts:3:hit')).toBeNull()
    expect(parseOverflowNotice('')).toBeNull()
  })
  it('formatBytes renders B / KB / MB with one decimal above 1 KB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(28068)).toBe('27.4 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('output parsers', () => {
  it('parseNumberedLines splits "  N\\tcontent", keeps notices as lineno null', () => {
    const rows = parseNumberedLines('     1\tconst a = 1\n     2\tconst b = 2\n... [3 more lines]')
    expect(rows[0]).toEqual({ lineno: 1, text: 'const a = 1' })
    expect(rows[1]).toEqual({ lineno: 2, text: 'const b = 2' })
    expect(rows[2]).toEqual({ lineno: null, text: '... [3 more lines]' })
  })

  it('parseGrepContent groups path:lineno:line by file in order', () => {
    const g = parseGrepContent('src/a.ts:3:foo()\nsrc/a.ts:9:foo2()\nsrc/b.ts:1:foo3()')
    expect(g).toEqual([
      { file: 'src/a.ts', hits: [{ lineno: 3, text: 'foo()' }, { lineno: 9, text: 'foo2()' }] },
      { file: 'src/b.ts', hits: [{ lineno: 1, text: 'foo3()' }] },
    ])
  })
  it('parseGrepContent returns [] for files-mode output (no lineno)', () => {
    expect(parseGrepContent('src/a.ts\nsrc/b.ts')).toEqual([])
  })

  it('parsePathList drops truncation / empty notices', () => {
    expect(parsePathList('src/a.ts\nsrc/b.ts\n... [5 more matches truncated]')).toEqual([
      'src/a.ts',
      'src/b.ts',
    ])
    expect(parsePathList('(No files matched.)')).toEqual([])
  })

  it('parseWebSearch parses markdown link rows with optional snippet', () => {
    const out = parseWebSearch(
      'Links:\n  - [React](https://react.dev): A library\n  - [Docs](https://x.io)\nREMINDER: ...',
    )
    expect(out).toEqual([
      { title: 'React', url: 'https://react.dev', snippet: 'A library' },
      { title: 'Docs', url: 'https://x.io', snippet: '' },
    ])
  })

  it('parseEdit / editReplacements', () => {
    expect(parseEdit({ old_string: 'a', new_string: 'b', replace_all: true })).toEqual({
      oldText: 'a',
      newText: 'b',
      replaceAll: true,
    })
    expect(editReplacements('Edited x: replaced 3 occurrences.')).toBe(3)
    expect(editReplacements('nope')).toBe(0)
  })
})

describe('small helpers', () => {
  it('basename / dirOf / domainOf', () => {
    expect(basename('a/b/c.ts')).toBe('c.ts')
    expect(basename('c.ts')).toBe('c.ts')
    expect(dirOf('a/b/c.ts')).toBe('a/b')
    expect(domainOf('https://www.example.com/x')).toBe('example.com')
    expect(domainOf('not a url')).toBe('not a url')
  })
  it('writeContentOf / commandOf / countWriteLines', () => {
    expect(writeContentOf({ content: 'x\ny' })).toBe('x\ny')
    expect(commandOf({ command: 'ls' })).toBe('ls')
    expect(countWriteLines('a\nb')).toBe(2)
    expect(countWriteLines('')).toBe(0)
  })
})
