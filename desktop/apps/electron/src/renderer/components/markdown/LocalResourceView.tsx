/** Local image/media preview plus the plain-text path renderer shared by user and Agent messages. */
import { Fragment, type ReactNode, useState } from 'react'
import { useSetAtom } from 'jotai'
import { openImageAtom } from '@/atoms/lightbox'
import { FileLink } from './FileLink'
import {
  parseLocalResourceReference,
  splitLocalPathText,
  toLocalResourceDisplayUrl,
  type LocalPathTextPart,
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

/** Render already-contextualized plain-text parts. */
export function LocalPathTextParts({ parts }: { parts: readonly LocalPathTextPart[] }) {
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === 'text') return <Fragment key={index}>{part.value}</Fragment>
        const preview = (
          <LocalResourcePreview reference={part.reference}>{part.value}</LocalResourcePreview>
        )
        return part.reference.kind === 'file'
          ? <Fragment key={index}>{preview}</Fragment>
          : <span key={index} className="my-2 block max-w-full">{preview}</span>
      })}
    </>
  )
}

/** Plain-text renderer used for user messages: preserve prose exactly, upgrade only whole path lines. */
export function LocalPathText({ text }: { text: string }) {
  return <LocalPathTextParts parts={splitLocalPathText(text)} />
}

/** Parse and render a local Markdown source, or return null for ordinary URLs. */
export function LocalMarkdownResource({ source, children }: { source: string; children?: ReactNode }) {
  const reference = parseLocalResourceReference(source)
  if (!reference) return null
  return <LocalResourcePreview reference={reference}>{children}</LocalResourcePreview>
}
