/**
 * Mermaid diagram rendering: lazy-load mermaid (it is large, ~500KB) + error fallback + click to zoom/download.
 *
 * Invariants:
 *  - mermaid is lazy-loaded through a dynamic import and only fetched once a mermaid code block actually appears on the page.
 *  - when rendering fails (the code is not yet complete mid-stream / a syntax error) it falls back to
 *    showing the raw code instead of throwing; once the code is closed or corrected it re-renders successfully.
 *  - securityLevel='strict': script/click injection inside the diagram is forbidden, guarding against malicious content in LLM output.
 *  - the diagram is always rendered with the light theme (treated as documentation artwork, it does not follow the app's dark/light theme) inside a white card container.
 *  - once rendered, its inline height is capped (so a long flowchart cannot blow up the message
 *    column); clicking serialises the page's live `<svg>` and rasterises it with the browser's native
 *    rendering into a high-resolution PNG (preserving the colours/fonts from mermaid's inlined
 *    `<style>`), reusing the image viewer (zoom/pan/download/fullscreen).
 *
 * Dependencies: `openImageAtom` reuses ImageLightbox; `useId` generates a stable, unique render id
 *  (mermaid.render requires an id without colons, so the colons from useId are stripped).
 */
import { useEffect, useId, useRef, useState } from 'react'
import { useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { openImageAtom } from '@/atoms/lightbox'
import { Tooltip } from '@/components/amphi/Tooltip'
import { normalizeBreakTags } from '@/lib/mermaidCode'
import { rlog } from '@/lib/logger'

export interface MermaidBlockProps {
  /** The mermaid diagram source. */
  code: string
  /** Active block during streaming: show the raw source first and do not render the diagram yet, waiting
   *  until the block closes (defer→false) before rendering. Rendering once instead of many times avoids
   *  flicker — otherwise the source is incomplete mid-stream and every token's render attempt fails to
   *  parse and falls back again, producing a jitter. */
  defer?: boolean
}

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null

/** Lazily load and cache mermaid's default export. */
function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

/** Clone the live `<svg>`, **normalise its long edge to a common target (~2400px)**, drop the root
 *  node's max-width, and serialise it into an SVG blob URL. Returns the url plus the target pixel size.
 *
 *  Why normalise the long edge: different diagrams have different viewBox sizes, so exporting at a
 *  fixed multiplier makes small diagrams produce small PNGs and large ones large PNGs; inside the
 *  lightbox (bounded by maxZoomPixelRatio) the small ones would not fill the frame while the large
 *  ones would → inconsistent open sizes within one session. After normalising, every diagram is
 *  ≥ the viewport → all of them display "fit", with a consistent open size. Rasterising the vector
 *  at the target pixel size keeps it sharp. */
function sizedSvgBlobUrl(svgEl: SVGSVGElement): { url: string; w: number; h: number } {
  const vb = svgEl.viewBox.baseVal
  const rect = svgEl.getBoundingClientRect()
  const baseW = Math.ceil(vb && vb.width ? vb.width : rect.width) || 800
  const baseH = Math.ceil(vb && vb.height ? vb.height : rect.height) || 600
  const longEdge = Math.max(baseW, baseH)
  // Long edge → [2400, 8000]: small diagrams are scaled up to 2400, large ones kept, oversized ones capped at 8000.
  const scale = Math.min(8000 / longEdge, Math.max(1, 2400 / longEdge))
  const w = Math.round(baseW * scale)
  const h = Math.round(baseH * scale)
  const clone = svgEl.cloneNode(true) as SVGSVGElement
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))
  clone.style.maxWidth = 'none'
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' }),
  )
  return { url, w, h }
}

/** Rasterise the **already rendered** mermaid `<svg>` on the page into a high-resolution PNG and return a blob: URL.
 *
 *  Use the live DOM rather than the string mermaid emitted: the browser has already parsed it into the
 *  DOM, so `XMLSerializer` necessarily produces **valid XML** (sidestepping the `<img>` decode failure
 *  caused by "quasi-HTML that is invalid XML"); then **the browser's own SVG rendering** (the blob
 *  drawn onto a canvas as an `<img>`) applies mermaid's inlined `<style>` CSS + fonts in full, so
 *  colours/fonts match the page (canvg cannot do this). `htmlLabels:false` guarantees no
 *  foreignObject → the canvas is not tainted and `toBlob` works. */
async function svgElementToPngBlobUrl(svgEl: SVGSVGElement, background: string): Promise<string> {
  const { url: svgUrl, w, h } = sizedSvgBlobUrl(svgEl)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('svg decode failed'))
      img.src = svgUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('no 2d context')
    ctx.fillStyle = background
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (png === null) throw new Error('toBlob failed')
    return URL.createObjectURL(png)
  } finally {
    URL.revokeObjectURL(svgUrl) // temporary SVG blob; the PNG blob is reclaimed when the lightbox closes
  }
}

export function MermaidBlock({ code, defer = false }: MermaidBlockProps) {
  const { t } = useTranslation()
  const openImage = useSetAtom(openImageAtom)
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const renderId = `mermaid-${useId().replace(/:/g, '')}`
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // Active block during streaming: do not render the diagram, the fallback branch shows the raw source
    // (svg starts as null and failed is false; defer only ever flips true→false monotonically, so no
    // reset is needed); once closed, defer→false re-runs this effect and produces the diagram.
    if (defer) return
    let cancelled = false
    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          // The diagram always uses the light theme (treated as documentation artwork, not following the app's
          // dark/light theme): under the dark theme a dark-background mermaid diagram melts into the black
          // background and looks strange. A fixed light theme + white card container reads clearly in both themes.
          theme: 'default',
          securityLevel: 'strict',
          // On a parse failure, do not let mermaid inject its "Parse error…" error diagram into <body> — that
          // leftover node shows up in the UI and breaks the layout. Throw instead and let the catch below fall
          // back to the raw source.
          suppressErrorRendering: true,
          // Use SVG <text> elements rather than foreignObject HTML: the latter makes "click to export PNG" fail
          // to decode the SVG when loaded as an `<img>` / taint the canvas after drawImage (toDataURL throws
          // SecurityError). Only a purely self-contained SVG rasterises and scales reliably.
          flowchart: { htmlLabels: false },
          class: { htmlLabels: false },
        })
        // Normalise <br/>→<br>: timeline's wrap2 only recognises the slash-less <br>, otherwise it shows literally and overflows. See mermaidCode.ts.
        const { svg: out } = await mermaid.render(renderId, normalizeBreakTags(code))
        if (!cancelled) {
          setSvg(out)
          setFailed(false)
        }
      })
      .catch((err: unknown) => {
        // Incomplete stream / syntax error → fall back to the raw source, not treated as fatal.
        rlog.warn('[markdown/mermaid] render failed', err)
        if (!cancelled) {
          setSvg(null)
          setFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [code, renderId, defer])

  // Click → take the page's live `<svg>`, rasterise it natively into a high-resolution PNG (blob URL)
  // and reuse the image viewer (zoom/pan/download/fullscreen). Going through the live DOM + native
  // rendering preserves mermaid's colours/fonts.
  // If PNG rasterisation (canvas) fails, fall back to viewing the serialised SVG directly (valid XML,
  // vector, correct colours).
  const openInLightbox = (): void => {
    const svgEl = containerRef.current?.querySelector('svg')
    if (!(svgEl instanceof SVGSVGElement)) return
    // The diagram is fixed light, so the exported PNG gets a fixed white background, matching the inline white card.
    void svgElementToPngBlobUrl(svgEl, '#ffffff')
      .then((url) => openImage({ src: url, download: 'diagram.png' }))
      .catch((err: unknown) => {
        rlog.warn('[markdown/mermaid] PNG export failed, fall back to SVG', err)
        // The fallback also uses sizedSvgBlobUrl (hard-coded to the same target size) to keep the open size consistent with the PNG path.
        openImage({ src: sizedSvgBlobUrl(svgEl).url, download: 'diagram.svg' })
      })
  }

  if (failed || svg === null) {
    return (
      <pre className="my-2 p-3 rounded-md overflow-x-auto text-sm bg-bg-hover border border-border-subtle">
        <code className="font-mono">{code}</code>
      </pre>
    )
  }
  return (
    <Tooltip content={t('markdown.mermaid.zoomHint')}>
      <div
        ref={containerRef}
        role="button"
        tabIndex={0}
        onClick={openInLightbox}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openInLightbox()
          }
        }}
        // White card (fixed light, not a theme-reactive token): the diagram always renders light, so under a
        // dark UI the white background + thin border separate it from the surroundings instead of melting
        // into black. The 420px inline height cap keeps a long flowchart from blowing up the message column.
        className="my-2 flex justify-center cursor-zoom-in rounded-md bg-white p-3 border border-black/10 [&>svg]:max-h-[420px] [&>svg]:h-auto [&>svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </Tooltip>
  )
}
