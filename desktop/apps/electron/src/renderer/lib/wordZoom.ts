import type { WordPageSettings } from './wordDomain'

const PAGE_SIZE = {
  a4: { height: 1124, width: 794 },
  letter: { height: 1056, width: 816 },
} as const

const UNIVER_PAGE_MARGIN_WIDTH = 40
const MIN_CANVAS_GUTTER = 96
const CANVAS_GUTTER_RATIO = 0.14
const FIT_ZOOM_STEP = 5

export function getWordPageWidth(page: WordPageSettings): number {
  const dimensions = PAGE_SIZE[page.size]
  return page.orientation === 'landscape' ? dimensions.height : dimensions.width
}

/** Calculate a readable page-width zoom while retaining space around the sheet. */
export function calculateWordFitZoom(containerWidth: number, page: WordPageSettings): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 100

  const pageWidth = getWordPageWidth(page)
  const canvasGutter = Math.max(MIN_CANVAS_GUTTER, containerWidth * CANVAS_GUTTER_RATIO)
  const availableWidth = Math.max(0, containerWidth - canvasGutter)
  const rawZoom = (availableWidth / (pageWidth + UNIVER_PAGE_MARGIN_WIDTH)) * 100
  const steppedZoom = Math.floor(rawZoom / FIT_ZOOM_STEP) * FIT_ZOOM_STEP

  return Math.max(50, Math.min(100, steppedZoom))
}
