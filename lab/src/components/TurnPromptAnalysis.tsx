import { ChevronDown, GitCompareArrows } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useI18n } from '../i18n'
import './TurnPromptAnalysis.css'

export interface RoundPromptPotentialRow {
  roundId: string
  ordinal: number
  estimatedInputTokens: number | null
  outputTokens: number | null
  reusableTokens: number | null
  nonReusableTokens: number | null
  potentialRate: number | null
  nonReusableRate: number | null
  hasBaseline: boolean
  baselineTurnOrdinal: number | null
  baselineRoundOrdinal: number | null
  /** The first changed block in the ordered `messages` request field. */
  firstChangedBlock: string | null
  /** Tool definitions changed independently of the ordered Message blocks. */
  toolSurfaceChanged?: boolean
  nonReusableSections: string[]
}

export interface TurnPromptPotentialRow {
  turnId: string
  ordinal: number
  inputTokens: number
  outputTokens: number
  estimatedInputTokens: number | null
  reusableTokens: number | null
  nonReusableTokens: number | null
  potentialRate: number | null
  nonReusableRate: number | null
  alignmentDeltaTokens: number | null
  alignmentDeltaRate: number | null
  comparableRounds: number
  totalRounds: number
  rounds: RoundPromptPotentialRow[]
}

export interface TurnPromptAnalysisProps {
  rows: readonly TurnPromptPotentialRow[]
  selectedTurnId: string | null
  loading?: boolean
  error?: string | null
  onSelectTurn: (turnId: string) => void
  onCompareRound?: (roundId: string) => void
}

function percentage(rate: number | null): string {
  if (rate === null) return '—'
  return `${Math.round(Math.max(0, Math.min(1, rate)) * 100)}%`
}

function barWidth(rate: number | null): string {
  return rate === null ? '0%' : percentage(rate)
}

export function TurnPromptAnalysis({
  rows,
  selectedTurnId,
  loading = false,
  error = null,
  onSelectTurn,
  onCompareRound,
}: TurnPromptAnalysisProps) {
  const { formatNumber, t } = useI18n()
  const [expandedTurnId, setExpandedTurnId] = useState<string | null>(selectedTurnId)

  useEffect(() => {
    setExpandedTurnId(selectedTurnId)
  }, [selectedTurnId])

  if (loading && rows.length === 0) {
    return <div className="turn-prompt-analysis-state">{t('analysis.cachePotentialComputing')}</div>
  }

  if (error && rows.length === 0) {
    return <div className="turn-prompt-analysis-state is-error">{error}</div>
  }

  if (rows.length === 0) {
    return <div className="turn-prompt-analysis-state">{t('analysis.cachePotentialEmpty')}</div>
  }

  return (
    <div className="turn-prompt-analysis">
      <div className="turn-analysis-header" aria-hidden="true">
        <span>{t('analysis.turnColumn')}</span>
        <span>{t('analysis.inputShort')}</span>
        <span>{t('analysis.outputShort')}</span>
        <span>{t('analysis.cacheHitShort')}</span>
      </div>

      <div className="turn-analysis-list">
        {rows.map((row) => {
          const selected = row.turnId === selectedTurnId
          const expanded = selected && row.turnId === expandedTurnId

          const handleRowClick = () => {
            if (selected) {
              setExpandedTurnId((current) => current === row.turnId ? null : row.turnId)
              return
            }

            setExpandedTurnId(row.turnId)
            onSelectTurn(row.turnId)
          }

          return (
            <div
              className={`turn-analysis-item${selected ? ' is-selected' : ''}${expanded ? ' is-expanded' : ''}`}
              key={row.turnId}
            >
              <button
                type="button"
                className="turn-analysis-row"
                aria-pressed={selected}
                aria-expanded={expanded}
                onClick={handleRowClick}
              >
                <span className="turn-analysis-id">
                  <ChevronDown size={13} aria-hidden="true" />
                  T{row.ordinal + 1}
                </span>
                <code>{formatNumber(row.inputTokens)}</code>
                <code>{formatNumber(row.outputTokens)}</code>
                <span className="turn-potential-cell">
                  {row.comparableRounds > 0 ? (
                    <>
                      <strong>{percentage(row.potentialRate)}</strong>
                      <i><b style={{ width: barWidth(row.potentialRate) }} /></i>
                    </>
                  ) : (
                    <strong className="is-unavailable">
                      {row.totalRounds > 0 ? t('analysis.noComparableShort') : '—'}
                    </strong>
                  )}
                </span>
              </button>

              {expanded && (
                <div className="turn-analysis-detail">
                  {row.totalRounds === 0 ? (
                    <div className="turn-no-comparable-state">
                      <strong>{t('analysis.cachePotentialEmpty')}</strong>
                    </div>
                  ) : row.comparableRounds === 0 ? (
                    <div className="turn-no-comparable-state">
                      <strong>{t('analysis.noComparableTitle')}</strong>
                    </div>
                  ) : (
                    <div className="turn-potential-summary">
                      <span>
                        {t('analysis.cacheHitTokens')}
                        <strong>{row.reusableTokens === null ? '—' : `≈ ${formatNumber(row.reusableTokens)}`}</strong>
                      </span>
                      <span>
                        {t('analysis.cacheMissTokens')}
                        <strong>{row.nonReusableTokens === null ? '—' : `≈ ${formatNumber(row.nonReusableTokens)}`}</strong>
                      </span>
                      <span>
                        {t('analysis.estimatedPromptTokens')}
                        <strong>{row.estimatedInputTokens === null ? '—' : `≈ ${formatNumber(row.estimatedInputTokens)}`}</strong>
                      </span>
                      <span>
                        {t('analysis.requestsWithBaseline')}
                        <strong>{t('analysis.requestsWithBaselineValue', {
                          comparable: row.comparableRounds,
                          total: row.totalRounds,
                        })}</strong>
                      </span>
                    </div>
                  )}

                  {row.rounds.length > 0 && (
                    <div className="round-potential-list" aria-label={t('analysis.roundPotentialDetail')}>
                      {row.rounds.map((round) => {
                        const requestLabel = t('analysis.modelRequest', { ordinal: round.ordinal + 1 })
                        const potentialLabel = t('analysis.roundCacheHit', {
                          percentage: percentage(round.potentialRate),
                        })
                        const missLabel = t('analysis.roundCacheMiss', {
                          percentage: percentage(round.nonReusableRate),
                        })
                        const comparisonLabel = round.hasBaseline && round.firstChangedBlock
                          ? t('analysis.prefixChangesAt', { block: round.firstChangedBlock })
                          : null
                        const toolSurfaceLabel = round.hasBaseline && round.toolSurfaceChanged
                          ? t('analysis.toolSchemaChanged')
                          : null
                        const baselineLabel = round.hasBaseline
                          && round.baselineTurnOrdinal !== null
                          && round.baselineRoundOrdinal !== null
                          ? t('analysis.comparisonTarget', {
                            turn: round.baselineTurnOrdinal + 1,
                            ordinal: round.baselineRoundOrdinal + 1,
                          })
                          : null
                        const roundAriaLabel = round.hasBaseline
                          ? `${requestLabel}，${potentialLabel}${comparisonLabel ? `，${comparisonLabel}` : ''}${toolSurfaceLabel ? `，${toolSurfaceLabel}` : ''}`
                          : `${requestLabel}，${t('analysis.noComparableShort')}`

                        return (
                          <div
                            className="round-potential-row"
                            key={round.roundId}
                            aria-label={roundAriaLabel}
                          >
                            <div className="round-potential-heading">
                              <strong>{requestLabel}</strong>
                              {round.hasBaseline ? (
                                <>
                                  <span>{potentialLabel}</span>
                                  <em>{missLabel}</em>
                                </>
                              ) : (
                                <span className="round-no-comparable-label">{t('analysis.noComparableShort')}</span>
                              )}
                            </div>
                            <div className="round-token-usage">
                              <span>
                                {t('analysis.inputShort')}
                                <code>{round.estimatedInputTokens === null ? '—' : `≈ ${formatNumber(round.estimatedInputTokens)}`}</code>
                              </span>
                              <span>
                                {t('analysis.outputShort')}
                                <code>{round.outputTokens === null ? '—' : formatNumber(round.outputTokens)}</code>
                              </span>
                            </div>
                            {round.hasBaseline && (
                              <i
                                className="round-cache-split"
                                aria-label={`${potentialLabel}，${missLabel}`}
                              ><b style={{ width: barWidth(round.potentialRate) }} /></i>
                            )}
                            {baselineLabel && <small className="round-baseline-label">{baselineLabel}</small>}
                            {toolSurfaceLabel && (
                              <small className="round-tool-surface-change">{toolSurfaceLabel}</small>
                            )}
                            {comparisonLabel && <small>{comparisonLabel}</small>}
                            {round.nonReusableSections.length > 0 && round.hasBaseline && (
                              <small>{t('analysis.affectedSuffixBlocks', {
                                blocks: round.nonReusableSections.join('、'),
                              })}</small>
                            )}
                            {round.hasBaseline && onCompareRound && (
                              <button
                                type="button"
                                className="round-prompt-compare-trigger"
                                onClick={() => onCompareRound(round.roundId)}
                              >
                                <GitCompareArrows size={13} aria-hidden="true" />
                                <span>{t('analysis.viewPromptDiff')}</span>
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {(loading || error) && (
        <div className={`turn-prompt-analysis-footnote${error ? ' is-error' : ''}`}>
          {error ?? t('analysis.cachePotentialComputing')}
        </div>
      )}
    </div>
  )
}
