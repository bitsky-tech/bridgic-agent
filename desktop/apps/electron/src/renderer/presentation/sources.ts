import type { PresentationAsset, PresentationFileSource, PresentationProject } from '@/atoms/presentation'
import type { PresentationSourceMount } from '@shared/presentation-host'
import { createLocalResourceUrl } from '@shared/local-resource'
import JSZip from 'jszip'
import { absolutePathToFileUrl } from '../components/markdown/localResource'
import { derivedPresentationSource, embeddedPresentationSource, mountedPresentationSource, presentationPptxSource } from './sourceReference'

export function presentationSourceUrls(sourceRefs: Iterable<string>, mounts: readonly PresentationSourceMount[]): Record<string, string> {
  const refs = [...sourceRefs]
  const result: Record<string, string> = {}
  for (const source of refs) {
    const derived = derivedPresentationSource(source)
    if (derived) result[source] = derived
  }
  const token = typeof window === 'undefined' ? undefined : window.__localResourceToken__
  if (!token) return result
  const byId = new Map(mounts.map((mount) => [mount.id, mount]))
  for (const source of refs) {
    const reference = mountedPresentationSource(source)
    if (!reference) continue
    const mount = byId.get(reference.mountId)
    if (!mount?.exists) continue
    const path = reference.relativePath ? `${mount.path.replace(/[\\/]+$/, '')}/${reference.relativePath}` : mount.path
    const fileUrl = absolutePathToFileUrl(path)
    if (fileUrl) result[source] = createLocalResourceUrl(fileUrl, token)
  }
  return result
}

/** Resolve project-owned package parts directly from the original PPTX bytes. */
export async function presentationPptxSourceUrls(project: PresentationProject, encodedPptx: string): Promise<Record<string, string>> {
  const embedded = project.assets.flatMap((asset) => [
    { source: asset.source, mimeType: asset.mimeType, name: asset.name },
    ...(asset.imageEffects?.backgroundRemoval ? [{
      source: asset.imageEffects.backgroundRemoval.layerSource,
      mimeType: 'image/vnd.ms-photo',
      name: `${asset.name} effect layer`,
    }] : []),
  ]).flatMap((item) => {
    const reference = embeddedPresentationSource(item.source)
    return reference?.projectId === project.id ? [{ ...item, reference }] : []
  })
  if (embedded.length === 0) return {}
  const archive = await JSZip.loadAsync(encodedPptx, { base64: true })
  return Object.fromEntries(await Promise.all(embedded.map(async ({ source, mimeType, name, reference }) => {
    const file = archive.file(reference.partPath)
    if (!file) throw new Error(`PowerPoint package source is unavailable: ${name}`)
    return [source, `data:${mimeType};base64,${await file.async('base64')}`] as const
  })))
}

/** Repoint exported media at the matching parts in the newly written PPTX. */
export async function rebasePresentationPptxSources(project: PresentationProject, materialized: PresentationProject, encodedPptx: string): Promise<{ project: PresentationProject; replacements: ReadonlyMap<string, string> }> {
  const archive = await JSZip.loadAsync(encodedPptx, { base64: true })
  const partByPayload = new Map<string, string>()
  await Promise.all(Object.keys(archive.files).filter((path) => /^ppt\/media\/[^/]+$/i.test(path)).map(async (path) => {
    const file = archive.file(path)
    if (file) partByPayload.set(await file.async('base64'), path)
  }))
  const materializedById = new Map(materialized.assets.map((asset) => [asset.id, asset]))
  const replacements = new Map<string, string>()
  const rebase = (source: string, runtime: string | undefined) => {
    const payload = runtime ? /^data:[^;,]+;base64,([\s\S]*)$/i.exec(runtime)?.[1]?.replace(/\s/g, '') : undefined
    const partPath = payload ? partByPayload.get(payload) : undefined
    if (!partPath) return source
    const replacement = presentationPptxSource(project.id, partPath)
    if (replacement !== source) replacements.set(source, replacement)
    return replacement
  }
  const assets = project.assets.map((asset) => {
    const materializedAsset = materializedById.get(asset.id)
    const source = rebase(asset.source, materializedAsset?.source)
    const removal = asset.imageEffects?.backgroundRemoval
    const layerSource = removal ? rebase(removal.layerSource, materializedAsset?.imageEffects?.backgroundRemoval?.layerSource) : undefined
    if (source === asset.source && (!removal || layerSource === removal.layerSource)) return asset
    return {
      ...asset,
      source,
      ...(removal && layerSource ? { imageEffects: { ...asset.imageEffects, backgroundRemoval: { ...removal, layerSource } } } : {}),
    }
  })
  return { project: replacements.size ? { ...project, assets } : project, replacements }
}

export function presentationSourceUrlForPath(path: string): string | undefined {
  const token = typeof window === 'undefined' ? undefined : window.__localResourceToken__
  const fileUrl = absolutePathToFileUrl(path)
  return token && fileUrl ? createLocalResourceUrl(fileUrl, token) : undefined
}

export function resolvedPresentationSource(asset: PresentationAsset | undefined, sources: Readonly<Record<string, string>>): PresentationFileSource | undefined {
  if (!asset) return undefined
  if (!asset.source.startsWith('bridgic-') && !asset.source.startsWith('data:')) {
    return { assetId: asset.id, dataUrl: asset.source, fileName: asset.name, mimeType: asset.mimeType, path: asset.source }
  }
  const dataUrl = derivedPresentationSource(asset.source) ?? (asset.source.startsWith('bridgic-') ? sources[asset.source] : asset.source)
  return dataUrl ? { assetId: asset.id, dataUrl, fileName: asset.name, mimeType: asset.mimeType } : undefined
}

/** Runtime-only project clone for exporters that require embedded data URLs. */
export function resolvePresentationProjectSources(project: PresentationProject, sources: Readonly<Record<string, string>>): PresentationProject {
  return {
    ...project,
    assets: project.assets.map((asset) => {
      const resolve = (source: string) => derivedPresentationSource(source) ?? (source.startsWith('bridgic-') ? sources[source] ?? source : source)
      const removal = asset.imageEffects?.backgroundRemoval
      return {
        ...asset,
        source: resolve(asset.source),
        ...(removal ? { imageEffects: { ...asset.imageEffects, backgroundRemoval: { ...removal, layerSource: resolve(removal.layerSource) } } } : {}),
      }
    }),
  }
}

/** Resolve durable sources only for an explicit export/read boundary. */
export async function materializePresentationProjectSources(project: PresentationProject, sources: Readonly<Record<string, string>>): Promise<PresentationProject> {
  const cache = new Map<string, Promise<string>>()
  const dataUrl = (source: string, name: string, mimeType: string) => {
    if (source.startsWith('data:')) return Promise.resolve(source)
    const derived = derivedPresentationSource(source)
    if (derived) return Promise.resolve(derived)
    const url = source.startsWith('bridgic-') ? sources[source] : source
    if (!url) return Promise.reject(new Error(`PowerPoint source is unavailable: ${name}`))
    let pending = cache.get(url)
    if (!pending) {
      pending = fetch(url).then(async (response) => {
        if (!response.ok) throw new Error(`PowerPoint source is unavailable: ${name}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)))
        }
        return `data:${mimeType};base64,${btoa(binary)}`
      })
      cache.set(url, pending)
    }
    return pending
  }
  return {
    ...project,
    assets: await Promise.all(project.assets.map(async (asset) => {
      const removal = asset.imageEffects?.backgroundRemoval
      return {
        ...asset,
        source: await dataUrl(asset.source, asset.name, asset.mimeType),
        ...(removal ? { imageEffects: { ...asset.imageEffects, backgroundRemoval: {
          ...removal,
          layerSource: await dataUrl(removal.layerSource, `${asset.name} effect layer`, 'image/vnd.ms-photo'),
        } } } : {}),
      }
    })),
  }
}
