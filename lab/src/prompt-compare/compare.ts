import type { PromptReconstruction } from '../api/types'
import {
  PROMPT_BLOCK_ORDER,
  buildPromptViewModel,
  type ReadablePromptBlock,
} from '../prompt-view'
import type {
  PromptBlockChangeStatus,
  PromptBlockComparison,
  PromptComparison,
  PromptComparisonBlockSide,
  PromptComparisonEndpoint,
  PromptComparisonOptions,
  PromptMessageBlockKind,
  PromptSectionComparison,
  PromptToolSurfaceComparison,
} from './types'

const DEFAULT_EXCERPT_CHARACTER_LIMIT = 240
const PROMPT_MESSAGE_BLOCK_ORDER = PROMPT_BLOCK_ORDER.filter(
  (kind): kind is PromptMessageBlockKind => kind !== 'tools',
)

function endpoint(prompt: PromptReconstruction): PromptComparisonEndpoint {
  return {
    sessionId: prompt.sessionId,
    turnId: prompt.turnId,
    roundId: prompt.roundId,
    roundIndex: prompt.roundIndex,
    stage: prompt.stage,
    model: prompt.model,
  }
}

/** Estimate tokens consistently with the Lab cache-potential analysis. */
export function estimatePromptTextTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 4))
}

function componentIsPresent(prompt: PromptReconstruction, kind: PromptMessageBlockKind): boolean {
  return prompt.components.some((component) => component.kind === kind)
}

function blockSide(block: ReadablePromptBlock, text = block.text): PromptComparisonBlockSide {
  return {
    text,
    characterCount: text.length,
    estimatedTokenCount: estimatePromptTextTokens(text),
    fidelity: block.fidelity,
  }
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
  const limit = Math.min(left.length, right.length) - prefixLength
  let index = 0
  while (
    index < limit
    && left.charCodeAt(left.length - 1 - index) === right.charCodeAt(right.length - 1 - index)
  ) index += 1
  return index
}

function excerpt(text: string, differenceOffset: number, limit: number): string {
  if (text.length <= limit) return text
  const leadingContext = Math.floor(limit / 3)
  const start = Math.max(0, Math.min(differenceOffset - leadingContext, text.length - limit))
  const end = Math.min(text.length, start + limit)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

function statusFor(
  baselinePresent: boolean,
  currentPresent: boolean,
  baselineText: string,
  currentText: string,
): PromptBlockChangeStatus {
  if (!baselinePresent && currentPresent) return 'added'
  if (baselinePresent && !currentPresent) return 'removed'
  return baselineText === currentText ? 'same' : 'changed'
}

function compareSection(
  title: string,
  baseline: PromptComparisonBlockSide | null,
  current: PromptComparisonBlockSide | null,
  excerptLimit: number,
): PromptSectionComparison {
  const baselineText = baseline?.text ?? ''
  const currentText = current?.text ?? ''
  const commonPrefixCharacterCount = commonPrefixLength(baselineText, currentText)
  const commonSuffixCharacterCount = commonSuffixLength(
    baselineText,
    currentText,
    commonPrefixCharacterCount,
  )

  return {
    title,
    status: statusFor(baseline !== null, current !== null, baselineText, currentText),
    baseline,
    current,
    beforeText: baseline ? excerpt(baseline.text, commonPrefixCharacterCount, excerptLimit) : null,
    afterText: current ? excerpt(current.text, commonPrefixCharacterCount, excerptLimit) : null,
    characterDelta: (current?.characterCount ?? 0) - (baseline?.characterCount ?? 0),
    estimatedTokenDelta: (current?.estimatedTokenCount ?? 0) - (baseline?.estimatedTokenCount ?? 0),
    commonPrefixCharacterCount,
    commonSuffixCharacterCount,
  }
}

function compareBlock(
  kind: PromptMessageBlockKind,
  order: number,
  baselinePrompt: PromptReconstruction,
  currentPrompt: PromptReconstruction,
  baselineBlock: ReadablePromptBlock,
  currentBlock: ReadablePromptBlock,
  excerptLimit: number,
): PromptBlockComparison {
  const baselinePresent = componentIsPresent(baselinePrompt, kind)
  const currentPresent = componentIsPresent(currentPrompt, kind)
  const baseline = baselinePresent ? blockSide(baselineBlock) : null
  const current = currentPresent ? blockSide(currentBlock) : null

  return {
    kind,
    order,
    ...compareSection(
      currentBlock.title || baselineBlock.title,
      baseline,
      current,
      excerptLimit,
    ),
  }
}

function compareToolSurface(
  baselineBlock: ReadablePromptBlock,
  currentBlock: ReadablePromptBlock,
  baselineText: string,
  currentText: string,
  excerptLimit: number,
): PromptToolSurfaceComparison {
  return {
    kind: 'tools',
    ...compareSection(
      currentBlock.title || baselineBlock.title,
      blockSide(baselineBlock, baselineText),
      blockSide(currentBlock, currentText),
      excerptLimit,
    ),
  }
}

/**
 * Compare the ordered message projection and parallel tool definitions separately.
 * Equality is intentionally exact because prompt-cache prefixes are byte-sensitive.
 */
export function comparePromptReconstructions(
  baselinePrompt: PromptReconstruction,
  currentPrompt: PromptReconstruction,
  options: PromptComparisonOptions = {},
): PromptComparison {
  const excerptLimit = Math.max(24, options.excerptCharacterLimit ?? DEFAULT_EXCERPT_CHARACTER_LIMIT)
  const viewOptions = { blockTitles: options.blockTitles, emptyBlockText: '' }
  const baselineView = buildPromptViewModel(baselinePrompt, viewOptions)
  const currentView = buildPromptViewModel(currentPrompt, viewOptions)
  const baselineByKind = new Map(baselineView.blocks.map((block) => [block.kind, block]))
  const currentByKind = new Map(currentView.blocks.map((block) => [block.kind, block]))

  const blocks = PROMPT_MESSAGE_BLOCK_ORDER.map((kind, order) => {
    const baselineBlock = baselineByKind.get(kind)
    const currentBlock = currentByKind.get(kind)
    if (!baselineBlock || !currentBlock) {
      throw new Error(`Prompt view did not emit canonical block: ${kind}`)
    }
    return compareBlock(
      kind,
      order,
      baselinePrompt,
      currentPrompt,
      baselineBlock,
      currentBlock,
      excerptLimit,
    )
  })
  const baselineToolBlock = baselineByKind.get('tools')
  const currentToolBlock = currentByKind.get('tools')
  if (!baselineToolBlock || !currentToolBlock) {
    throw new Error('Prompt view did not emit the tool surface')
  }
  const toolSurface = compareToolSurface(
    baselineToolBlock,
    currentToolBlock,
    baselineView.toolSurfaceText,
    currentView.toolSurfaceText,
    excerptLimit,
  )
  const changedBlocks = blocks.filter((block) => block.status !== 'same')

  return {
    baseline: endpoint(baselinePrompt),
    current: endpoint(currentPrompt),
    blocks,
    toolSurface,
    firstChangedBlock: changedBlocks[0]?.kind ?? null,
    changedBlockCount: changedBlocks.length,
    sameBlockCount: blocks.length - changedBlocks.length,
  }
}
