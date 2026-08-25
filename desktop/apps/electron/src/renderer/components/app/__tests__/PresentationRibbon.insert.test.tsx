import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { i18n } = await import('@/lib/i18n')
const { PresentationRibbon } = await import('../PresentationRibbon')
let activeRoot: Root | null = null

beforeEach(async () => {
  await i18n.changeLanguage('en')
})

afterEach(async () => {
  if (activeRoot) {
    await act(async () => activeRoot?.unmount())
    activeRoot = null
  }
  document.body.replaceChildren()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('PresentationRibbon insert actions', () => {
  it('routes every Insert content action to its real callback', async () => {
    const calls: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    activeRoot = root
    await act(async () => {
      root.render(
        <PresentationRibbon
          activeTab="insert"
          animationPaneOpen={false}
          compact={false}
          currentSlide={undefined}
          filmstripCollapsed={false}
          historyStatus={{ canUndo: false, canRedo: false }}
          inspectorOpen={false}
          selectedElement={null}
          selectedText={null}
          toolbarActions={null}
          onActiveTabChange={() => undefined}
          onAddShape={() => undefined}
          onAddSlide={() => undefined}
          onAddText={() => undefined}
          onApplyTransitionToAll={() => undefined}
          onApplyFormat={() => undefined}
          onFindText={() => undefined}
          onInsertAudio={() => calls.push('audio')}
          onInsertChart={() => calls.push('chart')}
          onInsertFooter={() => calls.push('footer')}
          onInsertImage={() => calls.push('image')}
          onInsertLink={() => calls.push('link')}
          onInsertTable={() => calls.push('table')}
          onInsertVideo={() => calls.push('video')}
          onMoveElement={() => undefined}
          onPreviewAnimation={() => undefined}
          onPreviewTransition={() => undefined}
          onRedo={() => undefined}
          onSlideChange={() => undefined}
          onStartSlideshow={() => undefined}
          onStartSlideshowFromBeginning={() => undefined}
          onToggleAnimationPane={() => undefined}
          onToggleFilmstrip={() => undefined}
          onToggleInspector={() => undefined}
          onUndo={() => undefined}
          onUpdateElement={() => undefined}
        />,
      )
    })

    for (const kind of ['image', 'audio', 'video', 'table', 'link', 'chart', 'footer']) {
      await act(async () => host.querySelector<HTMLButtonElement>(`[data-testid="presentation-insert-${kind}"]`)!.click())
    }
    expect(calls).toEqual(['image', 'audio', 'video', 'table', 'link', 'chart', 'footer'])
  })
})
