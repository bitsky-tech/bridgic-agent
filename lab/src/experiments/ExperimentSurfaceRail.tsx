import type { KeyboardEvent } from 'react'
import { Repeat2, Wrench } from 'lucide-react'
import { useI18n } from '../i18n'
import './experiment-workbench.css'

export type ExperimentSurface = 'agent' | 'tools' | 'rounds'

interface ExperimentSurfaceRailProps {
  active: ExperimentSurface | null
  onSelect: (surface: ExperimentSurface) => void
  hasSession: boolean
  hasTools: boolean
  hasRounds: boolean
  panelId: string
}

const lightLogo = new URL('../../../desktop/apps/electron/src/renderer/assets/icon-light.svg', import.meta.url).href
const darkLogo = new URL('../../../desktop/apps/electron/src/renderer/assets/icon-dark.svg', import.meta.url).href

/** Lab adapter for the desktop Session rail's dimensions, icon states, and navigation. */
export function ExperimentSurfaceRail({ active, onSelect, hasSession, hasTools, hasRounds, panelId }: ExperimentSurfaceRailProps) {
  const { locale } = useI18n()
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const entries = [
    {
      id: 'agent',
      label: 'Bridgic',
      description: t('Bridgic · 会话信息', 'Bridgic · Session information'),
      available: hasSession,
      icon: <><img className="experiment-brand-light" src={lightLogo} alt="" width={18} height={18} draggable={false} /><img className="experiment-brand-dark" src={darkLogo} alt="" width={18} height={18} draggable={false} /></>,
    },
    {
      id: 'tools',
      label: t('工具调用', 'Tools'),
      description: t('工具调用', 'Tool calls'),
      available: hasTools,
      icon: <Wrench size={17} />,
    },
    {
      id: 'rounds',
      label: t('Agent 循环', 'Rounds'),
      description: t('Agent 循环', 'Agent rounds'),
      available: hasRounds,
      icon: <Repeat2 size={17} />,
    },
  ] as const

  function navigateRail(event: KeyboardEvent<HTMLButtonElement>): void {
    let direction = 0
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') direction = 1
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') direction = -1
    if (direction === 0 && event.key !== 'Home' && event.key !== 'End') return
    const tablist = event.currentTarget.closest('[role="tablist"]')
    if (!tablist) return
    const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const current = tabs.indexOf(event.currentTarget)
    if (current < 0 || tabs.length === 0) return
    event.preventDefault()
    let nextIndex = (current + direction + tabs.length) % tabs.length
    if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = tabs.length - 1
    const next = tabs[nextIndex]
    const entry = entries[nextIndex]
    if (!next || !entry) return
    next.focus()
    // Selecting an already open surface by keyboard must not toggle its panel shut.
    if (entry.id !== active) onSelect(entry.id)
  }

  return <aside className="experiment-surface-rail" data-presentation={active ? 'attached' : 'floating'} aria-label={t('实验工作台', 'Experiment workbench')}>
    <div className="experiment-tool-dock" role="tablist" aria-orientation="vertical" aria-label={t('实验侧面板', 'Experiment side panels')}>
      {entries.map(entry => {
        const selected = active === entry.id
        const state = selected ? 'active' : entry.available ? 'background-open' : undefined
        return <div className="experiment-rail-entry" role="presentation" key={entry.id}>
          {entry.id === 'tools' && <div className="experiment-agent-divider" role="presentation" />}
          <button
            id={`experiment-rail-tab-${entry.id}`}
            type="button"
            role="tab"
            className="experiment-rail-button"
            data-surface={entry.id}
            data-state={state}
            aria-label={entry.description}
            title={entry.description}
            aria-selected={selected}
            aria-expanded={selected}
            aria-controls={panelId}
            tabIndex={selected || (active === null && entry.id === 'agent') ? 0 : -1}
            onClick={() => onSelect(entry.id)}
            onKeyDown={navigateRail}
          >
            <span className="experiment-rail-icon" aria-hidden="true"><span className="experiment-rail-icon-tile">{entry.icon}</span></span>
            <span className="experiment-rail-label">{entry.label}</span>
          </button>
        </div>
      })}
    </div>
  </aside>
}
