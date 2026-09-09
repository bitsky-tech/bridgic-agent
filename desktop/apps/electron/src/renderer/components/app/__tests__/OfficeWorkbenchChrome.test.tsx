import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { OfficeAppHeader, OfficeDocumentTabs, OfficePanelControls } = await import('../OfficeWorkbenchChrome')

afterEach(() => document.body.replaceChildren())
afterAll(async () => { await GlobalRegistrator.unregister() })

describe('OfficeWorkbenchChrome', () => {
  it('reflects panel expansion without changing document state or closing the panel', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const calls: string[] = []
    const render = (expanded: boolean) => (
      <OfficeAppHeader icon={<span>App</span>} iconClassName="text-blue-500" subtitle="Session ready" title="Office" testId="office-app-header">
        <OfficePanelControls
          closeLabel="Close panel"
          expanded={expanded}
          expandLabel={expanded ? 'Restore panel' : 'Expand panel'}
          onClose={() => calls.push('close')}
          onToggleExpanded={() => calls.push('toggle')}
          testIdPrefix="office"
          toggleTestId="office-expand-control"
        />
      </OfficeAppHeader>
    )
    try {
      await act(async () => root.render(render(false)))
      const toggle = host.querySelector<HTMLButtonElement>('[data-testid="office-expand-control"]')!
      expect(toggle.getAttribute('aria-pressed')).toBe('false')
      await act(async () => toggle.click())
      expect(calls).toEqual(['toggle'])
      await act(async () => root.render(render(true)))
      expect(toggle.getAttribute('aria-pressed')).toBe('true')
      expect(toggle.getAttribute('aria-label')).toBe('Restore panel')
      expect(host.querySelector('[data-testid="office-app-header"]')?.textContent).toContain('Session ready')
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="office-close-panel"]')!.click())
      expect(calls).toEqual(['toggle', 'close'])
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('omits unavailable panel operations', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(
        <OfficePanelControls closeLabel="Close" expanded={false} expandLabel="Expand" testIdPrefix="office" />,
      ))
      expect(host.querySelector('button')).toBeNull()
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('routes tab selection, closing and creation independently while reflecting current metadata', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const calls: string[] = []
    const render = (activeId: string, disabled = false, firstLabel = 'First.pptx') => (
      <OfficeDocumentTabs
        activeId={activeId}
        actions={<span role="alert">Save failed</span>}
        icon={<span>Doc</span>}
        label="Documents"
        newDisabled={disabled}
        newIcon={<svg data-testid="custom-new-icon" />}
        newLabel="New document"
        onClose={(id) => calls.push(`close:${id}`)}
        onCreate={() => calls.push('create')}
        onSelect={(id) => calls.push(`select:${id}`)}
        tabs={[
          { id: 'first', label: firstLabel, closeLabel: `Close ${firstLabel}`, dirtyLabel: 'Unsaved changes' },
          { id: 'second', label: 'Second.pptx', closeLabel: 'Close Second.pptx' },
        ]}
        testIdPrefix="office"
      />
    )
    try {
      await act(async () => root.render(render('first')))
      const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
      expect(tabs[0]!.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull()
      expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Documents')
      await act(async () => tabs[1]!.click())
      expect(calls).toEqual(['select:second'])
      await act(async () => host.querySelectorAll<HTMLButtonElement>('[data-testid="office-close-document"]')[0]!.click())
      expect(calls).toEqual(['select:second', 'close:first'])
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="office-new-document"]')!.click())
      expect(calls).toEqual(['select:second', 'close:first', 'create'])

      await act(async () => root.render(render('second', true, 'Renamed.pptx')))
      expect(tabs[0]!.textContent).toContain('Renamed.pptx')
      expect(tabs[0]!.getAttribute('aria-selected')).toBe('false')
      expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
      expect(host.querySelector('[aria-label="Close Renamed.pptx"]')).not.toBeNull()
      expect(host.querySelector('[role="alert"]')?.textContent).toBe('Save failed')
      expect(host.querySelector('[data-testid="custom-new-icon"]')).not.toBeNull()
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="office-new-document"]')!.click())
      expect(calls).toEqual(['select:second', 'close:first', 'create'])
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('preserves immediate presentation tooltips for the shared panel controls and document tabs', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const tooltipOptions = { appearance: 'presentation' as const, delayMs: 0 }
    try {
      await act(async () => root.render(<>
        <OfficePanelControls closeLabel="Close panel" expanded={false} expandLabel="Expand panel" onToggleExpanded={() => undefined} testIdPrefix="office" tooltipOptions={tooltipOptions} />
        <OfficeDocumentTabs activeId="first" icon={<span>Doc</span>} label="Documents" newLabel="New document" onClose={() => undefined} onCreate={() => undefined} onSelect={() => undefined} tabs={[{ id: 'first', label: 'First.pptx', closeLabel: 'Close First.pptx' }]} testIdPrefix="office" tooltipOptions={tooltipOptions} />
      </>))
      for (const [testId, text] of [
        ['office-toggle-expanded', 'Expand panel'],
        ['office-document-tab', 'First.pptx'],
        ['office-close-document', 'Close First.pptx'],
        ['office-new-document', 'New document'],
      ]) {
        const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!
        await act(async () => button.focus())
        const tooltip = document.querySelector('[role="tooltip"]')
        expect(tooltip?.textContent).toBe(text)
        expect(tooltip?.className).toContain('bg-bg-elevated')
        await act(async () => button.blur())
        expect(document.querySelector('[role="tooltip"]')).toBeNull()
      }
    } finally {
      await act(async () => root.unmount())
    }
  })
})
