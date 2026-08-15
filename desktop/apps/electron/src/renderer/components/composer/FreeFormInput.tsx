/**
 * Core composer body: holds local input state (Segment[]), IME-safe submit,
 * Enter mode routing, draft sync to atoms (flattened to string for the
 * existing draft atom shape), and acts as host for the floating menus.
 *
 * Menu keyboard model:
 *   FreeFormInput manages selectedIndex; ArrowUp/Down/Enter/Tab/Escape are
 *   intercepted here in handleKeyDown. Menus are dumb renderers receiving
 *   { items, selectedIndex, style, onSelect }.
 *
 * Segment model:
 *   text state lifted from `string` to `Segment[]` so menu-inserted tokens
 *   render as inline non-editable badges (Backspace deletes them whole).
 *   Submit flattens via segmentsToText; sessionDraftsAtom still stores
 *   plain string (round-trip via textToSegments on session switch).
 *
 * IME contract:
 *   - onCompositionStart sets isComposingRef = true
 *   - onCompositionEnd sets isComposingRef = false
 *   - handleKeyDown checks isComposing to suppress submit + menu nav
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ComposerTarget, ModalKind, openModalAtom } from '@/atoms/amphi'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import {
  consumeMentionInsertsAtom,
  loadMountsAtom,
  pasteToSessionFilesAtom,
  pendingMentionInsertsAtom,
} from '@/atoms/mounts'
import { buildScheduleTemplateSegments, ScheduleTemplateMode } from '@/lib/scheduleTemplate'
import { workflowRunMentionLabel } from '@/lib/workflowRun'
import { readTitlebarHeight } from '@/hooks/useWindowControlsInset'
import type { WorkflowRunSummary, WorkflowSummary } from '@/lib/amphiClient'
import { RichTextInput, type RichTextInputHandle } from './RichTextInput'
import { ComposerQuoteCard } from './ComposerQuoteCard'
import { messageQuoteToChatBlock } from './messageQuote'
import { canSendNow } from './canSendNow'
import { InputToolbar } from './InputToolbar'
import { Icons } from '../amphi/Icons'
import { useComposerFileDrop } from './hooks/useComposerFileDrop'
import { useDraftSync } from './hooks/useDraftSync'
import { useCaretFloatingPosition } from './hooks/useCaretFloatingPosition'
import { useCaretRect } from './hooks/useCaretRect'
import { useSlashTrigger } from './hooks/useSlashTrigger'
import { useMentionTrigger } from './hooks/useMentionTrigger'
import { SlashMenu } from './menus/SlashMenu'
import { useSlashMenuState } from './menus/useSlashMenuState'
import { SlashRowKind, type SlashRow } from './menus/slashRows'
import { demoteUnavailableHelp, isStructuredHelpAvailable } from './helpCommand'
import { MENTION_MENU_MAX_HEIGHT, MENTION_MENU_WIDTH, MentionMenu } from './menus/MentionMenu'
import { useMentionMenuState, type MentionRow } from './menus/useMentionMenuState'
import { cycleMentionScope } from './menus/mentionScope'
import { classifyPaste, resolveFileItems, type PasteItem } from './pasteClassify'
import { useRotatingPlaceholder } from '@/hooks/useRotatingPlaceholder'
import { currentThinkingModeAtom, messageFamily } from '@/atoms/agent'
import { AgentRole } from '@shared/types'
import type { ChatBlock } from '@shared/types'
import {
  blocksToSegments,
  EMPTY_SEGMENTS,
  getReachableCaretEnd,
  hasActiveTrigger,
  isSegmentsEmpty,
  MentionGroup,
  segmentsEqual,
  segmentsToBlocks,
  segmentsToText,
  textToSegments,
  type Segment,
} from './segments'
import {
  clearPendingComposerSeedAtom,
  pendingComposerFocusAtom,
  pendingComposerSeedAtom,
  pendingComposerInsertsAtom,
  consumeComposerInsertsAtom,
  sessionDraftsAtom,
  setPendingComposerFocusAtom,
} from '@/atoms/sessions'
import { clearComposerQuoteAtom, composerQuotesAtom } from '@/atoms/composer-quote'

export interface FreeFormInputProps {
  sessionId: string | null
  onSubmit: (text: string, blocks: ChatBlock[]) => void
  onStop?: () => void
  streaming: boolean
  disabled?: boolean
  /** Replacement placeholder text while disabled (e.g. the "handle it first…" text during a parked approval). */
  disabledHint?: string
  /** 'enter' = Enter sends, Shift+Enter inserts newline. 'cmd-enter' = Cmd/Ctrl+Enter sends. */
  sendKey: 'enter' | 'cmd-enter'
  /** Slot rendered on the right of the top toolbar row (e.g. the execution-mode pill), right-aligned on the same row as the toolbar. */
  toolbarRight?: ReactNode
}

/** History used when there is no session. A frozen shared constant — useMemo returns the same
 *  reference every time so downstream useCallbacks are not rebuilt for nothing, and freezing blocks
 *  any accidental push. */
const EMPTY_HISTORY: readonly Segment[][] = Object.freeze([])

/** Input placeholder text (§1.24 value mapping via a helper, avoiding a nested ternary): disabled+hint
 *  wins, otherwise the default depends on whether there is a session — with a session it uses the
 *  rotating hints (see useRotatingPlaceholder). */
function inputPlaceholder(
  sessionId: string | null,
  disabled: boolean,
  rotatingTip: string,
  emptySession: string,
  hint?: string,
): string {
  if (disabled && hint) return hint
  if (sessionId) return rotatingTip
  return emptySession
}

export function FreeFormInput({
  sessionId,
  onSubmit,
  onStop,
  streaming,
  disabled = false,
  disabledHint,
  sendKey,
  toolbarRight,
}: FreeFormInputProps) {
  const { t } = useTranslation()
  const [segments, setSegments] = useState<Segment[]>(EMPTY_SEGMENTS)
  const composerQuotes = useAtomValue(composerQuotesAtom)
  const clearComposerQuote = useSetAtom(clearComposerQuoteAtom)
  const messageQuote = sessionId ? composerQuotes[sessionId] : undefined
  // Caret offset (flattened-text index) reported by RichTextInput on input —
  // bounds the @ / slash filter at the caret so mid-text triggers work. Null
  // until the first input; the trigger hooks fall back to end-of-content.
  const [caret, setCaret] = useState<number | null>(null)
  const editorRef = useRef<RichTextInputHandle>(null)
  const isComposingRef = useRef(false)
  // Per-session caret position (in memory, restored when switching between sessions; no need to persist across restarts).
  const sessionCaretsRef = useRef<Record<string, number | null>>({})
  // The latest caret position (synced on every onCaretChange), to be archived when leaving the session.
  const latestCaretRef = useRef<number | null>(null)
  // Mirror of the latest segments (used the same way as latestCaretRef). The keyboard handler needs to
  // read the current content to tell whether the caret has reached the end, but segments **must not** go
  // into the useCallback deps — that would rebuild handleKeyDown on every keystroke and defeat the
  // purpose of useCallback entirely.
  const latestSegmentsRef = useRef<Segment[]>(segments)
  // Synced inside an effect rather than assigned during render (§1.27: ESLint blocks writing refs
  // during render). No dependency array = refreshed after every commit, so the keyboard handler always
  // reads the latest content.
  useEffect(() => {
    latestSegmentsRef.current = segments
  })

  useEffect(() => {
    if (messageQuote) editorRef.current?.focus()
  }, [messageQuote])
  // The rotating hint only runs when "there is a session + input is enabled + the box is empty": when
  // it is non-empty the placeholder is hidden by the CSS `:empty`, and rotating anyway would just
  // re-render this contentEditable component for nothing.
  // It uses isSegmentsEmpty rather than `segmentsToText().trim()`: the latter also treats "only spaces"
  // as empty, but at that point the DOM has text nodes and the CSS `:empty` already stopped matching —
  // so it would be spinning on something invisible. This check has to line up with the CSS's notion of empty.
  const rotatingTip = useRotatingPlaceholder(
    sessionId !== null && !disabled && isSegmentsEmpty(segments),
  )
  // ── Input history (↑/↓) ─────────────────────────────────────────
  // Cursor: null = not in history (parked on "the current input"); 0 = the most recent entry, larger = older.
  const historyCursorRef = useRef<number | null>(null)
  // What the user was typing before entering history. Handed back verbatim when ↓ walks all the way
  // back out — without it, one accidental ↑ would swallow an unfinished draft.
  const stashedDraftRef = useRef<Segment[] | null>(null)
  // History is derived directly from this session's messages, never stored separately. The messages
  // are the source of truth for this data anyway: a draft getting a new id, deleting a session, a
  // restart, another device — all of it follows automatically with no synchronisation code (when you
  // maintain your own per-session copy, missing any one of those links is a bug).
  // Fidelity comes from blocks: the daemon stores the structured blocks of the input verbatim
  // (including the id/group/path of @ chips), so parsing them back into Segment[] is equivalent to the
  // original input.
  const messages = useAtomValue(messageFamily(sessionId ?? ''))
  const thinkingPosition = useAtomValue(currentThinkingModeAtom)
  const structuredHelpAvailable = isStructuredHelpAvailable(thinkingPosition)
  const sessionHistory = useMemo(() => {
    if (!sessionId) return EMPTY_HISTORY
    // Iterate in reverse and push, instead of iterating forward and unshifting — unshift has to move the
    // whole array every time, which is O(n²) inside a loop. And this memo re-runs on every token received
    // during a streaming reply (messageFamily updates at high frequency), so on a long session it would
    // keep jittering the main thread.
    const out: Segment[][] = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (!m || m.role !== AgentRole.User) continue
      // Missing blocks = that turn predates structured input being persisted (old data), so plain text is the only fallback.
      const segs = m.blocks ? blocksToSegments(m.blocks) : textToSegments(m.text)
      if (segs.length === 0) continue
      // Deduplicate adjacent entries — sending "continue" three times in a row should not require three ↑
      // presses to get past it. When iterating in reverse, "the previous adjacent message" is the one just
      // pushed (the end of the array).
      if (segmentsEqual(out[out.length - 1] ?? EMPTY_SEGMENTS, segs)) continue
      out.push(segs)
    }
    return out
  }, [sessionId, messages])

  // Seed segments from per-session draft when sessionId changes. Drafts are
  // Segment[] now, so @ mention chips (id/label/group/path) are restored intact
  // — both across a session switch and across an app restart (persisted).
  const drafts = useAtomValue(sessionDraftsAtom)
  const pendingFocus = useAtomValue(pendingComposerFocusAtom)
  const clearPendingFocus = useSetAtom(setPendingComposerFocusAtom)
  useEffect(() => {
    // A stable map reference (sessionCaretsRef is never reassigned), copied into a local so the cleanup can read/write it safely.
    const caretsStore = sessionCaretsRef.current
    // The history cursor is per-session: without resetting it, pressing ↓ after switching to a new
    // session would index session B's history with session A's position and turn up something completely
    // unrelated.
    historyCursorRef.current = null
    stashedDraftRef.current = null
    const seed = sessionId ? drafts[sessionId] : undefined
    const seedSegments = seed && seed.length > 0 ? seed : EMPTY_SEGMENTS
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSegments(seedSegments)
    // Restore this session's last caret position (if its input box was ever edited) — switching back puts
    // the caret where it was, and the @ popover reappears naturally by matching on the caret (issue 2).
    const savedCaret = sessionId ? caretsStore[sessionId] : null
    setCaret(savedCaret ?? null)
    // The ref has to follow the session switch too. It is only recorded on mouseUp/keyUp, so without
    // syncing it would keep holding the caret value of the **previous session**: if that session was
    // parked at the start of a line (0), the first ↑ after switching would be misread as "the caret is at
    // the beginning" and pop up the history, swallowing a keypress that should have moved up one line.
    // When there is nothing archived, focus() below drops the caret at the end, so we take the flattened
    // length of the seed.
    latestCaretRef.current = savedCaret ?? segmentsToText(seedSegments).length
    if (savedCaret != null) {
      editorRef.current?.focusAtOffset(savedCaret)
    } else if (pendingFocus) {
      // Nothing archived, but the user switched sessions / created one deliberately → focus the end of the
      // input box (focus already passes preventScroll).
      // Programmatic switches (startup restore / draft→daemon) do not set pendingFocus and therefore do not steal focus.
      editorRef.current?.focus()
    }
    if (pendingFocus) clearPendingFocus(false) // consume the one-shot signal
    return () => {
      // Leaving the session: store the current caret position (inside the cleanup closure sessionId is still the one being left).
      if (sessionId) caretsStore[sessionId] = latestCaretRef.current
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // One-shot pre-fill: responds to pendingComposerSeed (e.g. schedule "create / edit" opened through a
  // real new session). Independent of the [sessionId] seed effect above — when newSession reuses an
  // empty draft the sessionId does not change and that effect does not re-run; this effect depends on
  // [pendingSeed], and once it matches the target session it overwrites the content and drops the caret
  // into the first fillable slot. Declared after the seed effect: when both fire on the same mount this
  // one runs later → the pre-filled content wins. setSegments also lands as that session's draft via
  // useDraftSync.
  const pendingSeed = useAtomValue(pendingComposerSeedAtom)
  const clearPendingSeed = useSetAtom(clearPendingComposerSeedAtom)
  useEffect(() => {
    if (!pendingSeed || pendingSeed.sessionId !== sessionId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSegments(pendingSeed.segments)
    // Prefer dropping the caret into the description field (an empty slot is still enterable); otherwise fall back to the offset.
    if (pendingSeed.focusFieldId) {
      editorRef.current?.focusField(pendingSeed.focusFieldId)
    } else if (pendingSeed.caret != null) {
      setCaret(pendingSeed.caret)
      editorRef.current?.focusAtOffset(pendingSeed.caret)
    }
    clearPendingSeed()
  }, [pendingSeed, sessionId, clearPendingSeed])

  // One-shot structured insertion channel for card actions. Like a right-panel @ reference it lands at
  // the user's current caret and does not overwrite an existing draft; the queue guarantees that
  // multiple requests in the same tick cannot overwrite each other.
  const pendingComposerInserts = useAtomValue(pendingComposerInsertsAtom)
  const consumeComposerInserts = useSetAtom(consumeComposerInsertsAtom)
  useEffect(() => {
    if (pendingComposerInserts.length === 0 || !sessionId) return
    editorRef.current?.insertSegmentsAtCaret(pendingComposerInserts.flat())
    consumeComposerInserts()
  }, [consumeComposerInserts, pendingComposerInserts, sessionId])

  // Sync local segments → atom (debounced 300ms), preserving token metadata.
  useDraftSync(sessionId, segments)

  // Loading of the session mounts (per-session mounts): this is the only session-switch load point (the
  // right panel and the @ popover's useMentionMenuState both reuse the same cache and do not GET
  // again); drafts are skipped inside loadMountsAtom.
  const loadMounts = useSetAtom(loadMountsAtom)
  useEffect(() => {
    if (sessionId) void loadMounts(sessionId)
  }, [sessionId, loadMounts])

  // One-shot command channel for the right panel's "add to chat": insert the mention badge into the
  // editor and clear the slot. This is event consumption, not derived state. The insertion goes through
  // insertSegmentsAtCaret — it lands where the user last put the caret (so clicking mid-text inserts
  // exactly there) rather than blindly appending at the end; the right-panel @ button uses onMouseDown
  // preventDefault so it does not steal focus and the caret is preserved.
  const pendingMentions = useAtomValue(pendingMentionInsertsAtom)
  const consumeMentionInserts = useSetAtom(consumeMentionInsertsAtom)
  const pasteToSessionFiles = useSetAtom(pasteToSessionFilesAtom)
  const openModal = useSetAtom(openModalAtom)
  useEffect(() => {
    if (pendingMentions.length === 0 || !sessionId) return
    const segs = pendingMentions.flatMap((m) => [
      // path only exists when referencing a child item inside a mount (an @ on a right-panel tree row); it
      // is passed through to the segment → data-token-path → wire blocks. References to a mount root keep
      // the old shape.
      m.path
        ? {
            type: 'mention' as const,
            id: m.id,
            label: m.label,
            group: m.group ?? MentionGroup.File,
            path: m.path,
          }
        : { type: 'mention' as const, id: m.id, label: m.label, group: m.group ?? MentionGroup.File },
      { type: 'text' as const, value: ' ' },
    ])
    editorRef.current?.insertSegmentsAtCaret(segs)
    consumeMentionInserts()
  }, [pendingMentions, sessionId, consumeMentionInserts])

  // Menu state.
  // forceClosed is the user's deliberate intent to close the menu (Esc pressed / an item picked). It
  // must be reset once the user leaves that trigger context, otherwise: the user picks a token, presses
  // Backspace to delete it, then types a new trigger character — the match is found but forceClosed is
  // still true → the menu never opens again.
  //
  // The reset predicate = there is no longer an active trigger at the caret (hasActiveTrigger, which
  // really runs findTriggerAtCaret). That naturally preserves the Esc semantics: the caret is still
  // inside the same @ run → still matches → no reset → typing on keeps it closed. We used to scan "does
  // the trailing text segment contain /@" as the predicate, but an unrelated `/` in the body (a file
  // path /Users/…, a markdown link (a/b/)) got misread as "still on a trigger", so after picking one
  // mention forceClosed jammed permanently and every later @ was suppressed.
  const [menusForceClosed, setMenusForceClosed] = useState(false)
  useEffect(() => {
    if (!hasActiveTrigger(segments, caret)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMenusForceClosed(false)
    }
  }, [segments, caret])
  const slash = useSlashTrigger(editorRef, segments, setSegments, menusForceClosed, caret)
  const mention = useMentionTrigger(editorRef, segments, setSegments, menusForceClosed, caret)
  const anyMenuOpen = slash.isOpen || mention.isOpen

  // "/" menu rows (commands + skills + workflows + schedules, grouped but flat); the @ menu rows come from the hook below.
  const slashRows = useSlashMenuState(slash.isOpen, slash.filter, structuredHelpAvailable)

  // The @ popover state (expanded set / row derivation) is kept in a dedicated hook — this component
  // only holds selectedIndex, the menu renders the hook's rows in their original order, and the keyboard
  // index cannot drift.
  const mentionMenu = useMentionMenuState(mention.isOpen, mention.filter, sessionId)

  let activeMenuItemCount = 0
  if (slash.isOpen) {
    activeMenuItemCount = slashRows.length
  } else if (mention.isOpen) {
    activeMenuItemCount = mentionMenu.rows.length
  }

  const [selectedIndex, setSelectedIndex] = useState(0)
  // reset-on-event (not the §1.17 derived state: it resets to the constant 0 and does not infer a value
  // from deps) — any change to the menu opening/closing or the filter term sends the selection back to
  // the first row.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedIndex(0)
  }, [slash.isOpen, mention.isOpen, slash.filter, mention.filter, mentionMenu.scope])
  // Expand/collapse · every search keystroke changes the visible row count → clamp before rendering/confirming, with no extra setState.
  const clampedIndex =
    activeMenuItemCount > 0 ? Math.min(selectedIndex, activeMenuItemCount - 1) : 0

  // Caret pos for menus — tracked (not snapshotted): the hook also follows ancestor
  // scroll / window resize, so the menu stays anchored to the caret instead of being
  // left behind on the page it was opened over.
  const caretRect = useCaretRect(editorRef, anyMenuOpen, segments)
  // The mention popover is both wider and much taller than the slash menu, so the clamp and the
  // up/down flip are computed against the box of whichever menu is open (omitted = slash defaults).
  // The chrome height is read per open rather than per render: it only changes on fullscreen /
  // zoom, which cannot happen while a menu is being driven from the keyboard.
  const mentionOnly = mention.isOpen && !slash.isOpen
  const topInset = useMemo(() => (anyMenuOpen ? readTitlebarHeight() : 0), [anyMenuOpen])
  const menuStyle = useCaretFloatingPosition(caretRect, {
    width: mentionOnly ? MENTION_MENU_WIDTH : undefined,
    height: mentionOnly ? MENTION_MENU_MAX_HEIGHT : undefined,
    topInset,
  })
  /**
   * "Triggered" and "on screen" are not the same thing: scrolling the caret out of view drops the
   * style to null and the menu stops rendering, while the trigger stays armed so scrolling back
   * brings it (and the filter typed so far) straight back.
   *
   * Keyboard routing follows what is **visible**, not what is triggered — an invisible menu that
   * still swallows Enter turns a send into an unexplained reference insertion.
   */
  const anyMenuVisible = anyMenuOpen && menuStyle !== null

  /**
   * Load one history entry, and decide the caret landing position from the paging direction: paging up
   * means you are reading the beginning, paging down means you want to keep writing, so it lands at the
   * end. (Whether navigation can continue has nothing to do with the caret — see the explanation in
   * handleKeyDown — so this is purely about feel.)
   *
   * The order cannot be reversed: `focusAtOffset` **does not position immediately**, it only registers a
   * pending landing position, which RichTextInput's diff effect consumes after rewriting the DOM. So it
   * must be registered first and setSegments must trigger the rewrite second. Calling it inside a rAF
   * would be too late — the effect has already run, so not only does the registration have no effect,
   * it lingers and hijacks the caret positioning of the next DOM rewrite.
   *
   * The landing position uses a logical offset rather than `focus()` (the end): token chips are measured
   * in their flattened form, so DOM offsets and Segment[] offsets correspond one to one (see
   * segments.ts::segmentLength) and both 0 and length hit exactly.
   *
   * The two refs are written **synchronously** here rather than waiting for the post-effect
   * `onCaretChange` report: the "↑ only works on the first character, ↓ only on the last" check reads
   * exactly these, and when an arrow key auto-repeats the next keydown may arrive before the effect —
   * reading a stale value would miss the check and paging would stop working. The values are identical
   * to what the effect writes later (the landing position is pos), so this is idempotent.
   */
  const applyHistorySegments = useCallback((next: Segment[], caretAt: 'start' | 'end') => {
    // 'end' = the furthest DOM-reachable position, NOT the flattened total: a chip-ending
    // entry has no caret anchor after the trailing contenteditable=false span, so landing
    // on the total would silently fail to place the caret (see getReachableCaretEnd).
    const pos = caretAt === 'start' ? 0 : getReachableCaretEnd(next)
    editorRef.current?.focusAtOffset(pos)
    setSegments(next)
    latestSegmentsRef.current = next
    latestCaretRef.current = pos
    setCaret(pos)
  }, [])

  /**
   * History navigation. Returning true means this keypress has been consumed (the caller preventDefaults).
   *
   * Cursor semantics: null = parked on "the current input"; 0 = the most recent entry; larger = older.
   */
  const navigateHistory = useCallback(
    (direction: 'older' | 'newer'): boolean => {
      if (!sessionId || sessionHistory.length === 0) return false
      const cursor = historyCursorRef.current
      if (direction === 'older') {
        const next = cursor === null ? 0 : cursor + 1
        // Already on the oldest entry: swallow the key but do not move. Letting it through would jump the caret to the start of the line, which feels like a hiccup.
        if (next >= sessionHistory.length) return true
        // On first entering history, save what is being typed so it can be handed back when walking out again.
        if (cursor === null) stashedDraftRef.current = latestSegmentsRef.current
        historyCursorRef.current = next
        applyHistorySegments(sessionHistory[next] ?? EMPTY_SEGMENTS, 'start')
        return true
      }
      // While not in history, ↓ should have no special behaviour, so hand it back to the native handling (in a multi-line box that means moving down one line).
      if (cursor === null) return false
      const next = cursor - 1
      if (next < 0) {
        historyCursorRef.current = null
        applyHistorySegments(stashedDraftRef.current ?? EMPTY_SEGMENTS, 'end')
        stashedDraftRef.current = null
        return true
      }
      historyCursorRef.current = next
      applyHistorySegments(sessionHistory[next] ?? EMPTY_SEGMENTS, 'end')
      return true
    },
    [sessionId, sessionHistory, applyHistorySegments],
  )

  const submit = useCallback(() => {
    if (!canSendNow(sessionId, disabled, streaming)) return
    const text = segmentsToText(segments).trim()
    if (!text) return
    // Structured blocks are the input truth: the daemon walks them to inline
    // @mention paths in order; `text` is the clean display/flatten form.
    // No separate copy of the history is needed: this input is about to become a user message of this
    // session, and the history is derived from the messages. blocks are sent to the daemon with the frame
    // and persisted verbatim, so replay is faithful.
    const submittedSegments = demoteUnavailableHelp(segments, structuredHelpAvailable)
    const blocks = segmentsToBlocks(submittedSegments)
    onSubmit(text, messageQuote ? [messageQuoteToChatBlock(messageQuote), ...blocks] : blocks)
    // After sending, go back to the "current input" position so the next ↑ starts from the most recent entry.
    historyCursorRef.current = null
    stashedDraftRef.current = null
    // The input box was cleared → the caret goes back to zero. The ref must be synced: it is only recorded
    // on mouseUp/keyUp, and pressing ↑ right after sending gives no such opportunity, so the stale value
    // (the end-of-line position before sending) would make the "caret is at the beginning" check fail and
    // the history could not be recalled at all — and that is the most common path of all.
    latestCaretRef.current = 0
    setSegments(EMPTY_SEGMENTS)
    if (sessionId) clearComposerQuote(sessionId)
    setMenusForceClosed(false)
    // Keep focus in the input box after sending. RichTextInput's diff effect only restores the selection
    // while `activeElement` is still the editor, and sending the first message of a new session
    // materialises the draft into a daemon session, changing the sessionId along the way
    // (replaceDraftWithDaemonIdAtom); the remounting on that path is enough for focus to drift away — and
    // then the user has to click once more before they can keep typing. The rAF waits for the DOM rewrite to finish.
    requestAnimationFrame(() => editorRef.current?.focus())
    // disabled / streaming are read through canSendNow on the function's first line, so they must be in the deps.
  }, [segments, sessionId, onSubmit, disabled, streaming, structuredHelpAvailable, messageQuote, clearComposerQuote])

  // @ popover row → mention token: tree/search rows carry a mountId + the path relative to the mount (a
  // mount root has relPath='' and carries no path, matching the old wire shape); folder names get a
  // trailing `/`.
  // scope-link / more rows are not references — they switch category or turn to the next page, so the
  // menu stays open.
  const pickMentionRow = useCallback(
    (row: MentionRow) => {
      if (row.kind === 'scope-link') {
        mentionMenu.setScope(row.scope)
        return
      }
      if (row.kind === 'more') {
        mentionMenu.showMore(row.key)
        return
      }
      if (row.kind === 'workflow-run') {
        mention.insertItem({
          id: row.run.id,
          label: workflowRunMentionLabel(row.run),
          group: MentionGroup.WorkflowRun,
        })
      } else if (row.kind === 'workflow') {
        mention.insertItem({
          id: row.workflow.id,
          label: row.workflow.name,
          group: MentionGroup.WorkflowEntity,
        })
      } else if (row.kind === 'schedule') {
        mention.insertItem({
          id: row.schedule.id,
          label: row.schedule.name,
          group: MentionGroup.Schedule,
        })
      } else if (row.kind === 'tree') {
        mention.insertItem({
          id: row.mountId,
          label: row.nodeKind === 'folder' ? `${row.name}/` : row.name,
          group: MentionGroup.File,
          path: row.relPath || undefined,
        })
      } else {
        const h = row.hit
        mention.insertItem({
          id: h.mountId,
          label: h.kind === 'folder' ? `${h.name}/` : h.name,
          group: MentionGroup.File,
          path: h.relPath || undefined,
        })
      }
      setMenusForceClosed(true)
    },
    [mention, mentionMenu],
  )

  const previewWorkflowRun = useCallback((run: WorkflowRunSummary) => {
    openModal({
      type: ModalKind.WorkflowRunDetail,
      runId: run.id,
      composerTarget: ComposerTarget.CurrentSession,
    })
  }, [openModal])

  const previewWorkflow = useCallback((workflow: WorkflowSummary) => {
    openModal({
      type: ModalKind.WorkflowDetail,
      workflowId: workflow.id,
      workflowName: workflow.name,
      composerTarget: ComposerTarget.CurrentSession,
    })
  }, [openModal])

  // "/" menu row → dispatch: /schedule inserts the schedule template in place in the current input box
  // (replacing only the /schedule fragment and keeping the text typed before and after) and focuses the
  // description slot; other commands (/build, /help) insert a slash token that is sent to the daemon on
  // submit and recognised by the backend; Workflow inserts an execution token, a schedule inserts a "run
  // now" token, and a skill inserts a capability reference.
  const pickSlashRow = useCallback(
    (row: SlashRow) => {
      if (row.kind === SlashRowKind.Command) {
        if (row.id === 'schedule') {
          const { segments: tpl, focusFieldId } = buildScheduleTemplateSegments({ mode: ScheduleTemplateMode.Create })
          slash.insertSegments(tpl, focusFieldId)
        } else {
          slash.insertCommand(row.id, row.label)
        }
      } else if (row.kind === SlashRowKind.Workflow) {
        slash.insertWorkflow(row.id, row.label)
      } else if (row.kind === SlashRowKind.Schedule) {
        slash.insertSchedule(row.id, row.label)
      } else {
        slash.insertReference({ id: row.id, label: row.label, group: row.group })
      }
      setMenusForceClosed(true)
    },
    [slash],
  )

  const confirmMenuSelection = useCallback(() => {
    if (slash.isOpen) {
      const row = slashRows[clampedIndex]
      if (row) pickSlashRow(row)
      return
    }
    if (mention.isOpen) {
      const row = mentionMenu.rows[clampedIndex]
      if (row) pickMentionRow(row)
      return
    }
  }, [slash.isOpen, mention.isOpen, slashRows, mentionMenu.rows, clampedIndex, pickSlashRow, pickMentionRow])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.nativeEvent.isComposing || isComposingRef.current) return

      if (anyMenuVisible) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setMenusForceClosed(true)
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          if (activeMenuItemCount > 0) {
            setSelectedIndex((i) => (i + 1) % activeMenuItemCount)
          }
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          if (activeMenuItemCount > 0) {
            setSelectedIndex((i) => (i - 1 + activeMenuItemCount) % activeMenuItemCount)
          }
          return
        }
        // ←/→ wrap around the popover's 5 category tabs, in the same order as MENTION_SCOPES.
        // Only the @ popover has tabs; the slash menu has none, so its left/right keys are not intercepted and
        // are passed through to the editor for normal caret movement. A scope change sends the selected row
        // back to zero through the reset effect above.
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && mention.isOpen && !slash.isOpen) {
          e.preventDefault()
          mentionMenu.setScope(cycleMentionScope(mentionMenu.scope, e.key === 'ArrowRight' ? 'next' : 'prev'))
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          if (activeMenuItemCount > 0) {
            e.preventDefault()
            confirmMenuSelection()
            return
          }
        }
      }

      // Input history (shell style). Deliberately placed after the menu branches — while a menu is open ↑/↓ select rows.
      //
      // Taken over strictly by caret position: ↑ only pages **when** the caret is on the first character,
      // and ↓ only **when** it is on the last. Every other position is passed through to the native
      // intra-line / inter-line movement.
      //
      // What makes this self-consistent is that the landing position after paging follows the direction (see
      // applyHistorySegments):
      // ↑ lands at the start → pressing ↑ again is still at the start → you can page all the way up;
      // ↓ lands at the end → pressing ↓ again is still at the end → you can page all the way down.
      // Changing direction means moving the caret across first (one press on a single line, a few on
      // multiple lines), which matches how moving the caret in any ordinary multi-line text box feels and is not an extra burden.
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const caretPos = latestCaretRef.current ?? 0
        // ↓ pages against the furthest DOM-REACHABLE offset, not the flattened total:
        // for chip-ending content the browser can never place the caret at the total
        // (no text anchor after a trailing contenteditable=false span), so requiring
        // `>= total` would jam paging down permanently at the direction reversal.
        const reachableEnd = getReachableCaretEnd(latestSegmentsRef.current)
        if (e.key === 'ArrowUp' && caretPos <= 0 && navigateHistory('older')) {
          e.preventDefault()
          return
        }
        if (e.key === 'ArrowDown' && caretPos >= reachableEnd && navigateHistory('newer')) {
          e.preventDefault()
          return
        }
      }

      // Tab jumps between the fillable field slots of a guided template (description ↔ name), restoring the
      // keyboard reachability of the name slot — it used to be a textarea (natively tabbable) and stopped
      // being a tab stop once it became a field. Shift+Tab goes backwards; with no target to jump to the
      // native Tab is let through. While a menu is open, Tab has already been consumed above as "confirm the
      // selection" and never reaches here.
      if (e.key === 'Tab' && editorRef.current?.focusAdjacentField(e.shiftKey ? 'prev' : 'next')) {
        e.preventDefault()
        return
      }

      const isEnter = e.key === 'Enter'
      if (!isEnter) return

      const hasModifier = e.metaKey || e.ctrlKey
      if (sendKey === 'enter') {
        if (e.shiftKey) return
        e.preventDefault()
        submit()
      } else {
        if (!hasModifier) {
          // cmd-enter mode: a plain Enter = newline. The browser default is not let through (insertParagraph
          // produces <div> blocks while parseSegmentsFromDOM only recognises <br>, so the newline would be lost
          // on serialisation/echo). An explicit insertLineBreak produces <br>, matching the newline path of
          // Shift+Enter in enter mode.
          e.preventDefault()
          document.execCommand('insertLineBreak')
          return
        }
        e.preventDefault()
        submit()
      }
    },
    [
      sendKey,
      submit,
      anyMenuVisible,
      activeMenuItemCount,
      confirmMenuSelection,
      mention.isOpen,
      slash.isOpen,
      mentionMenu,
      navigateHistory,
    ],
  )

  // Shared mount routine for paste AND drop — the single content→session-file
  // pipeline (upload sourceless data, mount real paths, reveal in right panel,
  // enqueue @-mentions). On total failure the lone text/path is restored into
  // the editor so nothing the user provided is lost. See atoms/mounts.ts ::
  // pasteToSessionFilesAtom.
  const mountItems = useCallback(
    (sessionId: string, items: PasteItem[]) => {
      // Files that exist on disk (copied/dragged from Finder) get mounted by
      // their original path; only sourceless data (screenshots) is uploaded.
      const resolved = resolveFileItems(items, (f) => window.api.shell.getPathForFile(f))
      void (async () => {
        const fallback = await pasteToSessionFiles({ sessionId, items: resolved })
        if (!fallback) return
        setSegments((segs) => {
          const last = segs[segs.length - 1]
          if (last?.type === 'text') {
            return [...segs.slice(0, -1), { type: 'text', value: last.value + fallback }]
          }
          return [...segs, { type: 'text', value: fallback }]
        })
      })()
    },
    [pasteToSessionFiles],
  )

  // Paste→mount: large text / pasted files / absolute-path text become session
  // mounts, NOT editor text. Short ordinary text returns false → falls through
  // to native insertion.
  const handlePasteIntercept = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>): boolean => {
      if (!sessionId) return false
      const items = classifyPaste(
        e.clipboardData.getData('text/plain'),
        Array.from(e.clipboardData.files),
      )
      if (!items) return false
      mountItems(sessionId, items)
      return true
    },
    [sessionId, mountItems],
  )

  // Drop→mount: dropped files ride the SAME pipeline as paste (this used to be
  // a separate mock-attachment path whose files never reached the daemon).
  const { isDraggingOver, dragProps } = useComposerFileDrop((files) => {
    if (!sessionId) return
    mountItems(
      sessionId,
      files.map((file) => ({ kind: 'file', file })),
    )
  })

  const hasContent = !isSegmentsEmpty(segments)

  // Matching the design's center.jsx :: InputBar: the toolbar is its own row above the input box, and
  // the rounded input box below contains RichTextInput plus the send/stop buttons.
  const canSubmit = hasContent && canSendNow(sessionId, disabled, streaming)
  return (
    <div className="flex flex-col gap-2" {...dragProps}>
      {/* All three add-file entry points (toolbar picker / paste / drag-and-drop) converge on the session
          mount pipeline. The right slot holds the execution-mode pill, right-aligned on the same row as the toolbar. */}
      <div className="flex items-center justify-between gap-2">
        <InputToolbar />
        {toolbarRight && <div className="shrink-0">{toolbarRight}</div>}
      </div>
      <div
        className={cn(
          // shadow-md gives the composer a clear visual layer against its surroundings both in the middle of
          // Landing and at the bottom of Pipeline ("this is an interactive entry point").
          // bg-elevated (pure white in light mode / #1A1D28 in dark) is brighter than bg-input, removing the
          // "it is editable yet looks grey like it is disabled" problem (issue 5); on focus-within the border
          // turns brand, giving a clear "alive, being typed into" signal.
          'flex flex-col gap-2 px-3.5 py-2.5 rounded-lg border bg-bg-elevated shadow-md',
          'transition-colors focus-within:border-brand-blue',
          isDraggingOver ? 'border-brand-blue' : 'border-border-default',
        )}
      >
        {messageQuote && sessionId && (
          <ComposerQuoteCard quote={messageQuote} onRemove={() => clearComposerQuote(sessionId)} />
        )}
        <div className="flex items-end gap-2">
          <div className="flex-1 min-w-0">
            <RichTextInput
              ref={editorRef}
              segments={segments}
              onChange={setSegments}
              onCaretChange={(c) => {
                setCaret(c)
                latestCaretRef.current = c
              }}
              onKeyDown={handleKeyDown}
              onPasteIntercept={handlePasteIntercept}
              onCompositionStart={() => {
                isComposingRef.current = true
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false
              }}
              placeholder={inputPlaceholder(sessionId, disabled, rotatingTip, t('composer.emptySession'), disabledHint)}
              disabled={disabled || !sessionId}
            />
          </div>
          {streaming && onStop ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-status-error-bg text-status-error hover:opacity-90 flex-shrink-0"
              aria-label={t('composer.action.stop')}
            >
              {Icons.stop(14)}
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className={cn(
                'inline-flex items-center justify-center w-8 h-8 rounded-md flex-shrink-0 transition-opacity',
                canSubmit
                  ? 'bg-[image:var(--brand-gradient)] text-white hover:opacity-90 cursor-pointer'
                  : 'bg-bg-hover text-text-tertiary cursor-not-allowed',
              )}
              aria-label={t('composer.action.send')}
            >
              {Icons.send(14)}
            </button>
          )}
        </div>
      </div>
      {slash.isOpen && menuStyle && (
        <SlashMenu
          rows={slashRows}
          selectedIndex={clampedIndex}
          style={menuStyle}
          onPick={pickSlashRow}
        />
      )}
      {mention.isOpen && menuStyle && !slash.isOpen && (
        <MentionMenu
          state={mentionMenu}
          filter={mention.filter}
          selectedIndex={clampedIndex}
          style={menuStyle}
          onToggleExpand={mentionMenu.toggleExpand}
          onPick={pickMentionRow}
          onPreviewWorkflowRun={previewWorkflowRun}
          onPreviewWorkflow={previewWorkflow}
        />
      )}
    </div>
  )
}
