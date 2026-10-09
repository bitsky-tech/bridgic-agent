import { ImageSourceType, type IDocumentData } from '@univerjs/core'
import { prepareOfficeImage } from './office/officeImage'
import { i18n } from './i18n'

/** Run before committing a command, so an unavailable image cannot block later saves. */
export async function prepareWordHtmlImages(html: string, onImportWarning?: (message: string) => void): Promise<string> {
  if (!/<img\b/i.test(html)) return html
  const template = document.createElement('template')
  template.innerHTML = html
  const sources = new Map<string, Promise<string>>()
  for (const image of template.content.querySelectorAll('img[src]')) {
    const source = image.getAttribute('src')!
    if (!sources.has(source)) sources.set(source, prepareOfficeImage(source, 'word').then((value) => value.dataUrl))
    try {
      image.setAttribute('src', await sources.get(source)!)
    } catch (error) {
      // Explicit image edits remain strict; imports can preserve the rest of the document.
      if (!onImportWarning) throw error
      onImportWarning(`An embedded image could not be previewed: ${error instanceof Error ? error.message : String(error)}`)
      const placeholder = document.createElement('span')
      const alt = image.getAttribute('alt')
      placeholder.textContent = alt
        ? i18n.t('word.imagePreviewUnavailableWithAlt', { alt })
        : i18n.t('word.imagePreviewUnavailable')
      image.replaceWith(placeholder)
    }
  }
  return template.innerHTML
}

/** Also normalize imported/recovered snapshots without mutating the live editor model. */
export async function prepareWordSnapshotImages(snapshot: IDocumentData): Promise<IDocumentData> {
  if (!snapshot.drawings) return snapshot
  const drawings = { ...snapshot.drawings }
  const sources = new Map<string, Promise<string>>()
  for (const [id, drawing] of Object.entries(drawings)) {
    if (!('source' in drawing) || typeof drawing.source !== 'string') continue
    const source = drawing.source
    if (!sources.has(source)) sources.set(source, prepareOfficeImage(source, 'word').then((value) => value.dataUrl))
    const embedded = { ...drawing, source: await sources.get(source)!, imageSourceType: ImageSourceType.BASE64 }
    drawings[id] = embedded
  }
  return { ...snapshot, drawings }
}
