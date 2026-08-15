/**
 * Set the release version in every place that has to carry it.
 *
 *   bun run set-version 0.1.2
 *
 * Why this exists
 * ---------------
 * The version lives in four files. `src/__init__.py::__version__` is the truth
 * source — the daemon reports it over `/api/gateway/health` — and three copies
 * must follow it:
 *
 *   desktop/package.json                     electron-builder's `${version}`,
 *                                            so it names every artifact and is
 *                                            what the update feed advertises
 *   desktop/apps/electron/package.json       the same version, for the app
 *                                            package's own metadata
 *   .../src/shared/app-meta.ts APP_VERSION   User-Agent and the About box
 *
 * `tests/test_release_version_contract.py` already fails when they disagree,
 * so a partial bump cannot reach a release. What it cannot do is prevent the
 * partial bump: editing four files by hand and forgetting one is a normal
 * Tuesday, and the feedback arrives a full CI cycle later. This turns it into
 * one command that either writes all four or writes none.
 *
 * It also removes a subtler trap. `release_tag: 0.1.2` on the Package workflow
 * names the RELEASE, not the build — the artifacts still come out as whatever
 * `desktop/package.json` says. Release 0.1.1 shipped `Bridgic-Agent-0.1.0-*`
 * assets that way. The workflow now refuses the mismatch, and this script is
 * how you satisfy it.
 *
 * `pyproject.toml` is deliberately NOT touched: it takes its version
 * dynamically from `src/__init__.py`, and the contract test fails if a static
 * one ever reappears there.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '../..')
const SEMVER = /^\d+\.\d+\.\d+$/

/** One place the version is written, and the exact text to find there. */
interface Site {
  /** Repo-relative path, so failures name something a reader can open. */
  file: string
  /** Must capture the version in group 1 and match exactly once. */
  pattern: RegExp
  /** Rebuild the whole matched line from the new version. */
  render: (version: string) => string
}

const SITES: Site[] = [
  {
    file: 'src/__init__.py',
    pattern: /^__version__ = "(\d+\.\d+\.\d+)"$/m,
    render: (v) => `__version__ = "${v}"`,
  },
  {
    file: 'desktop/package.json',
    pattern: /^ {2}"version": "(\d+\.\d+\.\d+)",$/m,
    render: (v) => `  "version": "${v}",`,
  },
  {
    file: 'desktop/apps/electron/package.json',
    pattern: /^ {2}"version": "(\d+\.\d+\.\d+)",$/m,
    render: (v) => `  "version": "${v}",`,
  },
  {
    file: 'desktop/apps/electron/src/shared/app-meta.ts',
    pattern: /^export const APP_VERSION = '(\d+\.\d+\.\d+)'$/m,
    render: (v) => `export const APP_VERSION = '${v}'`,
  },
]

const target = process.argv[2]
if (!target || !SEMVER.test(target)) {
  console.error('usage: bun run set-version <x.y.z>')
  console.error(`  got: ${target ?? '(nothing)'}`)
  // Bare semver, no `v` prefix — the Package workflow's tag trigger is
  // `[0-9]+.[0-9]+.[0-9]+`, so `v0.1.2` would simply never build anything.
  console.error('  the tag trigger is bare semver; `v0.1.2` matches nothing')
  process.exit(1)
}

// Read and locate everything BEFORE writing anything. A run that dies halfway
// leaves the repo in the exact state this script exists to prevent.
const edits = SITES.map((site) => {
  const path = join(REPO_ROOT, site.file)
  const source = readFileSync(path, 'utf8')
  const matches = source.match(new RegExp(site.pattern.source, 'gm')) ?? []
  if (matches.length !== 1) {
    console.error(
      `✖ ${site.file}: expected exactly one version line, found ${matches.length}.`,
    )
    console.error(`  pattern: ${site.pattern}`)
    console.error('  The file was reformatted, or the constant moved. Fix the')
    console.error('  pattern in scripts/set-version.ts — do not hand-edit the')
    console.error('  version, or the four copies drift again.')
    process.exit(1)
  }
  const current = site.pattern.exec(source)?.[1] as string
  return { site, path, source, current }
})

const distinct = [...new Set(edits.map((e) => e.current))]
if (distinct.length > 1) {
  // Not fatal — this script is the cure — but say so, because it means the
  // repo was already in the broken state and someone should know why.
  console.warn(`! versions were already inconsistent: ${distinct.join(', ')}`)
}

let changed = 0
for (const { site, path, source, current } of edits) {
  if (current === target) {
    console.log(`  = ${site.file} (already ${target})`)
    continue
  }
  writeFileSync(path, source.replace(site.pattern, site.render(target)), 'utf8')
  console.log(`  ✔ ${site.file}: ${current} → ${target}`)
  changed += 1
}

console.log(
  changed === 0
    ? `\nNothing to do; every version already reads ${target}.`
    : `\nSet ${changed} file(s) to ${target}. Commit them together — a release`
      + '\ntag is checked against desktop/package.json at the commit it points at.',
)
