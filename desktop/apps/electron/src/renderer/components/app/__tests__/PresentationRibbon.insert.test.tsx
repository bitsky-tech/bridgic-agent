import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createBlankPresentationSlide } = await import('@/atoms/presentation')
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

describe('PresentationRibbon', () => {
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
          animationMarkersHidden={false}
          animationPaneOpen={false}
          canvasScale={0.5}
          compact={false}
          currentSlide={undefined}
          filmstripCollapsed={false}
          historyStatus={{ canUndo: false, canRedo: false }}
          inspectorOpen={false}
          commentsOpen={false}
          layersOpen={false}
          pageSizePreset="wide"
          ribbonCollapsed={false}
          selectedElement={null}
          selectedText={null}
          viewOptions={{ gridlines: false, guides: false, notes: true, ruler: false, smartSnap: true }}
          onActiveTabChange={() => undefined}
          onAddShape={() => undefined}
          onAddSlide={() => undefined}
          onAddText={() => undefined}
          onAlignElement={() => undefined}
          onApplyAnimationToAll={() => undefined}
          onApplyLayout={() => undefined}
          onApplyTheme={() => undefined}
          onApplyTransitionToAll={() => undefined}
          onApplyFormat={() => undefined}
          onCanvasScaleChange={() => undefined}
          onToggleComments={() => undefined}
          onFitCanvas={() => undefined}
          onEditMaster={() => undefined}
          onInsertAudio={() => calls.push('audio')}
          onInsertChart={() => calls.push('chart')}
          onInsertFooter={() => calls.push('footer')}
          onInsertImage={() => calls.push('image')}
          onInsertLink={() => calls.push('link')}
          onInsertTable={() => calls.push('table')}
          onInsertVideo={() => calls.push('video')}
          onMoveElement={() => undefined}
          onPageSizeChange={() => undefined}
          onPreviewAnimation={() => undefined}
          onPreviewTransition={() => undefined}
          onRedo={() => undefined}
          onSlideChange={() => undefined}
          onStartSlideshow={() => undefined}
          onStartSlideshowFromBeginning={() => undefined}
          onToggleAnimationMarkers={() => undefined}
          onToggleAnimationPane={() => undefined}
          onToggleFilmstrip={() => undefined}
          onToggleGroup={() => undefined}
          onToggleInspector={() => undefined}
          onToggleLayers={() => undefined}
          onToggleRibbon={() => undefined}
          onUndo={() => undefined}
          onUpdateElement={() => undefined}
          onViewOptionsChange={() => undefined}
        />,
      )
    })

    for (const kind of ['image', 'audio', 'video', 'table', 'link', 'chart', 'footer']) {
      await act(async () => host.querySelector<HTMLButtonElement>(`[data-testid="presentation-insert-${kind}"]`)!.click())
    }
    expect(calls).toEqual(['image', 'audio', 'video', 'table', 'link', 'chart', 'footer'])
  })

  it('previews an animation immediately after applying it', async () => {
    const updates: unknown[] = []
    const previews: unknown[] = []
    const selectedElement = {
      id: 'animated-text',
      type: 'text' as const,
      x: 80,
      y: 80,
      width: 400,
      height: 80,
      rotation: 0,
      text: 'Animate me',
      fontSize: 32,
      fontFamily: 'Aptos',
      fontWeight: 600 as const,
      color: '#20202B',
      align: 'left' as const,
    }
    const groupedShape = {
      id: 'animated-shape',
      type: 'rect' as const,
      x: 60,
      y: 60,
      width: 500,
      height: 120,
      rotation: 0,
      fill: '#FFFFFF',
      borderColor: '#20202B',
      borderWidth: 1,
    }
    const currentSlide = { ...createBlankPresentationSlide('Animation'), elements: [groupedShape, selectedElement] }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    activeRoot = root
    await act(async () => {
      root.render(
        <PresentationRibbon
          activeTab="animations"
          animationMarkersHidden={false}
          animationPaneOpen={false}
          animationTargetElements={[groupedShape, selectedElement]}
          canvasScale={0.5}
          compact={false}
          currentSlide={currentSlide}
          filmstripCollapsed={false}
          historyStatus={{ canUndo: false, canRedo: false }}
          inspectorOpen={false}
          commentsOpen={false}
          layersOpen={false}
          pageSizePreset="wide"
          ribbonCollapsed={false}
          selectedElement={selectedElement}
          selectedText={selectedElement}
          viewOptions={{ gridlines: false, guides: false, notes: true, ruler: false, smartSnap: true }}
          onActiveTabChange={() => undefined}
          onAddShape={() => undefined}
          onAddSlide={() => undefined}
          onAddText={() => undefined}
          onAlignElement={() => undefined}
          onApplyAnimationToAll={() => undefined}
          onApplyLayout={() => undefined}
          onApplyTheme={() => undefined}
          onApplyTransitionToAll={() => undefined}
          onApplyFormat={() => undefined}
          onCanvasScaleChange={() => undefined}
          onToggleComments={() => undefined}
          onFitCanvas={() => undefined}
          onEditMaster={() => undefined}
          onInsertAudio={() => undefined}
          onInsertChart={() => undefined}
          onInsertFooter={() => undefined}
          onInsertImage={() => undefined}
          onInsertLink={() => undefined}
          onInsertTable={() => undefined}
          onInsertVideo={() => undefined}
          onMoveElement={() => undefined}
          onPageSizeChange={() => undefined}
          onPreviewAnimation={(patch) => previews.push(patch)}
          onPreviewTransition={() => undefined}
          onRedo={() => undefined}
          onSlideChange={() => undefined}
          onStartSlideshow={() => undefined}
          onStartSlideshowFromBeginning={() => undefined}
          onToggleAnimationMarkers={() => undefined}
          onToggleAnimationPane={() => undefined}
          onToggleFilmstrip={() => undefined}
          onToggleGroup={() => undefined}
          onToggleInspector={() => undefined}
          onToggleLayers={() => undefined}
          onToggleRibbon={() => undefined}
          onUndo={() => undefined}
          onUpdateElement={(patch) => updates.push(patch)}
          onViewOptionsChange={() => undefined}
        />,
      )
    })

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-fade"]')!.click())
    expect(updates.at(-1)).toEqual({ animation: 'fade' })
    expect(previews.at(-1)).toEqual({ animation: 'fade' })
    expect(host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-fillColor"]')?.disabled).toBe(false)
    expect(host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-textColor"]')?.disabled).toBe(false)
  })
})
