/** Local image/media preview for paths appearing in Agent Markdown output. */
import { type ReactNode, useState } from 'react'
import { useSetAtom } from 'jotai'
import { openImageAtom } from '@/atoms/lightbox'
import { FileLink } from './FileLink'
import {
  parseLocalResourceReference,
  toLocalResourceDisplayUrl,
  type LocalResourceReference,
} from './localResource'

export interface LocalResourcePreviewProps {
  reference: LocalResourceReference
  /** Visible link/alt text. Falls back to the basename. */
  children?: ReactNode
}

/**
 * Render safe element types through the internal protocol. A load/codec failure swaps the element
 * for FileLink, so an unsupported HEIC/video codec or a moved file is still useful to the user.
 */
export function LocalResourcePreview({ reference, children }: LocalResourcePreviewProps) {
  const openImage = useSetAtom(openImageAtom)
  const src = toLocalResourceDisplayUrl(reference.fileUrl)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const fallback = children ?? reference.target.name

  if (reference.kind === 'file' || failedSrc === src) {
    return <FileLink target={reference.target}>{fallback}</FileLink>
  }

  if (reference.kind === 'image') {
    const alt = typeof children === 'string' ? children : reference.target.name
    return (
      <img
        src={src}
        alt={alt}
        data-local-resource="image"
        onError={() => setFailedSrc(src)}
        onClick={(event) => {
          event.stopPropagation()
          openImage({ src, local: src.startsWith('bridgic-local:') })
        }}
        className="max-h-80 w-auto max-w-full cursor-zoom-in rounded"
      />
    )
  }

  if (reference.kind === 'video') {
    return (
      <video
        src={src}
        data-local-resource="video"
        controls
        preload="metadata"
        onError={() => setFailedSrc(src)}
        className="max-h-80 w-auto max-w-full rounded"
      >
        {fallback}
      </video>
    )
  }

  return (
    <audio
      src={src}
      data-local-resource="audio"
      controls
      preload="metadata"
      onError={() => setFailedSrc(src)}
      className="max-w-full"
    >
      {fallback}
    </audio>
  )
}

/** Parse and render a local Markdown source, or return null for ordinary URLs. */
export function LocalMarkdownResource({ source, children }: { source: string; children?: ReactNode }) {
  const reference = parseLocalResourceReference(source)
  if (!reference) return null
  return <LocalResourcePreview reference={reference}>{children}</LocalResourcePreview>
}
