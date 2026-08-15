/**
 * Content rendering of one assistant message (QA version H, aligned with the QA_VersionH design): the ordered blocks
 * are split into "execution process" and "final answer" — the process (thinking / intermediate prose / tools) is
 * collected into a collapsible ProcessTimeline container, while the final answer stays outside it and is always visible.
 *
 * Pure Q&A (no tools, no thinking) is not wrapped in a container; the answer is rendered directly. The splitting logic
 * lives in `lib/qaSegments.ts` (pure functions + unit tests).
 *
 * Streaming strategy: while streaming and an execution process exists, all content stays inside the container and the
 * answer is not surfaced — this avoids "intermediate prose" flashing in the answer area and then being retracted (while
 * streaming there is no way to tell whether the trailing text is intermediate prose or the final answer; see the
 * qaSegments file header). Only when the turn ends (streaming=false) is the final answer hoisted out of the container
 * according to the backend-authoritative finalAnswer. Pure Q&A streaming is unaffected (no container, the answer streams outside as usual).
 */
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import { ProcessTimeline } from './ProcessTimeline'
import { isPersistentWorkflowCard, splitProcessAndAnswer } from '@/lib/qaSegments'
import type { MessageBlock } from '@/atoms/agent'
import { BuildConfirmCard } from './BuildConfirmCard'
import { TaskConfirmCard } from './TaskConfirmCard'
import { WorkflowConfirmCard } from './WorkflowConfirmCard'
import { WorkflowResultCard } from './WorkflowResultCard'

export interface MessageContentProps {
  /** Ordered content blocks (append-only, growing progressively while streaming). */
  blocks: MessageBlock[]
  /** This bubble is an in-flight streaming turn: the execution-process container is force-expanded. */
  streaming?: boolean
  /** Backend-authoritative final answer (only available once the turn ends); passed through to the split so process/answer can be told apart precisely.
   *  `undefined` = still streaming or an old message → the split falls back to heuristics. */
  finalAnswer?: string | null
  /** Session receiving interaction responses from blocks in this message. */
  sessionId?: string
  /** A persisted parent Turn is parked while a foreground Child Session runs. */
  waitingForSubagent?: boolean
  /** The latest Agent Turn is parked on a separate human interaction card. */
  waitingForHumanRequest?: boolean
}

export function MessageContent({
  blocks,
  streaming = false,
  finalAnswer,
  sessionId,
  waitingForSubagent = false,
  waitingForHumanRequest = false,
}: MessageContentProps) {
  const hasProcess = blocks.some(
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
  const hasPendingReview = blocks.some(
    (block) =>
      (block.type === 'build_confirm' || block.type === 'task_confirm' || block.type === 'workflow_confirm') &&
      (block.status ?? 'pending') === 'pending',
  )
  // Streaming with an execution process: keep everything inside the container and do not surface the answer, so that
  // intermediate prose can never flash in the answer area and then be retracted. Pure Q&A (no tools/thinking) does not enter
  // this branch → the answer streams outside character by character as usual. When the turn ends we split precisely by the
  // backend-authoritative finalAnswer (see the file header + qaSegments).
  const { process, answer } =
    streaming && hasProcess && !hasPendingReview
      ? {
          process: blocks.filter((block) => !isPersistentWorkflowCard(block)),
          answer: blocks.filter(isPersistentWorkflowCard),
        }
      : splitProcessAndAnswer(blocks, finalAnswer)
  const answerNodes = renderAnswerBlocks(answer, sessionId, streaming)
  // This message contains a pending (undecided) approval card → the execution flow defaults to expanded, so the user can see
  // how far the agent got and what tool it wants to call before deciding (decided, terminal cards do not trigger this; staying
  // collapsed keeps the result prominent).
  const hasPendingPermission = blocks.some((b) => b.type === 'permission' && !b.decided)

  return (
    // gap-4 ≈ the gap:16 of the content column in the QA_VersionH design (execution process ↔ final answer).
    <div className="flex flex-col gap-4">
      {process.length > 0 && (
        <ProcessTimeline
          blocks={process}
          streaming={streaming}
          defaultOpen={
            hasPendingPermission ||
            hasPendingReview ||
            waitingForSubagent ||
            waitingForHumanRequest
          }
          sessionId={sessionId}
        />
      )}
      {answerNodes}
    </div>
  )
}

function renderAnswerBlocks(blocks: MessageBlock[], sessionId?: string, streaming = false) {
  const nodes: JSX.Element[] = []
  let textBuffer: string[] = []

  function flushText() {
    const text = textBuffer.join('\n\n')
    textBuffer = []
    if (!text) return
    nodes.push(
      <MarkdownMessage
        key={`text-${nodes.length}`}
        content={text}
        className="text-base leading-[1.8] text-text-primary"
        streaming={streaming}
      />,
    )
  }

  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      textBuffer.push(block.text)
      return
    }
    if (block.type === 'workflow_confirm') {
      flushText()
      if ((block.status ?? 'pending') !== 'pending') {
        nodes.push(<WorkflowConfirmCard key={block.requestId || `workflow-${index}`} block={block} />)
      }
    }
    if (block.type === 'workflow_result') {
      flushText()
      nodes.push(<WorkflowResultCard key={block.runId || `workflow-result-${index}`} block={block} />)
    }
    if (block.type === 'build_confirm') {
      flushText()
      if ((block.status ?? 'pending') !== 'pending') {
        nodes.push(
          <BuildConfirmCard
            key={block.requestId || `build-${index}`}
            block={block}
            sessionId={sessionId}
          />,
        )
      }
    }
    if (block.type === 'task_confirm') {
      flushText()
      if ((block.status ?? 'pending') !== 'pending') {
        nodes.push(
          <TaskConfirmCard
            key={block.requestId || `task-${index}`}
            block={block}
            sessionId={sessionId}
          />,
        )
      }
    }
  })
  flushText()
  return nodes
}
