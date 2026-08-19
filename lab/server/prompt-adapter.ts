import { join } from 'node:path'

import type { StateDataSource } from './data-source'
import { rebuildPrompt } from './prompt'
import { PromptRebuildError, type PromptRebuildResult, type PromptTurnSnapshot } from './prompt/types'
import type { MountItem, SessionItem, TurnDetail } from './types'

function mapTurn(turn: TurnDetail): PromptTurnSnapshot {
  return {
    id: turn.id,
    sessionId: turn.sessionId,
    sessionOrdinal: turn.sessionOrdinal,
    userInput: turn.userInput,
    otaRecords: turn.otaRecords.map((record) => record.raw),
    agentState: turn.agentState,
    browserToolLoaded: turn.browserToolLoaded,
    workspaceToolsLoaded: turn.workspaceToolsLoaded,
    skillsToolLoaded: turn.skillsToolLoaded,
    status: turn.status,
    error: turn.error,
    finalAnswer: turn.finalAnswer,
    model: turn.model,
    executionMode: turn.executionMode,
    createdAt: turn.createdAt,
  }
}

function parseRoundIndex(turnId: string, roundId: string): number {
  const prefix = `${turnId}:round:`
  if (!roundId.startsWith(prefix)) {
    throw new PromptRebuildError('INVALID_INPUT', 'The round id does not belong to the requested Turn.')
  }
  const ordinalText = roundId.slice(prefix.length)
  if (!/^\d+$/.test(ordinalText)) {
    throw new PromptRebuildError('INVALID_INPUT', 'The round id must end with a positive round ordinal.')
  }
  const ordinal = Number(ordinalText)
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new PromptRebuildError('INVALID_INPUT', 'The round ordinal must be a positive integer.')
  }
  return ordinal - 1
}

function rebuildFromSnapshots(
  session: SessionItem,
  mounts: MountItem[],
  turns: PromptTurnSnapshot[],
  turnId: string,
  targetRoundIndex: number,
  roundId: string,
): PromptRebuildResult {
  const workMount = mounts.find((mount) => mount.name === '.work' && mount.kind === 'folder')
  return rebuildPrompt({
    session: {
      id: session.id,
      workspaceRoot: session.workspaceRoot,
      title: session.title,
      parentSessionId: session.parentSessionId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    turns,
    targetTurnId: turnId,
    targetRoundIndex,
    targetRoundId: roundId,
    workspace: {
      workDir: workMount?.absPath ?? join(session.workspaceRoot, '.work'),
      mounts: mounts.map((mount) => ({
        id: mount.id,
        absolutePath: mount.absPath,
        kind: mount.kind,
        label: mount.name,
      })),
    },
    context: {
      referencePaths: Object.fromEntries(mounts.map((mount) => [mount.id, mount.absPath])),
    },
  })
}

export function rebuildPromptFromSource(
  source: StateDataSource,
  turnId: string,
  roundId: string,
): PromptRebuildResult {
  const targetRoundIndex = parseRoundIndex(turnId, roundId)
  const conversation = source.getPromptConversation(turnId)
  if (!conversation) {
    throw new PromptRebuildError('TURN_NOT_FOUND', `Turn ${turnId} does not exist.`)
  }

  const { session, mounts } = conversation.target
  return rebuildFromSnapshots(
    session,
    mounts,
    conversation.turns.map(mapTurn),
    turnId,
    targetRoundIndex,
    roundId,
  )
}

export function rebuildSessionPromptsFromSource(source: StateDataSource, sessionId: string): PromptRebuildResult[] | null {
  const conversation = source.getSessionPromptConversation(sessionId)
  if (!conversation) return null

  const turns = [...conversation.turns].sort((left, right) =>
    left.sessionOrdinal - right.sessionOrdinal || left.id.localeCompare(right.id))
  const snapshots = turns.map(mapTurn)
  return turns.flatMap((turn) => turn.otaRecords.flatMap((round, roundIndex) => {
    // An OTA record is opened before the model call. Without a persisted
    // think result, the record is not evidence of a completed LLM request and
    // should not participate in token or cache analysis.
    if (round.thinkResult === null) return []
    return [rebuildFromSnapshots(
      conversation.session,
      conversation.mounts,
      snapshots,
      turn.id,
      roundIndex,
      round.id,
    )]
  }))
}
