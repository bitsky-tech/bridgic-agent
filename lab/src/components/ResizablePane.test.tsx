import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ResizablePane,
  clampPaneWidth,
  paneWidthForKey,
  readStoredPaneCollapsed,
  readStoredPaneWidth,
  type PaneStorage,
} from './ResizablePane'

describe('ResizablePane', () => {
  test('clamps defaults and persisted widths to the configured bounds', () => {
    const values = new Map([['pane', '640']])
    const storage: PaneStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    }

    expect(clampPaneWidth(120, 180, 500)).toBe(180)
    expect(readStoredPaneWidth(storage, 'pane', 240, 180, 500)).toBe(500)
    expect(readStoredPaneWidth(storage, 'missing', 240, 180, 500)).toBe(240)
  })

  test('uses physical arrow direction for left and right panes', () => {
    expect(paneWidthForKey(240, 'ArrowRight', 'left', 180, 500, 20)).toBe(260)
    expect(paneWidthForKey(240, 'ArrowRight', 'right', 180, 500, 20)).toBe(220)
    expect(paneWidthForKey(240, 'Home', 'right', 180, 500, 20)).toBe(180)
    expect(paneWidthForKey(240, 'Escape', 'left', 180, 500, 20)).toBeNull()
  })

  test('uses the default collapsed state only until the user has stored a preference', () => {
    const values = new Map([
      ['expanded-pane', 'false'],
      ['collapsed-pane', 'true'],
      ['invalid-pane', 'invalid'],
    ])
    const storage: PaneStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    }

    expect(readStoredPaneCollapsed(storage, 'expanded-pane', true)).toBe(false)
    expect(readStoredPaneCollapsed(storage, 'collapsed-pane', false)).toBe(true)
    expect(readStoredPaneCollapsed(storage, 'missing-pane', true)).toBe(true)
    expect(readStoredPaneCollapsed(storage, 'invalid-pane', false)).toBe(false)
  })

  test('renders an accessible separator and collapse control', () => {
    const markup = renderToStaticMarkup(
      <ResizablePane
        side="left"
        storageKey="test-pane"
        defaultWidth={260}
        minWidth={180}
        maxWidth={420}
        storage={null}
        labels={{ resize: 'Resize sessions', collapse: 'Hide sessions', expand: 'Show sessions' }}
      >
        Sessions
      </ResizablePane>,
    )

    expect(markup).toContain('role="separator"')
    expect(markup).toContain('aria-valuemin="180"')
    expect(markup).toContain('aria-valuenow="260"')
    expect(markup).toContain('aria-label="Hide sessions"')
  })

  test('renders collapsed by default but honors a stored expanded preference', () => {
    const defaultMarkup = renderToStaticMarkup(
      <ResizablePane
        side="right"
        storageKey="analysis-width"
        defaultCollapsed
        storage={null}
        labels={{ collapse: 'Hide analysis', expand: 'Show analysis' }}
      >
        Analysis
      </ResizablePane>,
    )
    const storedExpanded: PaneStorage = {
      getItem: (key) => key === 'analysis-collapsed' ? 'false' : null,
      setItem: () => undefined,
    }
    const expandedMarkup = renderToStaticMarkup(
      <ResizablePane
        side="right"
        storageKey="analysis-width"
        collapsedStorageKey="analysis-collapsed"
        defaultCollapsed
        storage={storedExpanded}
        labels={{ collapse: 'Hide analysis', expand: 'Show analysis' }}
      >
        Analysis
      </ResizablePane>,
    )

    expect(defaultMarkup).toContain('data-collapsed="true"')
    expect(defaultMarkup).toContain('aria-expanded="false"')
    expect(defaultMarkup).toContain('aria-label="Show analysis"')
    expect(expandedMarkup).not.toContain('data-collapsed="true"')
    expect(expandedMarkup).toContain('aria-expanded="true"')
    expect(expandedMarkup).toContain('aria-label="Hide analysis"')
  })
})
