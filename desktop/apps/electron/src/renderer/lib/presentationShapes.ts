import type { PresentationShapeType } from '@/atoms/presentation'

export type PresentationShapeCategoryId = 'lines' | 'rectangles' | 'basic' | 'arrows' | 'equation' | 'flowchart'

export interface PresentationShapeDefinition {
  type: PresentationShapeType
  category: PresentationShapeCategoryId
  name: { en: string; zh: string }
  path: string
  strokeOnly?: boolean
}

function polygonPath(sides: number, radius = 45, rotation = -90): string {
  return Array.from({ length: sides }, (_, index) => {
    const angle = ((rotation + (index * 360) / sides) * Math.PI) / 180
    const x = 50 + Math.cos(angle) * radius
    const y = 50 + Math.sin(angle) * radius
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ') + ' Z'
}

function starPath(points: number, outer = 46, inner = 22, rotation = -90): string {
  return Array.from({ length: points * 2 }, (_, index) => {
    const radius = index % 2 === 0 ? outer : inner
    const angle = ((rotation + (index * 180) / points) * Math.PI) / 180
    const x = 50 + Math.cos(angle) * radius
    const y = 50 + Math.sin(angle) * radius
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ') + ' Z'
}

function shape(type: PresentationShapeType, category: PresentationShapeCategoryId, en: string, zh: string, path: string, strokeOnly = false): PresentationShapeDefinition {
  return { type, category, name: { en, zh }, path, strokeOnly }
}

const LINE_SHAPES: PresentationShapeDefinition[] = [
  shape('line', 'lines', 'Line', '直线', 'M 7 86 L 93 14', true),
  shape('lineArrow', 'lines', 'Arrow', '箭头', 'M 7 86 L 88 19 M 68 18 L 88 19 L 85 39', true),
  shape('lineDoubleArrow', 'lines', 'Double arrow', '双箭头', 'M 12 81 L 88 19 M 12 81 L 15 61 M 12 81 L 32 82 M 88 19 L 85 39 M 88 19 L 68 18', true),
  shape('elbowConnector', 'lines', 'Elbow connector', '肘形连接符', 'M 10 18 H 53 V 82 H 92', true),
  shape('elbowArrow', 'lines', 'Elbow arrow connector', '肘形箭头连接符', 'M 10 18 H 53 V 82 H 90 M 73 68 L 90 82 L 73 96', true),
  shape('curvedConnector', 'lines', 'Curved connector', '曲线连接符', 'M 8 78 C 18 8 78 92 92 22', true),
  shape('curvedArrow', 'lines', 'Curved arrow connector', '曲线箭头连接符', 'M 8 78 C 18 8 78 92 92 22 M 74 27 L 92 22 L 90 40', true),
]

const RECTANGLE_SHAPES: PresentationShapeDefinition[] = [
  shape('rect', 'rectangles', 'Rectangle', '矩形', 'M 7 12 H 93 V 88 H 7 Z'),
  shape('roundRect', 'rectangles', 'Rounded rectangle', '圆角矩形', 'M 20 10 H 80 Q 92 10 92 22 V 78 Q 92 90 80 90 H 20 Q 8 90 8 78 V 22 Q 8 10 20 10 Z'),
  shape('snip1Rect', 'rectangles', 'Snip single corner', '单剪角矩形', 'M 7 12 H 74 L 93 31 V 88 H 7 Z'),
  shape('snip2DiagRect', 'rectangles', 'Snip diagonal corners', '对角剪角矩形', 'M 7 29 L 24 12 H 93 V 71 L 76 88 H 7 Z'),
  shape('round1Rect', 'rectangles', 'Single rounded corner', '单圆角矩形', 'M 7 12 H 77 Q 93 12 93 28 V 88 H 7 Z'),
  shape('round2SameRect', 'rectangles', 'Same-side rounded corners', '同侧圆角矩形', 'M 22 12 H 93 V 88 H 22 Q 7 88 7 73 V 27 Q 7 12 22 12 Z'),
  shape('frame', 'rectangles', 'Frame', '框架', 'M 5 8 H 95 V 92 H 5 Z M 22 25 H 78 V 75 H 22 Z'),
]

const BASIC_SHAPES: PresentationShapeDefinition[] = [
  shape('ellipse', 'basic', 'Oval', '椭圆', 'M 50 5 A 45 45 0 1 1 49.99 5 Z'),
  shape('triangle', 'basic', 'Triangle', '三角形', polygonPath(3)),
  shape('rtTriangle', 'basic', 'Right triangle', '直角三角形', 'M 8 8 V 92 H 92 Z'),
  shape('parallelogram', 'basic', 'Parallelogram', '平行四边形', 'M 24 8 H 95 L 76 92 H 5 Z'),
  shape('trapezoid', 'basic', 'Trapezoid', '梯形', 'M 24 8 H 76 L 94 92 H 6 Z'),
  shape('diamond', 'basic', 'Diamond', '菱形', polygonPath(4)),
  shape('pentagon', 'basic', 'Pentagon', '五边形', polygonPath(5)),
  shape('hexagon', 'basic', 'Hexagon', '六边形', polygonPath(6)),
  shape('octagon', 'basic', 'Octagon', '八边形', polygonPath(8)),
  shape('decagon', 'basic', 'Decagon', '十边形', polygonPath(10)),
  shape('dodecagon', 'basic', 'Dodecagon', '十二边形', polygonPath(12)),
  shape('pie', 'basic', 'Pie', '饼形', 'M 50 50 L 50 5 A 45 45 0 1 1 8 66 Z'),
  shape('teardrop', 'basic', 'Teardrop', '泪滴形', 'M 50 4 C 82 32 94 53 88 72 C 82 92 58 99 39 90 C 17 80 8 57 20 38 C 27 27 38 16 50 4 Z'),
  shape('plus', 'basic', 'Cross', '十字形', 'M 36 6 H 64 V 36 H 94 V 64 H 64 V 94 H 36 V 64 H 6 V 36 H 36 Z'),
  shape('star4', 'basic', 'Four-point star', '四角星', starPath(4, 46, 15)),
  shape('star5', 'basic', 'Five-point star', '五角星', starPath(5)),
  shape('star6', 'basic', 'Six-point star', '六角星', starPath(6)),
  shape('star8', 'basic', 'Eight-point star', '八角星', starPath(8, 46, 27)),
  shape('heart', 'basic', 'Heart', '心形', 'M 50 91 C 42 80 10 60 10 34 C 10 12 39 4 50 25 C 61 4 90 12 90 34 C 90 60 58 80 50 91 Z'),
  shape('lightningBolt', 'basic', 'Lightning bolt', '闪电', 'M 57 3 L 17 57 H 44 L 37 97 L 84 40 H 57 Z'),
  shape('sun', 'basic', 'Sun', '太阳', starPath(16, 47, 35)),
  shape('moon', 'basic', 'Moon', '月亮', 'M 70 5 C 34 11 25 54 50 78 C 61 89 77 93 91 86 C 72 99 42 95 23 75 C -3 47 13 7 47 1 C 55 0 63 1 70 5 Z'),
  shape('cloud', 'basic', 'Cloud', '云形', 'M 24 82 C 7 82 2 62 14 52 C 8 33 31 20 46 32 C 57 9 91 18 90 43 C 106 48 101 77 84 80 Z'),
  shape('donut', 'basic', 'Donut', '圆环', 'M 50 4 A 46 46 0 1 1 49.99 4 Z M 50 30 A 20 20 0 1 0 50.01 30 Z'),
  shape('arc', 'basic', 'Arc', '弧形', 'M 9 77 C 12 27 50 5 91 23', true),
  shape('smileyFace', 'basic', 'Smiley face', '笑脸', 'M 50 5 A 45 45 0 1 1 49.99 5 Z M 31 38 A 4 4 0 1 1 30.99 38 Z M 69 38 A 4 4 0 1 1 68.99 38 Z M 27 58 C 35 82 65 82 73 58'),
  shape('can', 'basic', 'Cylinder', '圆柱体', 'M 12 18 C 12 4 88 4 88 18 V 82 C 88 96 12 96 12 82 Z M 12 18 C 12 34 88 34 88 18 M 12 82 C 12 68 88 68 88 82'),
  shape('cube', 'basic', 'Cube', '立方体', 'M 12 28 L 50 7 L 88 28 V 74 L 50 94 L 12 74 Z M 12 28 L 50 50 L 88 28 M 50 50 V 94'),
  shape('bevel', 'basic', 'Bevel', '棱台', 'M 22 7 H 78 L 93 22 V 78 L 78 93 H 22 L 7 78 V 22 Z M 22 7 V 93 M 78 7 V 93 M 7 22 H 93 M 7 78 H 93'),
  shape('bracePair', 'basic', 'Brace pair', '大括号对', 'M 32 7 C 20 7 22 28 22 38 C 22 48 14 50 8 50 C 14 50 22 52 22 62 C 22 72 20 93 32 93 M 68 7 C 80 7 78 28 78 38 C 78 48 86 50 92 50 C 86 50 78 52 78 62 C 78 72 80 93 68 93', true),
  shape('bracketPair', 'basic', 'Bracket pair', '方括号对', 'M 34 7 H 18 V 93 H 34 M 66 7 H 82 V 93 H 66', true),
]

const ARROW_SHAPES: PresentationShapeDefinition[] = [
  shape('rightArrow', 'arrows', 'Right arrow', '右箭头', 'M 5 34 H 62 V 14 L 95 50 L 62 86 V 66 H 5 Z'),
  shape('leftArrow', 'arrows', 'Left arrow', '左箭头', 'M 95 34 H 38 V 14 L 5 50 L 38 86 V 66 H 95 Z'),
  shape('upArrow', 'arrows', 'Up arrow', '上箭头', 'M 34 95 V 38 H 14 L 50 5 L 86 38 H 66 V 95 Z'),
  shape('downArrow', 'arrows', 'Down arrow', '下箭头', 'M 34 5 V 62 H 14 L 50 95 L 86 62 H 66 V 5 Z'),
  shape('leftRightArrow', 'arrows', 'Left-right arrow', '左右箭头', 'M 5 50 L 30 20 V 35 H 70 V 20 L 95 50 L 70 80 V 65 H 30 V 80 Z'),
  shape('upDownArrow', 'arrows', 'Up-down arrow', '上下箭头', 'M 50 5 L 80 30 H 65 V 70 H 80 L 50 95 L 20 70 H 35 V 30 H 20 Z'),
  shape('quadArrow', 'arrows', 'Quad arrow', '四向箭头', 'M 50 4 L 69 23 H 59 V 41 H 77 V 31 L 96 50 L 77 69 V 59 H 59 V 77 H 69 L 50 96 L 31 77 H 41 V 59 H 23 V 69 L 4 50 L 23 31 V 41 H 41 V 23 H 31 Z'),
  shape('bentArrow', 'arrows', 'Bent arrow', '直角箭头', 'M 10 14 H 57 V 57 H 76 V 39 L 95 67 L 76 95 V 77 H 37 V 34 H 10 Z'),
  shape('bentUpArrow', 'arrows', 'Bent up arrow', '上弯箭头', 'M 7 78 H 51 V 39 H 34 L 62 6 L 91 39 H 73 V 94 H 7 Z'),
  shape('uturnArrow', 'arrows', 'U-turn arrow', 'U 形箭头', 'M 14 94 V 45 C 14 7 70 4 79 36 H 94 L 72 66 L 50 36 H 58 C 55 24 35 27 35 45 V 94 Z'),
  shape('circularArrow', 'arrows', 'Circular arrow', '循环箭头', 'M 83 21 L 94 54 L 61 47 L 72 38 C 56 19 23 28 18 54 C 13 80 41 96 64 82 C 44 105 5 90 5 58 C 5 21 48 2 77 28 Z'),
  shape('chevron', 'arrows', 'Chevron', '燕尾形', 'M 8 8 H 57 L 92 50 L 57 92 H 8 L 43 50 Z'),
  shape('notchedRightArrow', 'arrows', 'Notched right arrow', '凹口右箭头', 'M 7 15 H 61 L 94 50 L 61 85 H 7 L 24 50 Z'),
  shape('stripedRightArrow', 'arrows', 'Striped right arrow', '条纹右箭头', 'M 5 25 H 16 V 75 H 5 Z M 22 25 H 34 V 75 H 22 Z M 40 25 H 64 V 8 L 96 50 L 64 92 V 75 H 40 Z'),
  shape('rightArrowCallout', 'arrows', 'Right arrow callout', '右箭头标注', 'M 5 12 H 67 V 32 H 78 V 18 L 96 50 L 78 82 V 68 H 67 V 88 H 5 Z'),
  shape('leftArrowCallout', 'arrows', 'Left arrow callout', '左箭头标注', 'M 95 12 H 33 V 32 H 22 V 18 L 4 50 L 22 82 V 68 H 33 V 88 H 95 Z'),
  shape('upArrowCallout', 'arrows', 'Up arrow callout', '上箭头标注', 'M 12 95 V 33 H 32 V 22 H 18 L 50 4 L 82 22 H 68 V 33 H 88 V 95 Z'),
  shape('downArrowCallout', 'arrows', 'Down arrow callout', '下箭头标注', 'M 12 5 V 67 H 32 V 78 H 18 L 50 96 L 82 78 H 68 V 67 H 88 V 5 Z'),
]

const EQUATION_SHAPES: PresentationShapeDefinition[] = [
  shape('mathPlus', 'equation', 'Plus', '加号', 'M 38 8 H 62 V 38 H 92 V 62 H 62 V 92 H 38 V 62 H 8 V 38 H 38 Z'),
  shape('mathMinus', 'equation', 'Minus', '减号', 'M 8 38 H 92 V 62 H 8 Z'),
  shape('mathMultiply', 'equation', 'Multiply', '乘号', 'M 20 6 L 50 36 L 80 6 L 94 20 L 64 50 L 94 80 L 80 94 L 50 64 L 20 94 L 6 80 L 36 50 L 6 20 Z'),
  shape('mathDivide', 'equation', 'Divide', '除号', 'M 9 40 H 91 V 60 H 9 Z M 50 8 A 10 10 0 1 1 49.99 8 Z M 50 72 A 10 10 0 1 1 49.99 72 Z'),
  shape('mathEqual', 'equation', 'Equal', '等号', 'M 9 25 H 91 V 43 H 9 Z M 9 57 H 91 V 75 H 9 Z'),
  shape('mathNotEqual', 'equation', 'Not equal', '不等号', 'M 9 24 H 91 V 41 H 59 L 50 59 H 91 V 76 H 41 L 27 94 L 13 84 L 20 76 H 9 V 59 H 33 L 42 41 H 9 Z M 57 24 L 69 6 L 83 16 L 77 24 Z'),
]

const FLOWCHART_SHAPES: PresentationShapeDefinition[] = [
  shape('flowChartProcess', 'flowchart', 'Process', '流程', 'M 7 12 H 93 V 88 H 7 Z'),
  shape('flowChartAlternateProcess', 'flowchart', 'Alternate process', '可选过程', 'M 19 10 H 81 Q 92 10 92 21 V 79 Q 92 90 81 90 H 19 Q 8 90 8 79 V 21 Q 8 10 19 10 Z'),
  shape('flowChartDecision', 'flowchart', 'Decision', '决策', polygonPath(4)),
  shape('flowChartInputOutput', 'flowchart', 'Data', '数据', 'M 24 9 H 95 L 76 91 H 5 Z'),
  shape('flowChartDocument', 'flowchart', 'Document', '文档', 'M 7 9 H 93 V 73 C 71 94 32 55 7 84 Z'),
  shape('flowChartMultidocument', 'flowchart', 'Multiple documents', '多文档', 'M 18 5 H 93 V 66 C 72 84 42 58 18 77 Z M 11 14 V 76 C 35 60 65 91 86 72 M 5 23 V 86 C 30 66 61 98 80 80'),
  shape('flowChartTerminator', 'flowchart', 'Terminator', '终止符', 'M 24 10 H 76 A 40 40 0 0 1 76 90 H 24 A 40 40 0 0 1 24 10 Z'),
  shape('flowChartPreparation', 'flowchart', 'Preparation', '准备', 'M 22 8 H 78 L 95 50 L 78 92 H 22 L 5 50 Z'),
  shape('flowChartManualInput', 'flowchart', 'Manual input', '手动输入', 'M 7 28 L 93 8 V 92 H 7 Z'),
  shape('flowChartManualOperation', 'flowchart', 'Manual operation', '手动操作', 'M 6 8 H 94 L 77 92 H 23 Z'),
  shape('flowChartConnector', 'flowchart', 'Connector', '连接符', 'M 50 5 A 45 45 0 1 1 49.99 5 Z'),
  shape('flowChartOffpageConnector', 'flowchart', 'Off-page connector', '页外连接符', 'M 8 8 H 92 V 63 L 50 94 L 8 63 Z'),
  shape('flowChartDelay', 'flowchart', 'Delay', '延迟', 'M 7 8 H 52 C 106 8 106 92 52 92 H 7 Z'),
  shape('flowChartDisplay', 'flowchart', 'Display', '显示', 'M 22 8 H 72 C 101 8 101 92 72 92 H 22 L 5 50 Z'),
  shape('flowChartPredefinedProcess', 'flowchart', 'Predefined process', '预定义过程', 'M 7 9 H 93 V 91 H 7 Z M 24 9 V 91 M 76 9 V 91'),
  shape('flowChartInternalStorage', 'flowchart', 'Internal storage', '内部存储', 'M 7 8 H 93 V 92 H 7 Z M 23 8 V 92 M 7 27 H 93'),
]

export const presentationShapeCategories: Array<{ id: PresentationShapeCategoryId; name: { en: string; zh: string }; shapes: PresentationShapeDefinition[] }> = [
  { id: 'lines', name: { en: 'Lines', zh: '线条' }, shapes: LINE_SHAPES },
  { id: 'rectangles', name: { en: 'Rectangles', zh: '矩形' }, shapes: RECTANGLE_SHAPES },
  { id: 'basic', name: { en: 'Basic shapes', zh: '基本形状' }, shapes: BASIC_SHAPES },
  { id: 'arrows', name: { en: 'Block arrows', zh: '箭头总汇' }, shapes: ARROW_SHAPES },
  { id: 'equation', name: { en: 'Equation shapes', zh: '公式形状' }, shapes: EQUATION_SHAPES },
  { id: 'flowchart', name: { en: 'Flowchart', zh: '流程图' }, shapes: FLOWCHART_SHAPES },
]

const presentationShapes = presentationShapeCategories.flatMap((category) => category.shapes)
const presentationShapeMap = new Map(presentationShapes.map((definition) => [definition.type, definition]))
const lineShapeTypes = new Set<PresentationShapeType>(LINE_SHAPES.map((definition) => definition.type))

export function getPresentationShapeDefinition(type: PresentationShapeType): PresentationShapeDefinition {
  return presentationShapeMap.get(type) ?? RECTANGLE_SHAPES[0]!
}

export function getPresentationShapeName(type: PresentationShapeType, language: string): string {
  const name = getPresentationShapeDefinition(type).name
  return language.toLowerCase().startsWith('zh') ? name.zh : name.en
}

export function isPresentationLineShape(type: PresentationShapeType): boolean {
  return lineShapeTypes.has(type)
}

export function getPresentationShapeSize(type: PresentationShapeType): { width: number; height: number } {
  if (isPresentationLineShape(type)) return { width: 300, height: 120 }
  const category = getPresentationShapeDefinition(type).category
  if (category === 'arrows') return { width: 280, height: 150 }
  if (category === 'equation') return { width: 160, height: 160 }
  if (category === 'flowchart') return { width: 260, height: 150 }
  if (type === 'ellipse' || type === 'donut' || type.startsWith('star') || type === 'sun') return { width: 210, height: 210 }
  return { width: 260, height: 180 }
}

export function getPresentationLineEnds(type: PresentationShapeType): { beginArrowType?: 'arrow'; endArrowType?: 'arrow' } {
  if (type === 'lineDoubleArrow') return { beginArrowType: 'arrow', endArrowType: 'arrow' }
  if (type === 'lineArrow' || type === 'elbowArrow' || type === 'curvedArrow') return { endArrowType: 'arrow' }
  return {}
}
