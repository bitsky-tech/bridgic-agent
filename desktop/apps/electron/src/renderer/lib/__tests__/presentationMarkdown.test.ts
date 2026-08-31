import { describe, expect, it } from 'bun:test'
import { createBlankPresentationDocument } from '@/atoms/presentation'
import {
  compilePresentationMarkdown,
  decompilePresentationSlideMarkdown,
  inspectPresentationMarkdownAssets,
} from '../presentationMarkdown'

describe('presentation Markdown compiler', () => {
  it('compiles Slidev framing, YAML, Markdown blocks, slots, tables, and notes', () => {
    const markdown = `---
title: Product review
pageSize: wide
id: cover
name: Cover
layout: title
---

# Product review {#title}

One native presentation model.

---
id: metrics
name: Metrics
layout: two-cols
---

::left::

- ARR grew 42%
- NRR reached 118%

::right::

| Quarter | ARR |
| --- | ---: |
| Q3 | 25 |

<!-- notes
Pause on retention.
-->`
    const compiled = compilePresentationMarkdown(markdown).document

    expect(compiled.title).toBe('Product review')
    expect(compiled.slides.map((slide) => slide.id)).toEqual(['cover', 'metrics'])
    expect(compiled.slides[0]!.elements[0]).toMatchObject({ id: 'title', type: 'text', text: 'Product review' })
    expect(compiled.slides[1]!.layout).toBe('twoContent')
    expect(compiled.slides[1]!.elements.map((element) => element.type)).toEqual(['text', 'table'])
    expect(compiled.slides[1]!.elements[0]!.x).toBeLessThan(compiled.pageSize.width / 2)
    expect(compiled.slides[1]!.elements[1]!.x).toBeGreaterThan(compiled.pageSize.width / 2)
    expect(compiled.slides[1]!.notes).toBe('Pause on retention.')
  })

  it('does not split slides on delimiters inside YAML literals, fences, comments, or native components', () => {
    const markdown = `---
title: |-
  A title
  ---
id: one
---

\`\`\`md
---
<PptImage id="example" src="not-an-asset.png" />
\`\`\`

<!--
---
-->

<PptText id="rule" x="20" y="20" width="200" height="60">
---
</PptText>`
    const compiled = compilePresentationMarkdown(markdown).document

    expect(compiled.slides).toHaveLength(1)
    expect(compiled.slides[0]!.elements).toHaveLength(2)
    expect(compiled.slides[0]!.elements[0]).toHaveProperty('text', '---\n<PptImage id="example" src="not-an-asset.png" />')
    expect(compiled.slides[0]!.elements[1]).toMatchObject({ id: 'rule', text: '---' })
    expect(inspectPresentationMarkdownAssets(markdown)).toEqual([])
  })

  it('honors fence length and multiline self-closing components while framing slides', () => {
    const fenced = `---
id: fenced
---

~~~~md
---
~~~
---
~~~~`
    const fencedDocument = compilePresentationMarkdown(fenced).document
    expect(fencedDocument.slides).toHaveLength(1)
    expect(fencedDocument.slides[0]!.elements[0]).toHaveProperty('text', '---\n~~~\n---')

    const multilineComponent = `---
id: first
---

<PptShape
  id="shape"
  kind="rect"
/>

---
id: second
---

# Second`
    const componentDocument = compilePresentationMarkdown(multilineComponent).document
    expect(componentDocument.slides.map((slide) => slide.id)).toEqual(['first', 'second'])
    expect(componentDocument.slides[0]!.elements[0]).toMatchObject({ id: 'shape', type: 'rect' })
  })

  it('compiles adjacent native components emitted in one HTML token', () => {
    const markdown = `---
id: adjacent
---

<PptShape id="panel" kind="rect" x="20" y="20" width="300" height="160" />
<PptText id="label" x="40" y="50" width="260" height="80">Summary</PptText>`

    const document = compilePresentationMarkdown(markdown).document
    expect(document.slides[0]!.elements).toHaveLength(2)
    expect(document.slides[0]!.elements.map((element) => element.id)).toEqual(['panel', 'label'])
  })

  it('round-trips every native element family through canonical Markdown without base64', () => {
    const existing = createBlankPresentationDocument('Imported deck')
    const slide = existing.slides[0]!
    slide.id = 'imported'
    slide.name = 'Imported'
    existing.selectedSlideId = slide.id
    slide.notes = 'Speaker note'
    slide.elements = [
      {
        id: 'text',
        type: 'text',
        text: '  Revenue & </PptText>  ',
        x: 20,
        y: 20,
        width: 300,
        height: 80,
        rotation: 4,
        flipHorizontal: true,
        fontSize: 30,
        fontFamily: 'Inter',
        fontWeight: 700,
        color: '#112233',
        align: 'center',
        textDirection: 'eastAsianVertical',
        animation: 'fade',
        animationStart: 'afterPrevious',
      },
      {
        id: 'shape',
        type: 'roundRect',
        x: 30,
        y: 120,
        width: 220,
        height: 100,
        rotation: 0,
        fill: '#FF0000',
        borderColor: '#000000',
        borderWidth: 2,
      },
      {
        id: 'image',
        type: 'image',
        source: { dataUrl: 'data:image/png;base64,aW1hZ2U=', fileName: 'image.png', mimeType: 'image/png' },
        altText: 'Hero',
        fit: 'cover',
        clipShape: 'ellipse',
        x: 280,
        y: 120,
        width: 300,
        height: 180,
        rotation: 0,
        flipVertical: true,
      },
      {
        id: 'audio',
        type: 'audio',
        source: { dataUrl: 'data:audio/mpeg;base64,YXVkaW8=', fileName: 'audio.mp3', mimeType: 'audio/mpeg' },
        autoplay: false,
        loop: true,
        muted: false,
        x: 20,
        y: 320,
        width: 240,
        height: 80,
        rotation: 0,
      },
      {
        id: 'video',
        type: 'video',
        source: { dataUrl: 'data:video/mp4;base64,dmlkZW8=', fileName: 'video.mp4', mimeType: 'video/mp4' },
        autoplay: false,
        loop: false,
        muted: true,
        x: 280,
        y: 320,
        width: 300,
        height: 180,
        rotation: 0,
      },
      {
        id: 'table',
        type: 'table',
        cells: [['Name', 'Value'], ['A|B', 'Line 1\nLine 2']],
        headerRow: true,
        headerFill: '#EEEEEE',
        bodyFill: '#FFFFFF',
        textColor: '#111111',
        borderColor: '#999999',
        fontSize: 18,
        x: 610,
        y: 20,
        width: 400,
        height: 180,
        rotation: 0,
      },
      {
        id: 'chart',
        type: 'chart',
        chartType: 'line',
        categories: ['Q1', 'Q2'],
        series: [{ name: 'ARR', values: [12, 18] }],
        showLegend: true,
        colors: ['#5B67F1'],
        x: 610,
        y: 230,
        width: 500,
        height: 300,
        rotation: 0,
      },
    ]

    const markdown = decompilePresentationSlideMarkdown(slide)
    expect(markdown).toContain('<PptText')
    expect(markdown).toContain('<PptChart')
    expect(markdown).toContain('src="@existing/image"')
    expect(markdown).toContain('clipShape="ellipse"')
    expect(markdown).not.toContain('base64')

    const roundTripped = compilePresentationMarkdown(markdown, { existingDocument: existing }).document
    expect(roundTripped.slides[0]!.elements.map((element) => element.type)).toEqual(
      existing.slides[0]!.elements.map((element) => element.type),
    )
    expect(roundTripped.slides[0]!.elements[0]).toMatchObject({
      id: 'text',
      text: '  Revenue & </PptText>  ',
      animation: 'fade',
      animationStart: 'afterPrevious',
      flipHorizontal: true,
      textDirection: 'eastAsianVertical',
    })
    expect(roundTripped.slides[0]!.elements[2]).toMatchObject({ id: 'image', flipVertical: true, clipShape: 'ellipse' })
    expect(roundTripped.slides[0]!.elements[5]).toMatchObject({
      id: 'table',
      cells: [['Name', 'Value'], ['A|B', 'Line 1\nLine 2']],
    })
    expect(roundTripped.slides[0]!.elements[6]).toMatchObject({
      id: 'chart',
      categories: ['Q1', 'Q2'],
      series: [{ name: 'ARR', values: [12, 18] }],
    })
  })

  it('uses one parser for local asset discovery and compilation', () => {
    const markdown = `---
id: media
---

![Hero](assets/hero.png)

<PptAudio id="voice" src="media/voice.mp3" />`
    const textWithImageSyntax = [markdown, '<PptText id="literal">![Not media](ignored.png)</PptText>'].join('\n\n')
    expect(inspectPresentationMarkdownAssets(textWithImageSyntax)).toEqual(['assets/hero.png', 'media/voice.mp3'])
    expect(() => compilePresentationMarkdown(markdown)).toThrow('asset was not registered')

    const document = compilePresentationMarkdown(markdown, {
      assets: {
        'assets/hero.png': {
          assetId: 'asset-image',
          dataUrl: 'bridgic-resource://hero',
          fileName: 'hero.png',
          mimeType: 'image/png',
          path: 'assets/hero.png',
        },
        'media/voice.mp3': {
          assetId: 'asset-audio',
          dataUrl: 'bridgic-resource://voice',
          fileName: 'voice.mp3',
          mimeType: 'audio/mpeg',
          path: 'media/voice.mp3',
        },
      },
    }).document
    expect(document.slides[0]!.elements.map((element) => element.type)).toEqual(['image', 'audio'])
  })

  it('rejects duplicate refs, unknown component attributes, and arbitrary executable Vue', () => {
    expect(() => compilePresentationMarkdown(`---
id: duplicate
---

# One {#same}

# Two {#same}`)).toThrow('Duplicate element id')
    expect(() => compilePresentationMarkdown(`---
id: typo
---

<PptText id="title" widht="100">Title</PptText>`)).toThrow('Unsupported PptText attribute: widht')
    expect(() => compilePresentationMarkdown(`---
id: unsafe
---

<Counter :start="1" />`)).toThrow('Unsupported HTML or Vue block')
  })

  it('accepts style blocks as inert input and reports that they were not executed', () => {
    const compiled = compilePresentationMarkdown(`---
id: styled
---

<style>
.title { color: red; }
</style>

# Native title`)
    expect(compiled.document.slides[0]!.elements).toHaveLength(1)
    expect(compiled.diagnostics[0]).toContain('accepted but ignored')
  })
})
