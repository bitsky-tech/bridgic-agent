import {
  createBlankPresentationDocument,
  createBlankPresentationSlide,
  createPresentationId,
  type PresentationDocument,
  type PresentationElement,
} from '@/atoms/presentation'

/** Rich content used only by presentation tests; production starts with a blank document. */
export function createPresentationTestDocument(): PresentationDocument {
  const document = createBlankPresentationDocument('Test presentation')
  const firstSlide = document.slides[0]!
  const secondSlide = createBlankPresentationSlide('Supporting slide')
  const groupId = createPresentationId('group')
  const groupedElements: PresentationElement[] = [
    {
      id: createPresentationId('shape'),
      groupId,
      type: 'rect',
      x: 120,
      y: 180,
      width: 420,
      height: 300,
      rotation: 0,
      fill: '#FFFFFF',
      borderColor: '#D9DCE3',
      borderWidth: 1,
      radius: 18,
    },
    {
      id: createPresentationId('text'),
      groupId,
      type: 'text',
      x: 152,
      y: 216,
      width: 72,
      height: 40,
      rotation: 0,
      text: '01',
      fontSize: 20,
      fontFamily: 'Aptos',
      fontWeight: 700,
      color: '#6957D9',
      align: 'left',
    },
    {
      id: createPresentationId('text'),
      groupId,
      type: 'text',
      x: 152,
      y: 292,
      width: 340,
      height: 58,
      rotation: 0,
      text: 'Supporting detail',
      fontSize: 28,
      fontFamily: 'Aptos Display',
      fontWeight: 700,
      color: '#1D1D28',
      align: 'left',
    },
    {
      id: createPresentationId('text'),
      groupId,
      type: 'text',
      x: 152,
      y: 376,
      width: 340,
      height: 68,
      rotation: 0,
      text: 'Body copy for presentation behavior tests.',
      fontSize: 18,
      fontFamily: 'Aptos',
      fontWeight: 400,
      color: '#666571',
      align: 'left',
    },
  ]

  firstSlide.name = 'Primary slide'
  firstSlide.elements = [
    {
      id: createPresentationId('shape'),
      type: 'rect',
      x: 80,
      y: 72,
      width: 112,
      height: 12,
      rotation: 0,
      fill: '#8B7CFF',
      borderColor: '#8B7CFF',
      borderWidth: 0,
      radius: 6,
    },
    {
      id: createPresentationId('text'),
      type: 'text',
      x: 80,
      y: 148,
      width: 920,
      height: 110,
      rotation: 0,
      text: 'Primary message',
      fontSize: 64,
      fontFamily: 'Aptos Display',
      fontWeight: 700,
      color: '#1D1D28',
      align: 'left',
    },
  ]
  secondSlide.background = '#F7F6F2'
  secondSlide.elements = groupedElements

  return {
    ...document,
    selectedSlideId: firstSlide.id,
    slides: [firstSlide, secondSlide],
  }
}
