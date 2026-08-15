/**
 * Pure logic of the QA execution-process UI (version H): splits one assistant message's ordered
 * blocks into the two segments "execution process" and "final answer",
 * and provides the derived counts the tool rows need for rendering.
 *
 * Invariants:
 *  - Final answer = the trailing run of text blocks; everything before it (thinking/tool +
 *    intermediate text) belongs to the execution process.
 *  - When the whole message has neither tool nor thinking (plain Q&A), the execution process is
 *    empty and everything counts as the answer —— so an ordinary question/answer pair is not
 *    wrapped in a collapsible container.
 *  - When the backend-authoritative `finalAnswer` is passed in (turn finished, `!== undefined`):
 *    empty = the backend decided this turn has no final answer (the last round is
 *    request_human_choice / there are still tool_calls), so everything goes to the execution
 *    process and the intermediate body text is not repeated outside the container; when
 *    non-empty it is still split by "the trailing run of text".
 *    `undefined` (still streaming, not yet finished) falls back to the pure heuristic, which
 *    guarantees the final answer stays visible as it streams in character by character.
 *  - Pure functions, no side effects, easy to unit-test (§4.12); components only consume the results here.
 */
import type { MessageBlock } from '@/atoms/agent'

/** The two segments a message splits into: execution-process blocks + final-answer blocks. */
export interface QaSegments {
  process: MessageBlock[]
  answer: MessageBlock[]
}

/** Saved Workflow definitions and terminal results are durable output cards. */
export function isPersistentWorkflowCard(block: MessageBlock): boolean {
  return block.type === 'workflow_result' || (
    block.type === 'workflow_confirm'
    && (block.status ?? 'pending') !== 'pending'
  )
}

/** Splits blocks into "execution process" + "final answer" (see the file-header invariants).
 *  @param finalAnswer the backend-authoritative final answer (only present once the turn finishes); `undefined` = still streaming, use the heuristic. */
export function splitProcessAndAnswer(
  blocks: MessageBlock[],
  finalAnswer?: string | null,
): QaSegments {
  const confirmationIndex = blocks.findIndex(
    (block) =>
      (block.type === 'build_confirm' || block.type === 'task_confirm' || block.type === 'workflow_confirm') &&
      (block.status ?? 'pending') === 'pending',
  )
  if (confirmationIndex >= 0) {
    return {
      process: blocks.slice(0, confirmationIndex),
      answer: blocks.slice(confirmationIndex),
    }
  }
  // permission (the approval card) also counts as an execution-process entry —— like a tool it
  // belongs to the process and must go into ProcessTimeline (ordered before the gated
  // tool); otherwise a message holding only an approval card would be taken as the answer and the card would not render.
  const hasProcessKind = blocks.some(
    (b) =>
      b.type === 'tool' ||
      b.type === 'subagent' ||
      b.type === 'thinking' ||
      b.type === 'permission' ||
      b.type === 'confirmation' ||
      b.type === 'build_confirm' ||
      b.type === 'task_confirm' ||
      b.type === 'workflow_confirm' ||
      b.type === 'build_stage' ||
      b.type === 'workflow_step' ||
      b.type === 'workflow_result',
  )
  if (!hasProcessKind) return { process: [], answer: blocks }
  const persistentCards = blocks.filter(isPersistentWorkflowCard)
  const withoutPersistentCards = blocks.filter((block) => !isPersistentWorkflowCard(block))
  // The turn has finished and the backend-authoritative answer is empty → there is no visible
  // answer (e.g. it ended with request_human_choice), but saved Workflow cards are still user output and must stay permanently visible outside the container.
  if (finalAnswer !== undefined && !(finalAnswer ?? '').trim()) {
    return { process: withoutPersistentCards, answer: persistentCards }
  }
  let cut = blocks.length
  while (cut > 0 && blocks[cut - 1]?.type === 'text') cut--
  return {
    process: blocks.slice(0, cut).filter((block) => !isPersistentWorkflowCard(block)),
    answer: [
      ...blocks.slice(0, cut).filter(isPersistentWorkflowCard),
      ...blocks.slice(cut),
    ],
  }
}

/** Number of tool calls in the execution process (the container title "N calls"). */
export function countToolCalls(blocks: MessageBlock[]): number {
  return blocks.filter((b) => b.type === 'tool' || b.type === 'subagent').length
}

/** Number of non-tool entries in the execution process (the container title "M messages" /
 *  "M messages" —— thinking / body text, excluding tool calls and approval cards; aligned with
 *  the design QA_ExecProcess2's `filter(kind!=='tool')`). */
export function countMessages(blocks: MessageBlock[]): number {
  return blocks.filter(
    (b) =>
      b.type !== 'tool' &&
      b.type !== 'subagent' &&
      b.type !== 'permission' &&
      b.type !== 'confirmation' &&
      b.type !== 'build_confirm' &&
      b.type !== 'task_confirm' &&
      b.type !== 'workflow_confirm' &&
      b.type !== 'build_stage' &&
      b.type !== 'workflow_step' &&
      b.type !== 'workflow_result',
  ).length
}

/** Number of explicit human confirmations, completed or still waiting. */
export function countConfirmations(blocks: MessageBlock[]): number {
  return blocks.filter(
    (block) =>
      block.type === 'confirmation' ||
      block.type === 'permission' ||
      block.type === 'build_confirm' ||
      block.type === 'task_confirm' ||
      block.type === 'workflow_confirm',
  ).length
}

/** Workflow execution and validation sections represented in this process. */
export function countWorkflowSteps(blocks: MessageBlock[]): number {
  return blocks.filter((block) => block.type === 'workflow_step').length
}
