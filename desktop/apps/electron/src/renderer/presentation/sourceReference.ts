const MOUNT_SOURCE_PREFIX = 'bridgic-mount:'
const PPTX_SOURCE_PREFIX = 'bridgic-pptx:'
const DERIVED_SOURCE_PREFIX = 'bridgic-pptx-derived:'

function decodeSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return undefined
    return decoded
  } catch { return undefined }
}

export function presentationMountSource(mountId: string, relativePath?: string): string {
  const id = mountId.trim()
  if (!id || decodeSegment(encodeURIComponent(id)) === undefined) throw new Error('A valid mount id is required')
  const segments = relativePath === undefined ? [] : relativePath.split('/')
  if (segments.some((segment) => decodeSegment(segment) === undefined)) throw new Error('Invalid mount-relative path')
  const suffix = segments.map(encodeURIComponent).join('/')
  return `${MOUNT_SOURCE_PREFIX}${encodeURIComponent(id)}${suffix ? `/${suffix}` : ''}`
}

export function mountedPresentationSource(source?: string): { mountId: string; relativePath?: string } | undefined {
  if (!source?.startsWith(MOUNT_SOURCE_PREFIX)) return undefined
  const [encodedId, ...encodedSegments] = source.slice(MOUNT_SOURCE_PREFIX.length).split('/')
  const mountId = decodeSegment(encodedId ?? '')
  const segments = encodedSegments.map(decodeSegment)
  if (!mountId || segments.some((segment) => segment === undefined)) return undefined
  const relativePath = segments.length ? (segments as string[]).join('/') : undefined
  return { mountId, ...(relativePath ? { relativePath } : {}) }
}

export function presentationPptxSource(projectId: string, partPath: string): string {
  const id = projectId.trim()
  if (!id || decodeSegment(encodeURIComponent(id)) === undefined) throw new Error('A valid PowerPoint project id is required')
  const segments = partPath.split('/')
  if (segments.length === 0 || segments.some((segment) => decodeSegment(segment) === undefined)) throw new Error('Invalid PPTX part path')
  return `${PPTX_SOURCE_PREFIX}${encodeURIComponent(id)}/${segments.map(encodeURIComponent).join('/')}`
}

export function embeddedPresentationSource(source?: string): { projectId: string; partPath: string } | undefined {
  if (!source?.startsWith(PPTX_SOURCE_PREFIX)) return undefined
  const [encodedId, ...encodedSegments] = source.slice(PPTX_SOURCE_PREFIX.length).split('/')
  const projectId = decodeSegment(encodedId ?? '')
  const segments = encodedSegments.map(decodeSegment)
  if (!projectId || segments.length === 0 || segments.some((segment) => segment === undefined)) return undefined
  return { projectId, partPath: (segments as string[]).join('/') }
}

export function presentationDerivedSource(dataUrl: string): string {
  if (!/^data:[^;,]+;base64,[A-Za-z0-9+/\s]*={0,2}$/i.test(dataUrl)) throw new Error('Invalid derived PowerPoint source')
  return `${DERIVED_SOURCE_PREFIX}${encodeURIComponent(dataUrl.replace(/\s/g, ''))}`
}

export function derivedPresentationSource(source?: string): string | undefined {
  if (!source?.startsWith(DERIVED_SOURCE_PREFIX)) return undefined
  try {
    const dataUrl = decodeURIComponent(source.slice(DERIVED_SOURCE_PREFIX.length))
    return /^data:[^;,]+;base64,[A-Za-z0-9+/]*={0,2}$/i.test(dataUrl) ? dataUrl : undefined
  } catch { return undefined }
}

export function isDurablePresentationSource(source: string): boolean {
  return mountedPresentationSource(source) !== undefined
    || embeddedPresentationSource(source) !== undefined
    || derivedPresentationSource(source) !== undefined
}

export function isValidPresentationSource(source: string): boolean {
  if (source.startsWith('bridgic-')) return isDurablePresentationSource(source)
  return !source.startsWith('bridgic-')
}
