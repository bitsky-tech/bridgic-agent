/**
 * Guard against Chinese creeping back into source that should be language-neutral.
 *
 *   bun run check:chinese          # exit 1 on any violation
 *   bun run check:chinese --list   # print every Chinese occurrence, grouped
 *
 * Two rules, and the split matters:
 *
 *   1. **Comments must be English, everywhere.** A comment is read by whoever maintains the
 *      code, and this repo's contract is English. There is no allowlist for this — a
 *      Chinese comment is always a finding.
 *
 *   2. **Chinese string literals are allowed only in the files listed in `ALLOWED`**, each
 *      with the reason it cannot be translated. Every entry is a value some other code
 *      *compares against* — an internal discriminator, a matcher over model- or
 *      user-authored text, or a vendor name. Translating one silently breaks a condition
 *      rather than a sentence. Protocol values (mention groups, option ids) are stable
 *      ASCII by design and must NEVER appear here — display copy belongs in the catalog.
 *
 * Why a script and not a lint rule: the interesting part is the allowlist's *reasons*, and
 * the check has to span `desktop/` and the Python backend, which ESLint does not see.
 *
 * The i18n catalog is exempt by definition — it is the Chinese copy.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = join(import.meta.dir, '../..')
const CJK = /[一-龥]/
const LIST_ONLY = process.argv.includes('--list')

/**
 * The Chinese copy itself, plus this checker — it necessarily contains Chinese (the CJK
 * range in its own regex, and the allowlist reasons that quote the values they explain).
 */
const EXEMPT_FILES = new Set([
  'src/amphi_service/i18n.py',
  'desktop/scripts/check-chinese.ts',
  'lab/src/i18n/zh-CN.ts',
])

/**
 * Files permitted to hold Chinese **string literals**, with the reason each one resists
 * translation. Adding a file here should be a deliberate act, not a way to silence the
 * check — if the string is display copy, it belongs in the catalog instead.
 */
const ALLOWED: Record<string, string> = {
  // A historical persisted provider default must be recognized after an upgrade.
  'desktop/apps/electron/src/renderer/atoms/models-presets.ts': 'legacy GLM display name stored by earlier app versions',

}

function trackedSources(): string[] {
  const out = spawnSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout
  return out.split('\n').filter((f) => {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx') && !f.endsWith('.py')) return false
    if (f.endsWith('.test.ts') || f.endsWith('.test.tsx')) return false
    const parts = f.split('/')
    // Tests keep Chinese assertions and Chinese case names on purpose; docs are Chinese
    // technical writing, not product surface.
    return !parts.includes('docs') && !parts.includes('tests') && !parts.includes('__tests__')
  })
}

/** Whether `line` is (or continues) a comment. `inBlock` tracks Python docstrings. */
function commentState(line: string, isPython: boolean, inBlock: boolean): { isComment: boolean; inBlock: boolean } {
  const trimmed = line.trim()
  if (isPython) {
    const fences = (line.match(/"""/g)?.length ?? 0) + (line.match(/'''/g)?.length ?? 0)
    if (fences % 2 === 1) return { isComment: true, inBlock: !inBlock }
    return { isComment: trimmed.startsWith('#') || inBlock, inBlock }
  }
  return {
    isComment: /^(\/\/|\*|\/\*|\{\/\*)/.test(trimmed),
    inBlock,
  }
}

const commentHits: string[] = []
const literalHits = new Map<string, string[]>()

for (const file of trackedSources()) {
  if (EXEMPT_FILES.has(file)) continue
  const source = readFileSync(join(REPO_ROOT, file), 'utf8')
  const isPython = file.endsWith('.py')
  let inBlock = false
  source.split('\n').forEach((line, index) => {
    const state = commentState(line, isPython, inBlock)
    inBlock = state.inBlock
    if (!CJK.test(line)) return
    const where = `${file}:${index + 1}  ${line.trim().slice(0, 100)}`
    // Strip string literals first, then a trailing comment: only what survives *both*
    // tells us whether the Chinese sits in code or in a comment. Doing it the other way
    // round misreads `tag: 'domestic'` as a comment, because a `/` or `#` inside some other
    // literal on the line looks like a comment marker.
    const withoutLiterals = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''")
    const trailing = isPython ? /#(.*)$/.exec(withoutLiterals) : /\/\/(.*)$/.exec(withoutLiterals)
    if (state.isComment || (trailing !== null && CJK.test(trailing[1] ?? ''))) {
      commentHits.push(where)
    } else {
      const list = literalHits.get(file) ?? []
      list.push(where)
      literalHits.set(file, list)
    }
  })
}

if (LIST_ONLY) {
  console.log(`comments with Chinese: ${commentHits.length}`)
  commentHits.forEach((h) => console.log(`  ${h}`))
  console.log(`\nfiles with Chinese literals: ${literalHits.size}`)
  for (const [file, hits] of literalHits) {
    const reason = ALLOWED[file] ?? '*** NOT ALLOWED ***'
    console.log(`  ${file}  (${hits.length}) — ${reason}`)
  }
  process.exit(0)
}

const unlisted = [...literalHits.keys()].filter((f) => !(f in ALLOWED))
let failed = false

if (commentHits.length > 0) {
  failed = true
  console.error(`✖ ${commentHits.length} comment(s) contain Chinese — comments must be English:`)
  commentHits.forEach((h) => console.error(`    ${h}`))
}

if (unlisted.length > 0) {
  failed = true
  console.error(`\n✖ ${unlisted.length} file(s) hold Chinese string literals without an entry in ALLOWED:`)
  for (const file of unlisted) {
    console.error(`    ${file}`)
    literalHits.get(file)?.forEach((h) => console.error(`        ${h}`))
  }
  console.error('\n  If the string is display copy, move it into the i18n catalog. If some other')
  console.error('  code compares against it, add the file to ALLOWED with the reason why.')
}

if (failed) process.exit(1)

const allowedCount = [...literalHits.values()].reduce((n, hits) => n + hits.length, 0)
console.log(`✔ no Chinese in comments; ${allowedCount} literal(s) across ${literalHits.size} allowlisted file(s)`)
