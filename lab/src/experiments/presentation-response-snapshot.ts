import snapshot from './fixtures/presentation-response-snapshot.json'

/**
 * Exact response text from one historical PPT execution, read from state.db without changes.
 * Only output and exposed reasoning text are recorded here. The surrounding presentation
 * fixture still contains illustrative prompts, tools, inspection descriptions, and metrics;
 * importing these responses does not make that mixed fixture a complete historical replay.
 * Null means the text field was absent or null. An empty string is preserved as recorded.
 */
export interface PresentationResponseSnapshotRound {
  output: string | null
  thinking: string | null
  outputFidelity?: 'recorded'
  thinkingFidelity?: 'recorded'
}

export const presentationResponseSnapshotSource = snapshot.source

export const presentationResponseSnapshot = snapshot.rounds as Readonly<Record<string, PresentationResponseSnapshotRound>>
