import { dump } from 'js-yaml'
import type { PresentationProject, PresentationElement, PresentationSlide } from '@/atoms/presentation'
import { presentationElementSource } from '@/presentation/project'

/** Produce a compact, read-only Agent projection of one native slide. */
export function decompilePresentationSlideMarkdown(
  slide: PresentationSlide,
  project?: Pick<PresentationProject, 'assets'>,
): string {
  const frontmatter: Record<string, unknown> = {
    id: slide.id,
    name: slide.name,
    ...(slide.layout && slide.layout !== 'blank' ? { layout: slide.layout } : {}),
    ...(slide.background === undefined ? {} : { background: slide.background }),
    ...(slide.transition.effect === 'none' ? {} : { transition: slide.transition }),
    ...(slide.footer ? { footer: slide.footer } : {}),
    ...(slide.comments?.length ? { comments: slide.comments } : {}),
  }
  const yaml = dump(frontmatter, { lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd()
  const body = slide.elements.map((element) => decompileElement(element, project)).join('\n\n')
  const notes = slide.notes?.trim() ? `\n\n<!-- notes\n${slide.notes.trim()}\n-->` : ''
  return `---\n${yaml}\n---\n\n${body}${notes}`.trimEnd()
}

function decompileElement(element: PresentationElement, project?: Pick<PresentationProject, 'assets'>): string {
  const common: Record<string, unknown> = {
    ref: element.id,
    ...(element.animation ? {
      animation: element.animation,
      ...(element.animationDuration === undefined ? {} : { animationDuration: element.animationDuration }),
      ...(element.animationDelay === undefined ? {} : { animationDelay: element.animationDelay }),
      ...(element.animationStart === undefined ? {} : { animationStart: element.animationStart }),
      ...(element.animationTrigger === undefined ? {} : { animationTrigger: element.animationTrigger }),
      ...(element.animationColor === undefined ? {} : { animationColor: element.animationColor }),
    } : {}),
    ...(element.hyperlink?.type === 'url' ? { href: element.hyperlink.url } : {}),
    ...(element.hyperlink?.type === 'slide' ? { slideHref: element.hyperlink.slideId } : {}),
    ...(element.hyperlink?.tooltip ? { tooltip: element.hyperlink.tooltip } : {}),
  }
  if (element.type === 'text') {
    const source = element.sourceAssetId
      ? presentationElementSource(project ?? { assets: [] }, element as typeof element & { sourceAssetId: string })
      : undefined
    if (element.sourceAssetId && !source) throw new Error(`PowerPoint text element has no source asset: ${element.id}`)
    return component('PptText', {
      ...common,
      ...(source ? { src: source.path ?? `@existing/${element.id}` } : {}),
      ...(element.textDirection === undefined ? {} : { textDirection: element.textDirection }),
    }, escapeText(element.text))
  }
  if (element.type === 'image') {
    const source = presentationElementSource(project ?? { assets: [] }, element)
    if (!source) throw new Error(`PowerPoint image element has no source asset: ${element.id}`)
    return component('PptImage', {
      ...common,
      src: source.path ?? `@existing/${element.id}`,
      alt: element.altText,
      fit: element.fit,
      ...(element.clipShape ? { clipShape: element.clipShape } : {}),
    })
  }
  if (element.type === 'audio' || element.type === 'video') {
    const source = presentationElementSource(project ?? { assets: [] }, element)
    if (!source) throw new Error(`PowerPoint media element has no source asset: ${element.id}`)
    return component(element.type === 'audio' ? 'PptAudio' : 'PptVideo', {
      ...common,
      src: source.path ?? `@existing/${element.id}`,
      ...(element.autoplay ? { autoplay: true } : {}),
      ...(element.loop ? { loop: true } : {}),
      ...(element.muted ? { muted: true } : {}),
    })
  }
  if (element.type === 'table') {
    return component('PptTable', {
      ...common,
      ...(element.headerRow ? {} : { headerRow: false }),
      ...(element.headerTextColor === undefined ? {} : { headerTextColor: element.headerTextColor }),
    }, markdownTable(element.cells))
  }
  if (element.type === 'chart') {
    return component('PptChart', {
      ...common,
      type: element.chartType,
      ...(element.showLegend ? {} : { showLegend: false }),
      ...(element.showValue ? { showValue: true } : {}),
      ...(element.displayBlanksAs === undefined ? {} : { displayBlanksAs: element.displayBlanksAs }),
      ...(element.holeSize === undefined ? {} : { holeSize: element.holeSize }),
      ...(element.title === undefined ? {} : { title: element.title }),
    }, dump({ categories: element.categories, series: element.series }, { lineWidth: -1, noRefs: true }).trimEnd())
  }
  return component('PptShape', {
    ...common,
    kind: element.type,
    ...(element.connectorPath === undefined ? {} : { connectorPath: element.connectorPath }),
  })
}

function component(name: string, attrs: Record<string, unknown>, body?: string): string {
  const renderedAttrs = Object.entries(attrs).map(([key, value]) => `${key}="${escapeAttr(String(value))}"`).join(' ')
  return body === undefined
    ? `<${name} ${renderedAttrs} />`
    : `<${name} ${renderedAttrs}>\n${body}\n</${name}>`
}

function markdownTable(cells: string[][]): string {
  const width = Math.max(1, ...cells.map((row) => row.length))
  const rows = cells.length ? cells : [['']]
  const renderRow = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => (
    (row[index] ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '<br>')
  )).join(' | ')} |`
  return [renderRow(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(renderRow)].join('\n')
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;')
}
