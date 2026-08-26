import { describe, expect, it } from 'bun:test'
import type {
  PresentationFileSource,
  PresentationShapeElement,
  PresentationTextElement,
} from '@/atoms/presentation'
import {
  createPresentationChartElement,
  createPresentationFooter,
  createPresentationImageElement,
  createPresentationMediaElement,
  createPresentationTableElement,
  createPresentationUrlHyperlink,
  hasValidPresentationMediaSignature,
  isPresentationChartElement,
  isPresentationImageElement,
  isPresentationMediaElement,
  isPresentationShapeElement,
  isPresentationTableElement,
  isPresentationTextElement,
  isPresentationVideoElement,
  normalizePresentationFileSource,
  normalizePresentationHyperlinkUrl,
  parsePresentationDelimitedText,
  supportsPresentationElementHyperlink,
  supportsPresentationElementRotation,
  supportsPresentationElementShadow,
} from '../presentationInsert'

const imageSource: PresentationFileSource = {
  dataUrl: 'data:image/png;base64,aW1hZ2U=',
  fileName: 'image.png',
  mimeType: 'image/png',
}

describe('presentation insert helpers', () => {
  it('normalizes supported file MIME types and data URL headers', () => {
    expect(normalizePresentationFileSource('image', {
      dataUrl: 'data:IMAGE/PNG;base64,aW1hZ2U=',
      fileName: 'image.bin',
      mimeType: ' IMAGE/PNG ',
    })).toEqual({
      dataUrl: 'data:image/png;base64,aW1hZ2U=',
      fileName: 'image.bin',
      mimeType: 'image/png',
    })
    expect(normalizePresentationFileSource('audio', {
      dataUrl: 'data:application/octet-stream;base64,YXVkaW8=',
      fileName: 'track.M4A',
      mimeType: '',
    })).toEqual({
      dataUrl: 'data:audio/mp4;base64,YXVkaW8=',
      fileName: 'track.M4A',
      mimeType: 'audio/mp4',
    })
    expect(normalizePresentationFileSource('video', {
      dataUrl: 'data:;base64,dmlkZW8=',
      fileName: 'clip.MOV',
      mimeType: 'application/octet-stream',
    })).toEqual({
      dataUrl: 'data:video/quicktime;base64,dmlkZW8=',
      fileName: 'clip.MOV',
      mimeType: 'video/quicktime',
    })
  })

  it('normalizes multi-megabyte MP3 payloads without a recursive regular expression', () => {
    const payload = 'A'.repeat(5 * 1024 * 1024)
    expect(normalizePresentationFileSource('audio', {
      dataUrl: `data:audio/mpeg;base64,${payload}`,
      fileName: 'long-track.mp3',
      mimeType: 'audio/mpeg',
    })).toEqual({
      dataUrl: `data:audio/mpeg;base64,${payload}`,
      fileName: 'long-track.mp3',
      mimeType: 'audio/mpeg',
    })
  })

  it('rejects unsupported, cross-kind, mismatched, or malformed file sources', () => {
    expect(normalizePresentationFileSource('image', {
      dataUrl: 'data:image/webp;base64,aW1hZ2U=',
      fileName: 'image.webp',
      mimeType: 'image/webp',
    })).toBeNull()
    expect(normalizePresentationFileSource('audio', {
      dataUrl: 'data:video/mp4;base64,bWVkaWE=',
      fileName: 'media.mp4',
      mimeType: 'video/mp4',
    })).toBeNull()
    expect(normalizePresentationFileSource('video', {
      dataUrl: 'data:video/mp4;base64,bWVkaWE=',
      fileName: 'renamed.mov',
      mimeType: 'video/mp4',
    })).toBeNull()
    expect(normalizePresentationFileSource('image', {
      dataUrl: 'data:image/jpeg;base64,aW1hZ2U=',
      fileName: 'image.png',
      mimeType: 'image/png',
    })).toBeNull()
    expect(normalizePresentationFileSource('video', {
      dataUrl: 'data:application/octet-stream;base64,dmlkZW8=',
      fileName: 'clip.avi',
      mimeType: '',
    })).toBeNull()
    expect(normalizePresentationFileSource('video', {
      dataUrl: 'data:video/mp4,dmlkZW8=',
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
    })).toBeNull()
    expect(normalizePresentationFileSource('video', {
      dataUrl: 'not-a-data-url',
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
    })).toBeNull()
    expect(normalizePresentationFileSource('audio', {
      dataUrl: 'data:audio/mpeg;base64,',
      fileName: 'empty.mp3',
      mimeType: 'audio/mpeg',
    })).toBeNull()
    expect(normalizePresentationFileSource('audio', {
      dataUrl: 'data:audio/mpeg;base64,S=Qz',
      fileName: 'misplaced-padding.mp3',
      mimeType: 'audio/mpeg',
    })).toBeNull()
    expect(normalizePresentationFileSource('audio', {
      dataUrl: 'data:audio/mpeg;base64,SUQ',
      fileName: 'missing-padding.mp3',
      mimeType: 'audio/mpeg',
    })).toBeNull()
    expect(normalizePresentationFileSource('video', {
      dataUrl: 'data:video/mp4;base64,not_base64!',
      fileName: 'broken.mp4',
      mimeType: 'video/mp4',
    })).toBeNull()
  })

  it('creates centered image and media elements with inert playback defaults', () => {
    const image = createPresentationImageElement(imageSource)
    expect(image).toMatchObject({
      type: 'image',
      x: 320,
      y: 180,
      width: 640,
      height: 360,
      rotation: 0,
      source: imageSource,
      altText: 'image.png',
      fit: 'contain',
    })

    const audio = createPresentationMediaElement('audio', {
      dataUrl: 'data:audio/mpeg;base64,YXVkaW8=',
      fileName: 'audio.mp3',
      mimeType: 'audio/mpeg',
    })
    expect(audio).toMatchObject({
      type: 'audio',
      x: 380,
      y: 324,
      width: 520,
      height: 72,
      autoplay: false,
      loop: false,
      muted: false,
    })

    const video = createPresentationMediaElement('video', {
      dataUrl: 'data:video/mp4;base64,dmlkZW8=',
      fileName: 'video.mp4',
      mimeType: 'video/mp4',
    })
    expect(video).toMatchObject({
      type: 'video',
      x: 320,
      y: 180,
      width: 640,
      height: 360,
      autoplay: false,
      loop: false,
      muted: false,
    })
  })

  it('validates supported media container signatures before insertion or export', () => {
    expect(hasValidPresentationMediaSignature('audio', {
      dataUrl: 'data:audio/mpeg;base64,SUQzAwAAAAAA',
      fileName: 'sound.mp3',
      mimeType: 'audio/mpeg',
    })).toBe(true)
    expect(hasValidPresentationMediaSignature('audio', {
      dataUrl: 'data:audio/ogg;base64,T2dnUwAAAAA=',
      fileName: 'sound.ogg',
      mimeType: 'audio/ogg',
    })).toBe(true)
    expect(hasValidPresentationMediaSignature('video', {
      dataUrl: 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAA==',
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
    })).toBe(true)
    expect(hasValidPresentationMediaSignature('video', {
      dataUrl: 'data:video/webm;base64,GkXfowAAAAA=',
      fileName: 'clip.webm',
      mimeType: 'video/webm',
    })).toBe(true)
    expect(hasValidPresentationMediaSignature('audio', {
      dataUrl: 'data:audio/mpeg;base64,AQIDBA==',
      fileName: 'fake.mp3',
      mimeType: 'audio/mpeg',
    })).toBe(false)
    expect(hasValidPresentationMediaSignature('video', {
      dataUrl: 'data:audio/mpeg;base64,SUQzAwAAAAAA',
      fileName: 'wrong-kind.mp3',
      mimeType: 'audio/mpeg',
    })).toBe(false)
  })

  it('creates independent table, chart, and footer defaults', () => {
    const sourceCells = [['Name', 'Value'], ['A', '3']]
    const table = createPresentationTableElement(sourceCells)
    sourceCells[0]![0] = 'Changed outside'
    expect(table).toMatchObject({
      type: 'table',
      x: 280,
      y: 210,
      width: 720,
      height: 300,
      cells: [['Name', 'Value'], ['A', '3']],
      headerRow: true,
      fontSize: 18,
    })

    const firstChart = createPresentationChartElement('pie')
    const secondChart = createPresentationChartElement()
    firstChart.categories[0] = 'Changed'
    firstChart.series[0]!.values[0] = 99
    firstChart.colors[0] = '#000000'
    expect(firstChart.chartType).toBe('pie')
    expect(secondChart).toMatchObject({
      type: 'chart',
      chartType: 'column',
      x: 260,
      y: 170,
      width: 760,
      height: 380,
      categories: ['Category 1', 'Category 2', 'Category 3', 'Category 4'],
      series: [
        { name: 'Series 1', values: [4, 7, 5, 8] },
        { name: 'Series 2', values: [3, 5, 6, 4] },
      ],
      showLegend: true,
    })
    expect(secondChart.colors[0]).toBe('#6957D9')
    expect(createPresentationFooter('Quarterly review')).toEqual({
      text: 'Quarterly review',
      showDate: false,
      showSlideNumber: false,
    })
  })

  it('recognizes every element family without treating arbitrary non-text values as shapes', () => {
    const text: PresentationTextElement = {
      id: 'text-1',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      rotation: 0,
      text: 'Text',
      fontSize: 20,
      fontFamily: 'Aptos',
      fontWeight: 400,
      color: '#000000',
      align: 'left',
    }
    const shape: PresentationShapeElement = {
      id: 'shape-1',
      type: 'heart',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      fill: '#FFFFFF',
      borderColor: '#000000',
      borderWidth: 1,
    }
    const image = createPresentationImageElement(imageSource)
    const video = createPresentationMediaElement('video', {
      dataUrl: 'data:video/mp4;base64,dmlkZW8=',
      fileName: 'video.mp4',
      mimeType: 'video/mp4',
    })
    const table = createPresentationTableElement()
    const chart = createPresentationChartElement()

    expect(isPresentationTextElement(text)).toBe(true)
    expect(isPresentationShapeElement(shape)).toBe(true)
    expect(isPresentationShapeElement(image)).toBe(false)
    expect(isPresentationShapeElement({ type: 'future-element' })).toBe(false)
    expect(isPresentationImageElement(image)).toBe(true)
    expect(isPresentationMediaElement(video)).toBe(true)
    expect(isPresentationVideoElement(video)).toBe(true)
    expect(isPresentationTableElement(table)).toBe(true)
    expect(isPresentationChartElement(chart)).toBe(true)
    expect(supportsPresentationElementShadow(text)).toBe(true)
    expect(supportsPresentationElementShadow(image)).toBe(true)
    expect(supportsPresentationElementShadow(table)).toBe(false)
    expect(supportsPresentationElementRotation(image)).toBe(true)
    expect(supportsPresentationElementRotation(video)).toBe(false)
    expect(supportsPresentationElementRotation(chart)).toBe(false)
    expect(supportsPresentationElementHyperlink(text)).toBe(true)
    expect(supportsPresentationElementHyperlink(shape)).toBe(true)
    expect(supportsPresentationElementHyperlink(image)).toBe(true)
    expect(supportsPresentationElementHyperlink(video)).toBe(false)
    expect(supportsPresentationElementHyperlink(table)).toBe(false)
    expect(supportsPresentationElementHyperlink(chart)).toBe(false)
  })

  it('normalizes only supported external URL schemes and builds tooltip metadata', () => {
    expect(normalizePresentationHyperlinkUrl('example.com/docs')).toBe('https://example.com/docs')
    expect(normalizePresentationHyperlinkUrl(' mailto:team@example.com ')).toBe('mailto:team@example.com')
    expect(normalizePresentationHyperlinkUrl('javascript:alert(1)')).toBeNull()
    expect(normalizePresentationHyperlinkUrl('')).toBeNull()
    expect(createPresentationUrlHyperlink('https://example.com', '  Open docs  ')).toEqual({
      type: 'url',
      url: 'https://example.com/',
      tooltip: 'Open docs',
    })
  })

  it('parses comma or tab-delimited pasted data including quoted cells', () => {
    expect(parsePresentationDelimitedText('Name,Value\n"North, East",12\nSouth,8')).toEqual([
      ['Name', 'Value'],
      ['North, East', '12'],
      ['South', '8'],
    ])
    expect(parsePresentationDelimitedText('Name\tValue\r\nA\t"He said ""yes"""')).toEqual([
      ['Name', 'Value'],
      ['A', 'He said "yes"'],
    ])
    expect(parsePresentationDelimitedText('   ')).toEqual([])
  })
})
