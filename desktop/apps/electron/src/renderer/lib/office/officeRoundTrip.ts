import JSZip from 'jszip'

const MODEL_PATH = 'bridgic/editor-model.json'
const MODEL_RELATION = 'https://bridgic.ai/relationships/editor-model'
const MODEL_CONTENT_TYPE = 'application/vnd.bridgic.editor-model+json'

/** Fingerprint the actual Office parts, so external edits invalidate our editor snapshot. */
async function fingerprint(archive: JSZip): Promise<string> {
  const parts: Array<[string, string]> = []
  for (const name of Object.keys(archive.files).sort()) {
    const file = archive.files[name]!
    if (file.dir || name === MODEL_PATH) continue
    const bytes = await file.async('uint8array')
    const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
    parts.push([name, Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')])
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Standard OOXML remains readable by Office; this part preserves editor-only settings. */
export async function writeOfficeRoundTrip(archive: JSZip, kind: 'word' | 'presentation', document: unknown): Promise<Uint8Array> {
  const types = await archive.file('[Content_Types].xml')!.async('string')
  archive.file('[Content_Types].xml', types.replace('</Types>', `<Override PartName="/${MODEL_PATH}" ContentType="${MODEL_CONTENT_TYPE}"/></Types>`))
  const relations = await archive.file('_rels/.rels')!.async('string')
  archive.file('_rels/.rels', relations.replace('</Relationships>', `<Relationship Id="bridgicEditorModel" Type="${MODEL_RELATION}" Target="${MODEL_PATH}"/></Relationships>`))
  archive.file(MODEL_PATH, JSON.stringify({ version: 1, kind, fingerprint: await fingerprint(archive), document }))
  return archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

/** Never restore an old snapshot over changes made by another Office application. */
export async function readOfficeRoundTrip(archive: JSZip, kind: 'word' | 'presentation'): Promise<unknown | null> {
  const file = archive.file(MODEL_PATH)
  if (!file) return null
  try {
    const value = JSON.parse(await file.async('string'))
    if (value?.version !== 1 || value.kind !== kind || typeof value.fingerprint !== 'string') return null
    return value.fingerprint === await fingerprint(archive) ? value.document : null
  } catch {
    return null
  }
}
