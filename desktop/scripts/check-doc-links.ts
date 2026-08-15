/**
 * Fail the build on documentation links that resolve to nothing.
 *
 *   bun run scripts/check-doc-links.ts
 *
 * Why this exists
 * ---------------
 * Dead cross-references have shown up three separate ways in this repo, none of
 * which any existing check would catch:
 *
 *   1. Deleting a file leaves every pointer to it dangling. Removing
 *      `desktop/.claude/` + `desktop/docs/` orphaned 20 references across
 *      READMEs, source comments, a shell allowlist and a git hook.
 *   2. A relative path with the wrong number of `../` segments. `canSendNow.ts`
 *      cited `../../../../../../docs/SERVER_API.md` — six levels lands on
 *      `desktop/docs/`, which has never held that file; seven was needed. It
 *      read as plausible from the day it was written, because nobody counts.
 *   3. A link to a file that was never created at all. NOTICE advertised a
 *      `THIRD-PARTY-LICENSES.txt` "generated at build time" for two months
 *      before the generator existed.
 *
 * Case 2 is the one worth stressing: it survives any check that greps for the
 * filename, because the filename IS right — only the depth is wrong. Nothing
 * short of resolving the path against the referring file's directory finds it.
 *
 * Scope: relative targets only. Absolute URLs would need the network, and
 * anchors (`#section`) would need a markdown parser; neither has produced a
 * real defect here, so neither is worth the machinery.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DESKTOP_DIR = resolve(import.meta.dir, '..')
const REPO_ROOT = resolve(DESKTOP_DIR, '..')

/** `[label](target)` — the standard markdown inline link. */
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g

/**
 * A relative path to a markdown file inside prose or a code comment, e.g.
 * `../docs/SERVER_API.md`. Requires at least one `../` so that bare mentions
 * ("see docs/SERVER_API.md", which name the backend repo's file rather than a
 * path relative to here) are left alone — those are deliberate shorthand.
 */
const RELATIVE_DOC_REF = /(?:\.\.\/)+[A-Za-z0-9_./-]+\.md/g

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|cjs|mjs|css|sh|nsh|yml|yaml)$/

export interface DeadLink {
  file: string
  line: number
  target: string
  resolved: string
}

/** Targets that are not filesystem paths we can resolve. */
function isExternal(target: string): boolean {
  return (
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('mailto:') ||
    target.startsWith('#') ||
    target.startsWith('<')
  )
}

/**
 * Collect every unresolvable relative reference in one file's text.
 *
 * Exported for tests: the resolution rule (relative to the REFERRING file's
 * directory, not the cwd) is the whole point, and it is the part that silently
 * produced case 2 above.
 */
export function findDeadLinks(filePath: string, content: string, isMarkdown: boolean): DeadLink[] {
  const dead: DeadLink[] = []
  const baseDir = dirname(filePath)
  const lines = content.split('\n')

  lines.forEach((line, index) => {
    const targets: string[] = []
    if (isMarkdown) {
      for (const match of line.matchAll(MARKDOWN_LINK)) {
        const target = match[1]
        if (target !== undefined && !isExternal(target)) targets.push(target)
      }
    }
    for (const match of line.matchAll(RELATIVE_DOC_REF)) targets.push(match[0])

    for (const target of targets) {
      // Strip a trailing anchor: `foo.md#section` still points at `foo.md`.
      const path = target.split('#')[0]
      if (path === undefined || path === '') continue
      const resolved = resolve(baseDir, path)
      if (existsSync(resolved)) continue
      dead.push({ file: filePath, line: index + 1, target, resolved })
    }
  })
  return dead
}

/**
 * Tracked files worth scanning, as absolute paths.
 *
 * Scoped to `desktop/` — this script ships with the desktop sub-project and is
 * run from its package.json. References may still POINT outside it (README
 * cites `../docs/SERVER_API.md`); it is the referring file that must live here.
 *
 * `__tests__` is excluded because path-guard fixtures deliberately name paths
 * that do not exist — `task-file-guard.test.ts` asserts that `../evil/...` is
 * rejected, and a checker that flags its own test data is one nobody will keep.
 *
 * This file excludes itself for the same reason: the header above quotes the
 * broken six-level path as the worked example, so the scanner would report its
 * own documentation. That went unnoticed until the first commit — while the
 * script was still untracked, `git ls-files` never handed it to itself.
 */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', 'desktop'], { cwd: REPO_ROOT, encoding: 'utf-8' })
  return out
    .split('\n')
    .filter((rel) => rel.endsWith('.md') || SOURCE_EXTENSIONS.test(rel))
    .filter((rel) => !rel.includes('__tests__'))
    .filter((rel) => !rel.endsWith('scripts/check-doc-links.ts'))
    .map((rel) => resolve(REPO_ROOT, rel))
}

function main(): void {
  const dead: DeadLink[] = []
  for (const file of trackedFiles()) {
    if (!existsSync(file)) continue
    dead.push(...findDeadLinks(file, readFileSync(file, 'utf-8'), file.endsWith('.md')))
  }

  if (dead.length === 0) {
    console.log('[check-doc-links] OK — every relative reference resolves')
    return
  }

  console.error(`[check-doc-links] FAIL — ${dead.length} reference(s) point at nothing:\n`)
  for (const link of dead) {
    console.error(`  ${link.file.replace(`${REPO_ROOT}/`, '')}:${link.line}`)
    console.error(`    "${link.target}"  →  ${link.resolved.replace(`${REPO_ROOT}/`, '')} (missing)`)
  }
  console.error('\nFix the path, or delete the reference if its target is gone for good.')
  process.exit(1)
}

if (import.meta.main) main()
