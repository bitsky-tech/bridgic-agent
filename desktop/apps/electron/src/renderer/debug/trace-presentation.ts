import type { DesktopDebugTurn } from '../../shared/debug-types'
import type { TraceRound } from './types'

export interface TraceTurnGroup {
  turnId: string
  turnOrdinal: number
  turn?: DesktopDebugTurn
  rounds: TraceRound[]
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function recordedText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** Read authored text fields only; attachment and command metadata are not tasks. */
export function userInputText(input: unknown): string | null {
  const direct = recordedText(input)
  if (direct !== null) return direct

  function textBlock(value: unknown): string | null {
    const directText = recordedText(value)
    if (directText !== null) return directText
    const block = object(value)
    if (!block || (block.role !== undefined && block.role !== 'user')) return null
    if (block.type !== undefined && block.type !== 'text' && block.type !== 'input_text') return null
    for (const key of ['text', 'content']) {
      const text = recordedText(block[key])
      if (text !== null) return text
    }
    if (block.type === 'text') return recordedText(block.value)
    return null
  }

  function textBlocks(value: unknown): string | null {
    if (!Array.isArray(value)) return null
    const parts = value.map(textBlock).filter((text): text is string => text !== null)
    return parts.length ? parts.join('\n') : null
  }

  if (Array.isArray(input)) return textBlocks(input)
  const stored = object(input)
  if (!stored || (stored.role !== undefined && stored.role !== 'user')) return null
  if (stored.type !== undefined && stored.type !== 'text' && stored.type !== 'input_text') return null
  for (const key of ['text', 'content', 'input']) {
    const text = recordedText(stored[key])
    if (text !== null) return text
  }
  const content = textBlocks(stored.content)
  if (content !== null) return content
  const blocks = textBlocks(stored.blocks)
  if (blocks !== null) return blocks
  return textBlock(stored)
}

/** Group only recorded rounds. Missing Turn metadata never discards a round. */
export function groupRoundsByTurn(turns: readonly DesktopDebugTurn[], rounds: readonly TraceRound[]): TraceTurnGroup[] {
  const metadata = new Map(turns.map(turn => [turn.id, turn]))
  const groups = new Map<string, TraceTurnGroup>()
  for (const round of rounds) {
    let group = groups.get(round.turnId)
    if (!group) {
      const turn = metadata.get(round.turnId)
      group = { turnId: round.turnId, turnOrdinal: turn?.sessionOrdinal ?? round.turnOrdinal, rounds: [] }
      if (turn) group.turn = turn
      groups.set(round.turnId, group)
    }
    group.rounds.push(round)
  }
  for (const group of groups.values()) {
    group.rounds.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))
  }
  return [...groups.values()].sort((a, b) => b.turnOrdinal - a.turnOrdinal || b.turnId.localeCompare(a.turnId))
}

/** Compact previews use saved response text first; the caller localizes fallbacks. */
export function roundPreview(round: TraceRound): { body: string | null; toolNames: string[]; hasThinking: boolean } {
  const body = recordedText(round.body)?.replace(/\s+/g, ' ').trim() ?? null
  const toolNames = [...new Set(round.calls.flatMap(call => {
    const name = recordedText(call.name)
    return name === null ? [] : [name.trim()]
  }))]
  return { body, toolNames, hasThinking: recordedText(round.thinking) !== null }
}
