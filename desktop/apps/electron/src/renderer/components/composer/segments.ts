/**
 * Segment-based composer content model.
 *
 * The composer textbox is no longer a plain string. It's a Segment[]:
 *   - text:    user-typed plain text (multiple chars concatenated)
 *   - slash:   /<commandId> token, rendered as inline non-editable badge
 *   - mention: @<label> token, rendered as inline badge with group
 *
 * Why: lets users press Backspace once to delete an entire menu-inserted
 * token, treating it as one atomic unit rather than a run of characters.
 * The non-editable inline span is the DOM primitive that gives this for
 * free in contenteditable.
 *
 * The agent-server protocol still uses `text: string` (phase 1), so we
 * flatten Segment[] at submit time via `segmentsToText(segments)`.
 *
 * Round-trip:
 *   render:    segments → innerHTML (dangerouslySetInnerHTML)
 *   serialize: contenteditable.childNodes → Segment[] (parseSegmentsFromDOM)
 *
 * Tokens are tagged via `data-token-type="slash|mention|label"` and
 * `data-token-id="..."` on the span so we can recover their identity
 * during serialize.
 */

import type { ChatBlock, MessageBlock } from '@shared/types'
import { messageQuoteFromBlock } from './messageQuote'

export type Segment =
  | { type: 'text'; value: string }
  | { type: 'slash'; id: string; label: string; resource?: 'workflow' | 'schedule' }
  | {
      type: 'mention'
      id: string
      label: string
      /** Group name from composer-fixtures (Skills/Sources/Files). Used for badge styling. */
      group: string
      /** Mount-relative POSIX path for a file/folder INSIDE a mounted folder;
       *  absent/'' = the mount root itself. Rides the contenteditable DOM
       *  round-trip via `data-token-path` and the wire via `ChatBlock.path`
       *  (the daemon joins it onto the mount root, fail-closed). */
      path?: string
    }
  | {
      /** Interactive node-view: an inline control (dropdown / fillable slot / …)
       *  rendered into a `contenteditable=false` host via React portal. Seeded by
       *  guided templates (e.g. schedule create/edit); normal chat never produces these,
       *  so existing behavior is untouched. See components/composer/widgets/. */
      type: 'widget'
      /** Registry key → the control component (widgets/registry.ts). */
      kind: string
      /** Unique id within the seeded template (compose/lookup). */
      id: string
      /** Machine value (e.g. cron string / slot text). */
      value: string
      /** Human-readable flattened form: what `segmentsToText`/the wire emit and
       *  what char-accounting counts (`data-token-flat`). Stored ON the segment
       *  so this module stays React/registry-free (keeps bun:test happy). */
      flat: string
    }
  | {
      /** An @-capable fillable region (Doubao-style [description] slot). Rendered as an EDITABLE
       *  inline span (NOT contenteditable=false), with a CSS `:empty::before`
       *  placeholder. Unlike `widget`, `parseSegmentsFromDOM` does NOT recognize it
       *  — it recurses in and flattens the field's inner text/@-mentions into the
       *  main stream, so `@` mention + trigger detection work for free (no core
       *  changes). Seed-time only: after the first parse the field boundary is gone
       *  from the model (the DOM span persists in-session for the placeholder). */
      type: 'field'
      /** Unique id (for seed-time caret targeting via data-field-id). */
      id: string
      /** Placeholder shown when the field is empty. */
      placeholder: string
      /** Initial text (empty for create / schedule.desc for edit). */
      value: string
    }

export type TokenSegment = Exclude<Segment, { type: 'text' }>

/** Empty content shorthand — a single empty-text segment so the editor always
 *  has a caret target. Frozen: it's the shared initial/reset state in several
 *  components, so an accidental in-place mutation would silently pollute every
 *  consumer; freezing turns that into a loud throw. Spread (`[...EMPTY_SEGMENTS]`)
 *  for a mutable copy. */
export const EMPTY_SEGMENTS: Segment[] = Object.freeze([{ type: 'text', value: '' }]) as Segment[]

/** True if segments contain no visible content. */
export function isSegmentsEmpty(segments: Segment[]): boolean {
  return segments.every((s) => s.type === 'text' && s.value.length === 0)
}

/** `group` values for capability-entity mentions. These persisted protocol values are stable ASCII
 *  ids — never display copy, never localized; SlashMenu maps them to translated display labels.
 *  The daemon matches them too (_workflows.py / _cognitive.py), so both sides change in lockstep.
 *  Skills can be inserted from the "/" menu; schedule references come from the "@" menu, kept
 *  separate from the run-now action in the "/" menu. Single source of truth: menu grouping and
 *  badge colours both reuse these values. */
export const CapabilityMentionGroup = {
  Skill: 'Skill',
  Workflow: 'Workflow',
  Schedule: 'Schedule',
} as const
export type CapabilityMentionGroup =
  (typeof CapabilityMentionGroup)[keyof typeof CapabilityMentionGroup]

/**
 * Every mention group this frontend **can write** (§4.11) = the three capability groups + files.
 *
 * ⚠️ The read/write asymmetry is deliberate, do not flatten it:
 *   - the **write side** (FreeFormInput inserting an @ file / useSlashTrigger inserting a capability
 *     reference) uses this const — a closed value domain we enumerate ourselves, so a typo fails to
 *     compile on the spot.
 *   - the **read side** (getMentionPrefix / getMentionBadgeClass) keeps `string` parameters — old
 *     drafts still hold 'Workflows' / 'Skills' / 'Sources' written by the previous @ menu, which is
 *     an **open set**; tightening the read side would blow up the badges of those old drafts, and
 *     the default branch in both functions exists precisely to catch them.
 */
export const MentionGroup = {
  ...CapabilityMentionGroup,
  /** File / folder reference (@ menu). The badge uses the `@` prefix, distinguishing it from the `/` of capability references. */
  File: 'File',
  /** A globally persisted Workflow execution result referenced by stable run id. */
  WorkflowRun: 'WorkflowRun',
  /** A saved Workflow definition referenced as an entity rather than executed. Distinct from the
   *  capability group 'Workflow' (a runnable reference) so the badge prefix logic can tell them apart. */
  WorkflowEntity: 'WorkflowEntity',
} as const
export type MentionGroup = (typeof MentionGroup)[keyof typeof MentionGroup]

const CAPABILITY_GROUP_SET: ReadonlySet<string> = new Set(Object.values(CapabilityMentionGroup))

/** Prefix character of a mention's **display badge**: skill/workflow capability references keep `/`;
 *  schedule references must use `@` to stay clearly apart from the "run once now" action of `/schedule`.
 *  Files and every other group also use `@`. The prefix is always exactly 1 character, which keeps
 *  `segmentLength` and the DOM textContent length in sync. */
export function getMentionPrefix(group: string): string {
  return CAPABILITY_GROUP_SET.has(group) && group !== CapabilityMentionGroup.Schedule ? '/' : '@'
}

/** Badge colour for commands (slash tokens) — entity-command (blue, from the design handoff). */
export const SLASH_BADGE_CLASS = 'bg-entity-command-bg text-entity-command'

/** Mention badges are coloured per entity (pale background + same-hue text, per the design's "slash
 *  command palette"): skill = purple · workflow = teal · run result = blue-grey · schedule = amber;
 *  files and historical / unknown groups stay purple.
 *  Fully literal class names — Tailwind v4 scans this .ts source, so runtime concatenation is banned.
 *  Shared by segmentsToHtml (the editor) and Pipeline (history bubbles): one source for the colours. */
export function getMentionBadgeClass(group: string): string {
  switch (group) {
    case CapabilityMentionGroup.Skill:
      return 'bg-entity-skill-bg text-entity-skill'
    case CapabilityMentionGroup.Workflow:
    case MentionGroup.WorkflowEntity:
      return 'bg-entity-workflow-bg text-entity-workflow'
    case CapabilityMentionGroup.Schedule:
      return 'bg-entity-schedule-bg text-entity-schedule'
    case MentionGroup.WorkflowRun:
      return 'bg-entity-workflow-run-bg text-entity-workflow-run'
    default:
      return 'bg-accent-purple-subtle text-text-accent-purple'
  }
}

/** Flatten to plain text for IPC submit. Tokens become their human-readable form. */
export function segmentsToText(segments: Segment[]): string {
  return segments
    .map((s) => {
      switch (s.type) {
        case 'text':
          return s.value
        case 'slash':
          return `/${s.resource ? s.label : s.id}`
        case 'mention':
          // Mentions inside the flat `text` always use `@`; only structured Blocks carry capability semantics.
          return `@${s.label}`
        case 'widget':
          return s.flat
        case 'field':
          return s.value
      }
    })
    .join('')
}

/** Wrap raw string into a single-text-segment list. Used when restoring drafts. */
export function textToSegments(text: string): Segment[] {
  return text.length > 0 ? [{ type: 'text', value: text }] : [...EMPTY_SEGMENTS]
}

/** Flatten the composer's `Segment[]` into the wire `ChatBlock[]` sent to the
 *  daemon. Drops empty text segments; keeps token ids/labels (and mention
 *  `group` for history badge rendering). The daemon walks these in order to
 *  inline-resolve @mention paths in place — preserving the user's ordering. */
export function segmentsToBlocks(segments: Segment[]): ChatBlock[] {
  const out: ChatBlock[] = []
  for (const s of segments) {
    if (s.type === 'text') {
      if (s.value.length > 0) out.push({ type: 'text', value: s.value })
    } else if (s.type === 'slash') {
      out.push({ type: 'slash', id: s.id, label: s.label, ...(s.resource ? { resource: s.resource } : {}) })
    } else if (s.type === 'widget') {
      // Interactive widgets flatten to their human value as a plain text block —
      // the daemon sees an ordinary filled-in sentence, no widget concept on the wire.
      if (s.flat.length > 0) out.push({ type: 'text', value: s.flat })
    } else if (s.type === 'field') {
      // Field flattens to its text (seed-time only; usually already flattened by parse).
      if (s.value.length > 0) out.push({ type: 'text', value: s.value })
    } else {
      // Carry `path` only when set — keeps root mentions byte-identical to
      // the pre-`path` wire shape.
      out.push(
        s.path
          ? { type: 'mention', id: s.id, label: s.label, group: s.group, path: s.path }
          : { type: 'mention', id: s.id, label: s.label, group: s.group },
      )
    }
  }
  return out
}

/**
 * Rebuild `Segment[]` from a persisted user message's `MessageBlock[]` —
 * the inverse of {@link segmentsToBlocks}, used to reload a past input into
 * the composer (↑/↓ history).
 *
 * Note the field rename across the wire: outbound message blocks carry text in
 * `text`, while the inbound chat frame uses `value`. This reads the outbound
 * shape (what `GET …/messages` returns).
 *
 * Not a perfect inverse, and it can't be: `widget` / `field` segments were
 * already flattened to plain text on the way out (see segmentsToBlocks), so
 * they come back as text. Everything the daemon actually persists — text,
 * mention (incl. `path`), slash — round-trips intact. Non-input block kinds
 * (thinking / tool / …) are dropped: they never came from the composer.
 */
export function blocksToSegments(blocks: MessageBlock[]): Segment[] {
  const out: Segment[] = []
  for (const b of blocks) {
    // A sent message quote is restored visually in the transcript, but ↑ history recalls only the
    // editable request. Re-inserting the prompt-only XML envelope into contenteditable would expose
    // implementation text to the user and duplicate the quoted content on a later submit.
    if (messageQuoteFromBlock(b)) continue
    if (b.type === 'text') {
      if (b.text.length > 0) out.push({ type: 'text', value: b.text })
    } else if (b.type === 'mention') {
      out.push({
        type: 'mention',
        id: b.id,
        label: b.label,
        group: b.group,
        ...(b.path ? { path: b.path } : {}),
      })
    } else if (b.type === 'slash') {
      out.push({
        type: 'slash',
        id: b.id,
        label: b.label,
        ...(b.resource ? { resource: b.resource } : {}),
      })
    }
  }
  return out
}

/** Flattened length a segment contributes to `segmentsToText`: text → its
 *  char count; slash → `/id`; mention → `@label`. Token chips count by their
 *  visible flattened form because the contenteditable DOM renders exactly that
 *  (`/id` / `@label`), so a global caret offset stays consistent between the
 *  DOM and the Segment[] model. */
export function segmentLength(s: Segment): number {
  if (s.type === 'text') return s.value.length
  if (s.type === 'slash') return (s.resource ? s.label : s.id).length + 1
  if (s.type === 'widget') return s.flat.length // widget → its flattened form
  if (s.type === 'field') return s.value.length // field → its (editable) text
  return s.label.length + 1 // mention → `@label`
}

/**
 * Furthest caret offset the browser can actually reach in the rendered DOM —
 * the end of the last non-empty text/field segment.
 *
 * Token chips are `contenteditable="false"` spans; when one ends the content
 * (no text node after it — an empty trailing text segment emits NO DOM node,
 * see segmentsToHtml) the browser cannot anchor the caret past it. So for
 * chip-ending content the reachable end is strictly less than the flattened
 * total. History ↓-paging and its 'end' landing must use this instead of the
 * total, or entries ending in a chip (e.g. a trailing @file mention whose
 * separator space was deleted) make the "caret at end" check unsatisfiable
 * and paging down jams permanently at the direction reversal.
 *
 * `field` counts as reachable: it's an EDITABLE inline span (not
 * contenteditable=false), so the caret can sit inside/after its text.
 */
export function getReachableCaretEnd(segments: Segment[]): number {
  let acc = 0
  let lastTextEnd = 0
  for (const s of segments) {
    acc += segmentLength(s)
    if ((s.type === 'text' || s.type === 'field') && s.value.length > 0) lastTextEnd = acc
  }
  return lastTextEnd
}

/**
 * Map a global caret offset (index into `segmentsToText(segments)`) to the
 * text segment it falls in, plus the offset within that segment.
 *
 * Returns null when the caret lands strictly inside a token chip (a chip is
 * `contenteditable="false"` so the caret can't really sit inside it) or past
 * a trailing token — neither is a valid place to start a trigger.
 *
 * Boundary rule: a position at the END of a text segment belongs to that
 * segment; a position at the START of a text segment that follows a token
 * belongs to the following segment.
 */
export function locateCaret(
  segments: Segment[],
  globalOffset: number,
): { segIndex: number; local: number } | null {
  let acc = 0
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i]
    if (!s) continue
    const len = segmentLength(s)
    if (globalOffset < acc + len) {
      // Strictly inside this segment — only valid when it's text.
      return s.type === 'text' ? { segIndex: i, local: globalOffset - acc } : null
    }
    if (globalOffset === acc + len && s.type === 'text') {
      // Caret at the end of a text segment lands here.
      return { segIndex: i, local: len }
    }
    acc += len
  }
  return null
}

/**
 * Find a trigger character relative to the caret.
 *
 * Ported from `@tiptap/suggestion`'s `findSuggestionMatch` (the `allowSpaces:
 * false` branch): the match is looked up in the text BEFORE the caret only
 * (ProseMirror's `$position.nodeBefore.text` analog = the caret segment's
 * `value.slice(0, caretLocal)`), the nearest preceding trigger char is taken,
 * and the run from it to the caret is the filter. Whitespace inside that run
 * closes the menu (a space ends the mention). Everything AFTER the caret is
 * pre-existing text and never enters the filter.
 *
 * Divergence from TipTap (intentional): TipTap with `allowedPrefixes: null`
 * triggers anywhere, including mid-word (`a@b`). We keep the backend's stricter
 * rule — the char before the trigger must be whitespace or line start — so the
 * menu only opens when the user typed a space (or at the very start), never
 * glued to a word / email `a@b` / URL `http://` / CJK run.
 *
 * `caret` is a global offset into `segmentsToText(segments)`; null falls back
 * to end-of-content (the trailing-trigger behavior, for the common "typing at
 * the end" case before any caret has been reported).
 */
export interface TriggerMatch {
  /** Index of the caret's text segment within `segments`. */
  segIndex: number
  /** Index of the trigger character within that segment's `value`. */
  triggerIndex: number
  /** Caret offset within that segment's `value` — where the filter ends. */
  filterEnd: number
  /** The substring between the trigger and the caret (filter input). */
  filter: string
}

export function findTriggerAtCaret(
  segments: Segment[],
  triggerChar: '/' | '@',
  caret: number | null,
): TriggerMatch | null {
  const offset = caret ?? segments.reduce((n, s) => n + segmentLength(s), 0)
  const loc = locateCaret(segments, offset)
  if (!loc) return null
  const seg = segments[loc.segIndex]
  if (!seg || seg.type !== 'text') return null
  const preCaret = seg.value.slice(0, loc.local) // = $position.nodeBefore.text
  const idx = preCaret.lastIndexOf(triggerChar)
  if (idx < 0) return null
  const run = preCaret.slice(idx + 1)
  // allowSpaces:false — any whitespace between the trigger and the caret ends
  // the mention (U+3000 = full-width space).
  if (/[\s　]/.test(run)) return null
  if (idx > 0) {
    const charBefore = preCaret.charAt(idx - 1)
    // The character before a trigger must be whitespace for it to fire (at the start of a line idx===0
    // does not enter this branch and is allowed through as well) — the user asked for @ / to only open
    // the menu "when there is a space in front"; any non-whitespace character glued to the trigger counts
    // as being inside a word and does not fire (email `a@b`, URL `http://`, inside a Latin or CJK word).
    // (\s already covers the U+3000 ideographic space; listing it explicitly matches the style of the run
    // check above.)
    if (!/[\s　]/.test(charBefore)) return null
  }
  return { segIndex: loc.segIndex, triggerIndex: idx, filterEnd: loc.local, filter: run }
}

/**
 * True when the caret currently sits inside a live trigger run for EITHER menu
 * (`@` mention or `/` slash) — i.e. `findTriggerAtCaret` would match one of them.
 *
 * The composer uses this to decide when to release its "force closed" latch
 * (set on Esc / menu-item selection): once the caret is no longer on any live
 * trigger, an earlier dismissal must NOT keep suppressing future menus.
 *
 * Deliberately asks the real matcher instead of scanning the text for `/` / `@`.
 * A raw scan false-positives on unrelated slashes/ats in prose (file paths like
 * `/Users/…`, markdown links like `(a/b/)`, URLs) — which once glued the latch
 * permanently true after the first mention selection, silently suppressing all
 * later `@` menus.
 */
export function hasActiveTrigger(segments: Segment[], caret: number | null): boolean {
  return (
    findTriggerAtCaret(segments, '@', caret) !== null ||
    findTriggerAtCaret(segments, '/', caret) !== null
  )
}

/**
 * Replace the trigger char + filter with a token segment, preserving any text
 * that sat AFTER the caret (mid-text insertion).
 *
 * Example: segments=[text "hello /bu"], match at segIndex 0 triggerIndex 6
 * filterEnd 9 with token { type: 'slash', id: 'build', label: 'build' }
 * → [text "hello ", token slash, text " "]
 *
 * The text after the caret (`value.slice(filterEnd)`) is kept as the trailing
 * text segment, joined with a single leading space when it doesn't already
 * start with whitespace. When there's no tail (caret at end of input) the
 * trailing segment is a lone ' ' — byte-identical to the pre-caret behavior,
 * so the caret naturally lands after the space on re-focus.
 */
export function replaceTriggerWithToken(
  segments: Segment[],
  match: TriggerMatch,
  token: TokenSegment,
): Segment[] {
  const seg = segments[match.segIndex]
  if (!seg || seg.type !== 'text') return segments
  const before = seg.value.slice(0, match.triggerIndex)
  const tail = seg.value.slice(match.filterEnd)
  // Empty tail → lone ' ' (end-of-input case). Non-empty tail keeps a single
  // separating space so the chip doesn't visually glue onto the following text.
  const tailValue = tail.length === 0 || /^[\s　]/.test(tail) ? tail || ' ' : ` ${tail}`
  return [
    ...segments.slice(0, match.segIndex),
    ...(before.length > 0 ? [{ type: 'text' as const, value: before }] : []),
    token,
    { type: 'text', value: tailValue },
    ...segments.slice(match.segIndex + 1),
  ]
}

/**
 * Replace the trigger char + filter with a SEQUENCE of segments (not a single
 * token), preserving text before and after the trigger run. Used by `/schedule`
 * to splice the guided schedule template into the current composer in place —
 * unlike `replaceTriggerWithToken`, the inserted content is many segments (a phrasing
 * + field + widgets), and unlike a full pendingComposerSeed it keeps whatever the
 * user typed before/after the trigger (so "let me see /schedule" doesn't lose "let me see ").
 */
export function replaceTriggerWithSegments(
  segments: Segment[],
  match: TriggerMatch,
  insert: Segment[],
): Segment[] {
  const seg = segments[match.segIndex]
  if (!seg || seg.type !== 'text') return segments
  const before = seg.value.slice(0, match.triggerIndex)
  const tail = seg.value.slice(match.filterEnd)
  return [
    ...segments.slice(0, match.segIndex),
    ...(before.length > 0 ? [{ type: 'text' as const, value: before }] : []),
    ...insert,
    ...(tail.length > 0 ? [{ type: 'text' as const, value: tail }] : []),
    ...segments.slice(match.segIndex + 1),
  ]
}

/**
 * Global caret offset that should follow a token just inserted at `match` —
 * one char past the token's flattened form (`@label` / `/id`) plus its single
 * separating space. Mirrors exactly what `replaceTriggerWithToken` produces, so
 * a menu insert can drop the caret right after the chip (not at editor end).
 *
 * Pairs with `replaceTriggerWithToken`: call both with the same (segments,
 * match, token). Shared by useMentionTrigger / useSlashTrigger so the caret
 * math lives once and is unit-testable (the composer relies on this offset NOT
 * landing on an active trigger, so its `forceClosed` latch releases after a
 * selection — see hasActiveTrigger).
 */
export function tokenInsertCaretOffset(
  segments: Segment[],
  match: TriggerMatch,
  token: TokenSegment,
): number {
  const beforeLen =
    segments.slice(0, match.segIndex).reduce((n, s) => n + segmentLength(s), 0) + match.triggerIndex
  // +1 past the token's flattened body, +1 for the trailing separator space.
  return beforeLen + segmentLength(token) + 1
}

/**
 * Parse contenteditable DOM children back into Segment[].
 *
 * Walks the tree in document order:
 *   - TEXT_NODE → text segment (merge contiguous)
 *   - <br>      → newline in text segment (contenteditable inserts <br>)
 *   - <span data-token-type="...">  → token segment with that type
 *   - anything else (clipboard wrapper span/div, stray rich-paste formatting)
 *     → RECURSE into its children, so nested text + token chips survive
 *     (flattening to textContent would drop chips inside a wrapper — which is
 *     exactly the shape pasted token html arrives in).
 *
 * Adjacent text segments are merged; empty text segments are dropped
 * except the trailing one (so caret has a place to land after the last
 * token).
 */
export function parseSegmentsFromDOM(root: HTMLElement): Segment[] {
  const out: Segment[] = []
  const pushText = (txt: string): void => {
    if (txt.length === 0) return
    const last = out[out.length - 1]
    if (last && last.type === 'text') {
      out[out.length - 1] = { type: 'text', value: last.value + txt }
    } else {
      out.push({ type: 'text', value: txt })
    }
  }

  const walk = (parent: Node): void => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        pushText(node.textContent ?? '')
        continue
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue
      const el = node as HTMLElement
      if (el.tagName === 'BR') {
        pushText('\n')
        continue
      }
      const tokenType = el.getAttribute('data-token-type')
      if (tokenType === 'slash') {
        const id = el.getAttribute('data-token-id') ?? ''
        const label = el.getAttribute('data-token-label') ?? id
        const resource = el.getAttribute('data-token-resource')
        out.push(
          resource === 'workflow' || resource === 'schedule'
            ? { type: 'slash', id, label, resource }
            : { type: 'slash', id, label },
        )
        continue
      }
      if (tokenType === 'mention') {
        const id = el.getAttribute('data-token-id') ?? ''
        const label = el.getAttribute('data-token-label') ?? ''
        const group = el.getAttribute('data-token-group') ?? ''
        const path = el.getAttribute('data-token-path')
        out.push(
          path
            ? { type: 'mention', id, label, group, path }
            : { type: 'mention', id, label, group },
        )
        continue
      }
      if (tokenType === 'widget') {
        // Read the widget's identity + current value/flat from its data-* attrs
        // (kept in sync by the portaled control). Do NOT recurse into the host —
        // its children are the React-portaled control DOM, not composer content.
        out.push({
          type: 'widget',
          kind: el.getAttribute('data-token-kind') ?? '',
          id: el.getAttribute('data-token-id') ?? '',
          value: el.getAttribute('data-token-value') ?? '',
          flat: el.getAttribute('data-token-flat') ?? '',
        })
        continue
      }
      // `field` span (has data-field-id, no data-token-type). When it's EMPTY,
      // preserve it as a field segment so an unfilled slot (e.g. the schedule name)
      // survives a model→DOM rewrite — otherwise it flattens to nothing here, drops
      // out of the model, and the next rewrite (e.g. inserting an @mention elsewhere)
      // renders without it → the block vanishes. A NON-empty field still recurses
      // below, flattening its inner text/@-mentions into the main stream (the field's
      // @-support contract — see the field-vs-token test in `__tests__/caretDom.test.ts`).
      const fieldId = el.getAttribute('data-field-id')
      if (fieldId !== null && (el.textContent ?? '').length === 0) {
        out.push({
          type: 'field',
          id: fieldId,
          placeholder: el.getAttribute('data-field-placeholder') ?? '',
          value: '',
        })
        continue
      }
      // Unknown element — recurse so its nested text + token chips survive.
      walk(el)
    }
  }
  walk(root)

  // Ensure trailing text segment exists so the caret has a landing spot
  // after the last token. (If user just inserted a token via menu, the
  // serializer would otherwise produce [..., token] with no place for
  // caret; the menu insert path already appends a trailing space, but
  // we belt-and-suspender here.)
  const last = out[out.length - 1]
  if (!last || last.type !== 'text') {
    out.push({ type: 'text', value: '' })
  }

  return out
}

/**
 * Char-accounting over a DOM subtree, mirroring `parseSegmentsFromDOM`:
 * text node → its length, `<br>` → 1 (a newline), token chip → its flattened
 * `textContent` length (`/id` / `@label`, which equals `segmentLength`), any
 * other element → recurse. Keeps a global caret offset consistent with an
 * index into `segmentsToText(parseSegmentsFromDOM(root))`.
 */
/** Char length a token/widget DOM host contributes to caret accounting.
 *  A widget host is empty in the HTML string and portal-filled at runtime, so its
 *  `textContent` (rendered control UI) is NOT its logical length — count
 *  `data-token-flat`. slash/mention chips count their rendered textContent
 *  (`/id` / `@label`), which equals their flattened form. */
export function tokenDomLength(el: HTMLElement): number {
  return el.getAttribute('data-token-type') === 'widget'
    ? (el.getAttribute('data-token-flat') ?? '').length
    : (el.textContent ?? '').length
}

function countTextChars(node: Node): number {
  let n = 0
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      n += (child.textContent ?? '').length
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const el = child as HTMLElement
    if (el.tagName === 'BR') {
      n += 1
      continue
    }
    if (el.getAttribute('data-token-type')) {
      n += tokenDomLength(el)
      continue
    }
    n += countTextChars(el)
  }
  return n
}

/**
 * Global caret offset (an index into the flattened text) for the current
 * selection collapsed inside `root`, or null when there's no selection in
 * `root`. Counts the content BEFORE the caret using `countTextChars`, so the
 * result aligns with `locateCaret` / `findTriggerAtCaret`.
 */
export function caretOffsetInEditor(root: HTMLElement): number | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.endContainer)) return null
  const pre = range.cloneRange()
  pre.selectNodeContents(root)
  pre.setEnd(range.endContainer, range.endOffset)
  return countTextChars(pre.cloneContents())
}

/** HTML-escape a plain-text value for safe innerHTML embedding. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>')
}

/** Escape a value for a double-quoted HTML *attribute* (widget data-* payloads).
 *  Unlike escapeHtml, newlines become the numeric ref `&#10;` (valid in attrs)
 *  rather than a `<br>` element. */
function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;')
}

/**
 * Render Segment[] to innerHTML string.
 *
 * Token spans are `contenteditable="false"` so backspace deletes the
 * whole span (native browser behavior). The `data-token-*` attrs are
 * what `parseSegmentsFromDOM` reads back during serialize.
 *
 * Tailwind classes here are full string literals (not runtime-concatenated),
 * so Tailwind v4's automatic content detection picks them up by scanning this
 * .ts source — no safelist needed. Verified: the token utility classes
 * (bg-accent-*-subtle, text-brand-*) survive `bun run build:renderer`.
 */
export function segmentsToHtml(segments: Segment[]): string {
  return segments
    .map((s) => {
      if (s.type === 'text') {
        // Always emit something so contenteditable has a content target.
        // Even an empty text segment is fine (browser handles).
        return escapeHtml(s.value)
      }
      if (s.type === 'widget') {
        // Empty `contenteditable=false` host — the interactive control is React-
        // portaled into it at runtime by RichTextInput. `data-token-flat` carries
        // the flattened length so char-accounting stays exact regardless of the
        // portal's rendered chars. Kept blank in the HTML string on purpose.
        return (
          `<span data-token-type="widget" data-token-kind="${escapeHtml(s.kind)}" ` +
          `data-token-id="${escapeHtml(s.id)}" data-token-value="${escapeAttr(s.value)}" ` +
          `data-token-flat="${escapeAttr(s.flat)}" contenteditable="false" ` +
          `class="align-baseline mx-0.5 select-none"></span>`
        )
      }
      if (s.type === 'field') {
        // EDITABLE (inherits contenteditable from the composer) inline span with a
        // CSS `:empty::before` placeholder. NO `data-token-type` on purpose → parse
        // recurses in and flattens its text/@-mentions into the main stream, so `@`
        // works with zero core changes. `data-field-id` is the seed-time caret target.
        return (
          `<span data-field-id="${escapeAttr(s.id)}" ` +
          `data-field-placeholder="${escapeAttr(s.placeholder)}" class="composer-field">` +
          `${escapeHtml(s.value)}` +
          `</span>`
        )
      }
      const id = escapeHtml(s.id)
      const label = escapeHtml(s.label)
      // Note: no `select-none` here. A chip is an inline atom with `contenteditable="false"` (it already
      // guarantees whole-block deletion and that you cannot select half a character); layering
      // `user-select:none` on top would stop the browser painting a selection highlight on it during
      // Cmd+A/Ctrl+A → the chip would be the one thing that stays uncoloured while the whole paragraph
      // turns blue. Without it, it highlights along with the text.
      const baseClass =
        'inline-flex items-center align-baseline px-1.5 py-0.5 mx-0.5 rounded-sm text-xs'
      if (s.type === 'slash') {
        const resource = s.resource ? `data-token-resource="${escapeHtml(s.resource)}" ` : ''
        return (
          `<span data-token-type="slash" data-token-id="${id}" data-token-label="${label}" ` +
          `${resource}` +
          `contenteditable="false" class="${baseClass} ${SLASH_BADGE_CLASS}">` +
          `/${s.resource ? label : id}` +
          `</span>`
        )
      }
      // mention — `path` must survive the DOM round-trip (user keypress →
      // parseSegmentsFromDOM) or sub-file references silently degrade to the
      // mount root after the first edit. The prefix is decided by the group: `@` for files, `/` for
      // capability references (getMentionPrefix) — always exactly 1 character, keeping segmentLength
      // consistent.
      const group = escapeHtml(s.group)
      const pathAttr = s.path ? ` data-token-path="${escapeHtml(s.path)}"` : ''
      return (
        `<span data-token-type="mention" data-token-id="${id}" data-token-label="${label}" ` +
        `data-token-group="${group}"${pathAttr} contenteditable="false" ` +
        `class="${baseClass} ${getMentionBadgeClass(s.group)}">` +
        `${getMentionPrefix(s.group)}${label}` +
        `</span>`
      )
    })
    .join('')
}

/**
 * True if two segment lists have identical content. Used to skip DOM
 * rewrites when serialized state already matches the external prop.
 */
export function segmentsEqual(a: Segment[], b: Segment[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (!x || !y) return false
    if (x.type !== y.type) return false
    if (x.type === 'text' && y.type === 'text') {
      if (x.value !== y.value) return false
    } else if (x.type === 'widget' && y.type === 'widget') {
      if (x.kind !== y.kind || x.id !== y.id || x.value !== y.value || x.flat !== y.flat) return false
    } else if (x.type === 'field' && y.type === 'field') {
      if (x.id !== y.id || x.placeholder !== y.placeholder || x.value !== y.value) return false
    } else if (
      x.type !== 'text' &&
      y.type !== 'text' &&
      x.type !== 'widget' &&
      y.type !== 'widget' &&
      x.type !== 'field' &&
      y.type !== 'field'
    ) {
      // slash | mention
      if (x.id !== y.id || x.label !== y.label) return false
      if (x.type === 'slash' && y.type === 'slash' && x.resource !== y.resource) return false
      if (x.type === 'mention' && y.type === 'mention') {
        if (x.group !== y.group) return false
        // '' and undefined are the same "mount root" meaning — don't let the
        // DOM round-trip (absent attr → no path key) trigger a rewrite loop.
        if ((x.path ?? '') !== (y.path ?? '')) return false
      }
    }
  }
  return true
}
