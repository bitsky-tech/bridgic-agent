/**
 * Image viewer state — an <img> in a markdown reply (and mermaid diagrams) is opened by
 * yet-another-react-lightbox on click.
 *
 * Holds the "currently open item" (null = closed): `src` (a URL or data URL) + an optional
 * `download` filename. Cross-component: MarkdownMessage's img / MermaidBlock's diagram do
 * the opening while the ImageLightbox host does the rendering, hence an atom (§1.12). Pure
 * UI in-memory state, not persisted.
 */
import { atom } from 'jotai'

export interface LightboxItem {
  /** Image src — a plain URL or a data URL (the PNG data URL of a rasterized mermaid diagram). */
  src: string
  /** The filename used when downloading (optional); mermaid diagrams pass `diagram.png`, plain images omit it and fall back to the default. */
  download?: string
  /** Internal local-resource URLs intentionally do not expose Fetch API support; hide Download for them. */
  local?: boolean
}

const _item = atom<LightboxItem | null>(null)

/** When src is a blob: URL (the temporary object URL of a rasterized mermaid diagram),
 *  revoke it to prevent a memory leak; plain http/data URLs are left alone. */
function revokeIfBlob(item: LightboxItem | null): void {
  if (item !== null && item.src.startsWith('blob:')) URL.revokeObjectURL(item.src)
}

/** Read — the current viewed item (null = closed). Subscribed by the ImageLightbox host. */
export const lightboxItemAtom = atom((get) => get(_item))

/** Write — open an image in the viewer. Pass a string (plain image, backward compatible) or {src, download} (with a download name). */
export const openImageAtom = atom(null, (get, set, arg: string | LightboxItem) => {
  revokeIfBlob(get(_item))
  set(_item, typeof arg === 'string' ? { src: arg } : arg)
})

/** Write — close the viewer. */
export const closeImageAtom = atom(null, (get, set) => {
  revokeIfBlob(get(_item))
  set(_item, null)
})
