import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import en from '@app/shared/i18n/locales/en.json'
import zh from '@app/shared/i18n/locales/zh.json'

// Both processes render UI the user reads and both resolve against these catalogs: the
// renderer draws the window, main draws the tray menu / application menu / quit dialog
// (through `main/i18n.mt`, which is `t` under another name). Scanning only the renderer
// would leave main's strings with no guard at all.
const SOURCE_ROOTS = ['apps/electron/src/renderer', 'apps/electron/src/main']
  .map((dir) => join(process.cwd(), dir))
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx)$/
const TRANSLATION_CALL = /\b(?:i18n\.|m)?t\(\s*['"]([^'"]+)['"]/g
// `<Trans i18nKey="…">` renders through the same catalog but never goes through `t(`.
// These calls pass no children, so a missing key renders the raw key string into the UI —
// six of them shipped that way in the Skill-import flow before this pattern was added.
const TRANS_COMPONENT = /i18nKey=[{"']+([\w.]+)/g
// Keys the regex above cannot see: built from a template literal (`t(`a.${x}`)`) or read
// out of a variable (`t(row.subKey)`). They are just as user-visible as a literal, and a
// missing one renders the raw key into the UI — `skill.import.pick.source.*` shipped that
// way precisely because nothing here listed it. Enumerate every value the interpolated
// variable can take; the source of that vocabulary is named next to each block.
const DYNAMIC_TRANSLATION_KEYS = [
  // atoms/build.ts :: BUILD_STAGES — FocusModeHeader / ProcessTimeline
  'focusMode.stages.clarify',
  'focusMode.stages.explore',
  'focusMode.stages.generate',
  'focusMode.stages.verify',
  'focusMode.stageDescriptions.clarify',
  'focusMode.stageDescriptions.explore',
  'focusMode.stageDescriptions.generate',
  'focusMode.stageDescriptions.verify',
  // CenterSchedules.tsx :: FILTER_KEYS
  'schedule.filter.all',
  'schedule.filter.active',
  'schedule.filter.paused',
  // atoms/composer-fixtures.ts :: SLASH_COMMANDS ids — slashRows.ts
  ...['schedule', 'build', 'help'].flatMap((id) => [
    `composer.command.${id}.label`,
    `composer.command.${id}.description`,
  ]),
  // lib/skillImportSource.ts :: KNOWN_SOURCES kinds ('unknown' shows the raw host instead)
  'skill.import.pick.source.github',
  'skill.import.pick.source.skillsSh',
  'skill.import.pick.source.clawhub',
  // SkillImportPick.tsx :: REMOTE_SOURCES[].subKey — read through a variable, not a literal
  'skill.import.pick.sourceList.skillsSh',
  // EmbeddedPowerPointPanel.tsx :: PowerPointLaunchState
  'session.presentation.launchButton.create',
  'session.presentation.launchButton.creating',
  'session.presentation.launchButton.ready',
  'session.presentation.launchButton.retry',
  'status.subagent.awaitingHuman',
  'status.subagent.awaitingHumanShort',
  'status.subagent.awaitingPermission',
  'status.subagent.awaitingPermissionShort',
  'status.subagent.awaitingSubagents',
  'status.subagent.awaitingSubagentsShort',
  'status.subagent.completed',
  'status.subagent.completedShort',
  'status.subagent.failed',
  'status.subagent.failedShort',
  'status.subagent.queued',
  'status.subagent.queuedShort',
  'status.subagent.running',
  'status.subagent.runningShort',
  'status.subagent.stopped',
  'status.subagent.stoppedShort',
  'status.subagent.unknown',
  'status.subagent.unknownShort',
]

const EMBEDDED_BROWSER_TRANSLATION_KEYS = [
  'session.resourcePanel.title',
  'session.resourcePanel.typeTabsAria',
  'session.resourcePanel.output',
  'session.resourcePanel.browser',
  'session.browser.tabsAria',
  'session.browser.newTab',
  'session.browser.overflowReminder',
  'session.browser.overflowReminderAction',
  'session.browser.overflowReminderAnnouncement',
  'session.browser.overflowReminderDismiss',
  'session.browser.overflowReminderTooltip',
  'session.browser.restoreSidebar',
  'session.browser.expand',
  'session.browser.closeSession',
  'session.browser.emptyTitle',
  'session.browser.emptyDetail',
  'session.browser.crashedTitle',
  'session.browser.crashedDetail',
  'session.browser.launchTitle',
  'session.browser.launchDetail',
  'session.browser.launchFailed',
  'session.browser.syncCreating',
  'session.browser.syncReady',
  'session.browser.closeTabAria',
  'session.browser.back',
  'session.browser.forward',
  'session.browser.reload',
  'session.browser.addressAria',
  'session.browser.addressPlaceholder',
  'session.browser.retry',
  'session.browser.launchButton.creating',
  'session.browser.launchButton.ready',
  'session.browser.launchButton.retry',
  'session.browser.launchButton.open',
]

const EMBEDDED_BROWSER_COMPONENTS = [
  'apps/electron/src/renderer/components/app/BrowserExpandControl.tsx',
  'apps/electron/src/renderer/components/app/EmbeddedBrowserPanel.tsx',
  'apps/electron/src/renderer/components/app/SessionResourcePanel.tsx',
]
const CJK_CHARACTER = /[\u4e00-\u9fa5]/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(file)
    return SOURCE_FILE.test(entry.name) ? [file] : []
  })
}

/** Catalog namespaces, used to tell a translation key from any other dotted string. */
const NAMESPACES = new Set(Object.keys(zh))

/** Any quoted `namespace.some.key` literal. Keys are routinely stored as **data** rather
 *  than written inside `t(...)` — `TOOL_SPECS[x].verb`, `MODE_META[x].labelKey`,
 *  `REMOTE_SOURCES[x].subKey` — and are then looked up through a variable. Matching on
 *  shape + a known namespace catches those automatically; a hand-maintained list of the
 *  ~80 of them would rot, and `tool.verb.getSchedule` shipped missing while one existed. */
const KEY_LIKE = /['"]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)['"]/g
/** Filenames share the `word.word` shape and collide with namespaces like `workflow`. */
const FILENAME = /\.(?:md|json|ts|tsx|js|jsx|css|png|svg|txt|ya?ml|py|sh|lock|log|exe|nsh|zip)$/

/** `t('some.key', { …count… })` — the only calls i18next resolves through the
 *  `_one`/`_other` plural family instead of the bare path. */
const PLURAL_CALL = /\bt\(\s*['"]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)['"]\s*,\s*\{[^}]*\bcount\b/g

function pluralKeys(): Set<string> {
  const keys = new Set<string>()
  for (const file of SOURCE_ROOTS.flatMap(sourceFiles)) {
    for (const match of readFileSync(file, 'utf8').matchAll(PLURAL_CALL)) {
      if (match[1] !== undefined) keys.add(match[1])
    }
  }
  return keys
}

function translationKeys(): string[] {
  return [...new Set([...DYNAMIC_TRANSLATION_KEYS, ...SOURCE_ROOTS.flatMap(sourceFiles).flatMap((file) => {
    const source = readFileSync(file, 'utf8')
    const explicit = [...source.matchAll(TRANSLATION_CALL), ...source.matchAll(TRANS_COMPONENT)]
      .map((match) => match[1])
    const stored = [...source.matchAll(KEY_LIKE)]
      .map((match) => match[1])
      .filter((key): key is string =>
        key !== undefined && NAMESPACES.has(key.split('.')[0]!) && !FILENAME.test(key))
    return [...explicit, ...stored].filter((key): key is string => key !== undefined)
  })])].sort()
}

/** Resolve a dotted path against a bundle. `undefined` = not defined. */
function lookup(bundle: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    bundle,
  )
}

/**
 * A key counts as defined when the exact path exists — or, **only for keys the
 * source actually calls with `count`**, when the plural family does. `t('x', {
 * count })` never resolves `x` itself; i18next rewrites the lookup to `x_one` /
 * `x_other` (JSON v4 suffixes), so requiring the bare path would force every
 * plural key to carry a redundant entry the runtime never reads.
 *
 * The `isPlural` gate matters: accepting an `_other` sibling for *any* key would
 * let a non-plural key be renamed to `key_other` and still pass, while the
 * button rendered the literal string `update.later`.
 *
 * `_other` and not "any suffix": it is the form every locale falls back to, so a
 * key with only `_one` would still render the raw path for count ≠ 1.
 */
function isDefined(bundle: unknown, key: string, isPlural: boolean): boolean {
  if (lookup(bundle, key) !== undefined) return true
  return isPlural && lookup(bundle, `${key}_other`) !== undefined
}

describe('renderer translation coverage', () => {
  // `i18n.exists()` resolves through `fallbackLng: ['en']`, so it answers true for a key
  // that only en.json defines — which made the `zh` half of this test unable to fail. Read
  // the language's own bundle instead.
  it.each(['zh', 'en'])('defines every translation key for %s', (language) => {
    const bundle = language === 'zh' ? zh : en
    const plurals = pluralKeys()
    const missing = translationKeys().filter((key) => !isDefined(bundle, key, plurals.has(key)))
    expect(missing).toEqual([])
  })

  it('localizes every task-specification title used by the confirmation UI', () => {
    expect([
      zh.humanRequest.framework.taskTitle,
      zh.workflow.task.title,
      zh.specPreview.fileName,
    ]).toEqual(['需要你确认任务说明书', '任务说明书', '任务说明书.md'])
    expect([
      en.humanRequest.framework.taskTitle,
      en.workflow.task.title,
      en.specPreview.fileName,
    ]).toEqual([
      'Please confirm the task specification',
      'Task specification',
      'task-specification.md',
    ])
  })

  it.each(['zh', 'en'])('defines every embedded-browser key for %s', (language) => {
    const bundle = language === 'zh' ? zh : en
    const missing = EMBEDDED_BROWSER_TRANSLATION_KEYS.filter((key) => !isDefined(bundle, key, false))
    expect(missing).toEqual([])
  })

  it('uses plain browser wording in user-facing browser copy', () => {
    expect(zh.session.browser.closeSession).toBe('关闭浏览器及全部标签页')
    expect(zh.session.browser.launchTitle).toBe('打开浏览器')
    expect(zh.session.browser.launchDetail).toBe(
      '你和 Agent 都可以操作浏览器中的标签页，登录状态会保留。',
    )
    expect(en.session.browser.closeSession).toBe('Close browser and all tabs')
    expect(en.session.browser.launchTitle).toBe('Open browser')
    expect(en.session.browser.launchDetail).toBe(
      'You and the agent can both use the browser tabs. Sign-in state is retained.',
    )
  })

  it('keeps embedded-browser interface copy out of component source', () => {
    const cjkSources = EMBEDDED_BROWSER_COMPONENTS.filter((file) => CJK_CHARACTER.test(readFileSync(join(process.cwd(), file), 'utf8')))
    expect(cjkSources).toEqual([])
  })
})
